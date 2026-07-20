import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DEMO_ARTIFACT_KIND, demoExpectation, type DemoOutcome } from "./demos.ts";
import {
  DOGFOOD_GREEN_STATUSES,
  DOGFOOD_RESULTS_PATH,
  evaluateDogfoodGreen,
  lintDogfoodResults,
} from "./dogfood.ts";
import type { GitHubPort } from "./github.ts";
import type { Store } from "./store.ts";
import type { AcceptanceCriterion, Artifact, GateStatus, Repo, Run, TicketWithAcs } from "./types.ts";
import { git } from "./worktrees.ts";

const execFileAsync = promisify(execFile);

/** Generous — a suite that needs longer should be split, not waited on. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Full logs live elsewhere; gate detail carries a readable excerpt. */
const OUTPUT_EXCERPT_CHARS = 2000;

type GateOutcome = {
  gate: string;
  status: GateStatus;
  detail: Record<string, unknown>;
  acId?: number;
};

export interface BatteryContext {
  run: Run;
  ticket: TicketWithAcs;
  repo: Repo;
  worktreePath: string;
  /** How the demo phase ended (ticket 35) — enriches demo-fresh's detail. */
  demo?: DemoOutcome;
}

/**
 * The orchestrator-executed Evidence Gate battery (ticket 06, ADR-0003): runs
 * at Verifying, outside the workflow graph. Diagnostic, not a tripwire —
 * every gate and AC check executes even after a failure, each landing as a
 * gate-result row the moment it settles. Skips are fact-driven (ticket type,
 * repo config), never agent-declared. All green → Human Review; any failure
 * stays recorded on the Run for the bounce machinery of slice 30.
 */
export class GateBattery {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubPort,
  ) {}

  async run(ctx: BatteryContext): Promise<{ passed: boolean; failed: string[] }> {
    // Statuses are read once, here: a waive landing mid-battery takes effect
    // next cycle — gate evaluation is a pure function of this snapshot.
    const ticket = this.store.getTicket(ctx.ticket.id)!;

    const gates: Array<[string, () => Promise<GateOutcome> | GateOutcome]> = [
      ["artifact", () => this.#artifact(ctx)],
      ["artifact-lint", () => this.#artifactLint(ctx)],
      ["dogfood-green", () => this.#dogfoodGreen(ctx)],
      ["branch-recorded", () => this.#branchRecorded(ticket, ctx)],
      ["suite", () => this.#suite(ctx)],
      ["pr-fresh", () => this.#prFresh(ticket, ctx)],
      ["demo-fresh", () => this.#demoFresh(ticket, ctx)],
    ];

    const outcomes: GateOutcome[] = [];
    const record = (outcome: GateOutcome): void => {
      outcomes.push(outcome);
      this.store.recordGateResult(ctx.run.id, outcome);
    };
    for (const [gate, evaluate] of gates) {
      try {
        record(await evaluate());
      } catch (error) {
        // A gate blowing up (git hiccup, fs race) is a failed gate, not a
        // skipped one — the battery keeps running; nothing goes unrecorded.
        record({ gate, status: "fail", detail: { error: messageOf(error) } });
      }
    }
    for (const criterion of ticket.acceptanceCriteria) {
      try {
        record(await this.#acCheck(criterion, ctx));
      } catch (error) {
        record({
          gate: "ac-check",
          status: "fail",
          acId: criterion.id,
          detail: { error: messageOf(error) },
        });
      }
    }

    const failed = outcomes
      .filter((outcome) => outcome.status === "fail")
      .map(failureLabel);
    const passed = failed.length === 0;
    this.store.concludeVerification(ctx.run.id, { passed, failed });
    return { passed, failed };
  }

  /** Every artifact the workflow's nodes owe (gate requirements) exists. */
  #artifact(ctx: BatteryContext): GateOutcome {
    const required = this.store
      .getWorkflowGraph(ctx.run.workflowVersionId)
      .nodes.flatMap((node) => node.gateRequirements);
    const missing = required.filter(
      (artifact) => !existsSync(path.join(ctx.worktreePath, artifact)),
    );
    return {
      gate: "artifact",
      status: missing.length === 0 ? "pass" : "fail",
      detail: { required, missing },
    };
  }

  /**
   * The recap obeys its hard rules and, when the workflow owes it, the dogfood
   * results file conforms to the vendored matrix schema (ticket 37). The report
   * itself stays existence-only — the artifact gate covers that; its structure
   * is prompt-enforced, not re-parsed. Everything softer is the reviewer's call.
   */
  #artifactLint(ctx: BatteryContext): GateOutcome {
    const problems: string[] = [];
    const recap = path.join(ctx.worktreePath, "kb", "recap.html");
    problems.push(
      ...(existsSync(recap)
        ? lintRecap(readFileSync(recap, "utf8"))
        : ["kb/recap.html missing — nothing to lint"]),
    );
    if (this.#owesDogfood(ctx)) {
      const results = path.join(ctx.worktreePath, DOGFOOD_RESULTS_PATH);
      problems.push(
        ...(existsSync(results)
          ? lintDogfoodResults(readFileSync(results, "utf8"))
          : ["kb/dogfood-results.json missing — nothing to lint"]),
      );
    }
    return {
      gate: "artifact-lint",
      status: problems.length === 0 ? "pass" : "fail",
      detail: { problems },
    };
  }

  /**
   * The dogfood teeth (ticket 37): every scenario must have reached pass, fixed,
   * or waived. Any un-green row fails the gate and rides into the bounce as one
   * follow-up AC (bounce.ts). Skip is fact-driven — a workflow without a dogfood
   * phase owes no results — never agent-declared. Open "Decisions for a human"
   * are deliberately not read here: they never gate, they surface at the wizard.
   */
  #dogfoodGreen(ctx: BatteryContext): GateOutcome {
    if (!this.#owesDogfood(ctx)) {
      return {
        gate: "dogfood-green",
        status: "skip",
        detail: { reason: "workflow has no dogfood phase" },
      };
    }
    const file = path.join(ctx.worktreePath, DOGFOOD_RESULTS_PATH);
    if (!existsSync(file)) {
      return {
        gate: "dogfood-green",
        status: "fail",
        detail: { reason: "kb/dogfood-results.json missing" },
      };
    }
    const evaluation = evaluateDogfoodGreen(readFileSync(file, "utf8"));
    if (evaluation.error !== undefined) {
      return { gate: "dogfood-green", status: "fail", detail: { reason: evaluation.error } };
    }
    return {
      gate: "dogfood-green",
      status: evaluation.ok ? "pass" : "fail",
      detail: {
        total: evaluation.total,
        greenStatuses: [...DOGFOOD_GREEN_STATUSES],
        failing: evaluation.failing,
      },
    };
  }

  /** Does the pinned workflow's graph owe the dogfood results file? Facts only. */
  #owesDogfood(ctx: BatteryContext): boolean {
    return this.store
      .getWorkflowGraph(ctx.run.workflowVersionId)
      .nodes.flatMap((node) => node.gateRequirements)
      .includes(DOGFOOD_RESULTS_PATH);
  }

  /**
   * Branch on the ticket row AND where the merge will read it from (ticket 06
   * mechanics): the GitHub remote, or — local-only Repo — the shared refs the
   * worktree sees (the bare clone's, where the Done merge fetches from).
   */
  async #branchRecorded(ticket: TicketWithAcs, ctx: BatteryContext): Promise<GateOutcome> {
    const recordedOnTicket = ticket.branch !== null;
    const onRemote = recordedOnTicket
      ? ctx.repo.githubRemote === null
        ? (await git(ctx.worktreePath, "for-each-ref", `refs/heads/${ticket.branch}`)) !== ""
        : await this.github.branchExists(ctx.repo.githubRemote, ticket.branch!)
      : false;
    return {
      gate: "branch-recorded",
      status: recordedOnTicket && onRemote ? "pass" : "fail",
      detail: { branch: ticket.branch, recordedOnTicket, onRemote },
    };
  }

  async #suite(ctx: BatteryContext): Promise<GateOutcome> {
    const command = ctx.repo.testCommand;
    if (command === null) {
      return { gate: "suite", status: "skip", detail: { reason: "no test command configured" } };
    }
    const { exitCode, output } = await runCommand("/bin/sh", ["-c", command], ctx.worktreePath);
    return {
      gate: "suite",
      status: exitCode === 0 ? "pass" : "fail",
      detail: { command, exitCode, output },
    };
  }

  /** PR head SHA == branch tip: the PR shows exactly what the run produced.
   * Local-only Repos have no PRs anywhere — a fact-driven skip, never a fail. */
  async #prFresh(ticket: TicketWithAcs, ctx: BatteryContext): Promise<GateOutcome> {
    if (ctx.repo.githubRemote === null) {
      return { gate: "pr-fresh", status: "skip", detail: { reason: "local-only project" } };
    }
    if (ticket.branch === null) {
      return { gate: "pr-fresh", status: "fail", detail: { reason: "no branch recorded" } };
    }
    const pr = await this.github.findPr(ctx.repo.githubRemote, ticket.branch);
    if (pr === null) {
      return {
        gate: "pr-fresh",
        status: "fail",
        detail: { branch: ticket.branch, reason: "no PR recorded for branch" },
      };
    }
    // The orchestrator just observed the branch's PR on the remote — record
    // it on the Ticket (ticket 31: the PR belongs to the Ticket, stable
    // across bounces). Idempotent: only a change writes anything.
    this.store.recordPr(ticket.id, { number: pr.number, url: pr.url });
    const branchTip = await git(ctx.worktreePath, "rev-parse", "HEAD");
    return {
      gate: "pr-fresh",
      status: pr.headSha === branchTip ? "pass" : "fail",
      detail: { prNumber: pr.number, prHeadSha: pr.headSha, branchTip },
    };
  }

  /**
   * The demo is fresh when it was recorded at the branch tip — like pr-fresh,
   * a SHA comparison: the reviewer must watch the code under review, not an
   * earlier cycle's. Skips are fact-driven only (ticket type, repo config,
   * via demoExpectation — the recorder consults the same facts). No artifact
   * is a fail carrying the recorder's own reason (preview boot failure, red
   * demo spec) — never a silent skip.
   */
  async #demoFresh(ticket: TicketWithAcs, ctx: BatteryContext): Promise<GateOutcome> {
    const expectation = demoExpectation(ticket, ctx.repo);
    if (!expectation.owed) {
      return { gate: "demo-fresh", status: "skip", detail: { reason: expectation.reason } };
    }
    const demo = this.#latestDemoArtifact(ticket.id);
    if (demo === undefined) {
      return {
        gate: "demo-fresh",
        status: "fail",
        detail: {
          reason: ctx.demo?.status === "failed" ? ctx.demo.reason : "no demo artifact recorded",
        },
      };
    }
    const branchTip = await git(ctx.worktreePath, "rev-parse", "HEAD");
    if (demo.worktreeHeadSha === branchTip) {
      return {
        gate: "demo-fresh",
        status: "pass",
        detail: { artifactId: demo.id, name: demo.name, recordedAtSha: demo.worktreeHeadSha },
      };
    }
    const thisRun =
      ctx.demo?.status === "failed" ? `; this run recorded none: ${ctx.demo.reason}` : "";
    return {
      gate: "demo-fresh",
      status: "fail",
      detail: {
        artifactId: demo.id,
        recordedAtSha: demo.worktreeHeadSha,
        branchTip,
        reason: `demo artifact predates the branch tip${thisRun}`,
      },
    };
  }

  /** The ticket's newest demo evidence, whichever Run recorded it — a stale
   * survivor from an earlier cycle must be judged, not overlooked. */
  #latestDemoArtifact(ticketId: number): Artifact | undefined {
    for (const run of this.store.listRuns(ticketId)) {
      const demos = this.store
        .listArtifacts(run.id)
        .filter((artifact) => artifact.kind === DEMO_ARTIFACT_KIND);
      if (demos.length > 0) return demos.at(-1);
    }
    return undefined;
  }

  /**
   * The trust boundary (ticket 06 §3): the agent authored the script, the
   * orchestrator executes it. Exit 0 verifies the AC with machine provenance,
   * anything else fails it — a result can never be self-reported.
   */
  async #acCheck(criterion: AcceptanceCriterion, ctx: BatteryContext): Promise<GateOutcome> {
    const acId = criterion.id;
    if (criterion.status === "waived") {
      return { gate: "ac-check", status: "skip", acId, detail: { reason: "waived" } };
    }
    if (criterion.status !== "pending") {
      return {
        gate: "ac-check",
        status: "skip",
        acId,
        detail: { reason: `already ${criterion.status}` },
      };
    }
    if (criterion.check === null) {
      return {
        gate: "ac-check",
        status: "fail",
        acId,
        detail: { reason: "no check registered for a pending AC" },
      };
    }
    if (criterion.check.kind === "human") {
      return {
        gate: "ac-check",
        status: "skip",
        acId,
        detail: { reason: `routed to human: ${criterion.check.reason}` },
      };
    }
    const scriptPath = criterion.check.scriptPath!;
    const resolved = path.join(ctx.worktreePath, scriptPath);
    if (!existsSync(resolved)) {
      return {
        gate: "ac-check",
        status: "fail",
        acId,
        detail: { scriptPath, reason: "check script missing from worktree" },
      };
    }
    const { exitCode, output } = await runCommand(resolved, [], ctx.worktreePath);
    return {
      gate: "ac-check",
      status: exitCode === 0 ? "pass" : "fail",
      acId,
      detail: { scriptPath, exitCode, output },
    };
  }
}

/**
 * The battery's canonical failure label — a gate's name, or the criterion an
 * AC check verifies. The gates.failed audit event and the bounce event's
 * batch use the same vocabulary.
 */
export function failureLabel(result: { gate: string; acId?: number | null }): string {
  return result.acId === undefined || result.acId === null
    ? result.gate
    : `ac-check:AC-${result.acId}`;
}

/**
 * The prototype's lintRecap, ported in spirit (ticket 11 §5): hard-fail only
 * on external resource references and a missing "What to review" section.
 * Everything softer stays the reviewer's judgment — every false failure here
 * is a wasted bounce cycle.
 */
export function lintRecap(html: string): string[] {
  const problems: string[] = [];
  const external = [
    /<(?:script|img|iframe|video|audio|source|embed|object)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i,
    /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i,
    /url\(\s*["']?\s*(?:https?:)?\/\//i,
    /@import\b/i,
  ];
  if (external.some((pattern) => pattern.test(html))) {
    problems.push("recap references external resources — it must be fully self-contained");
  }
  if (!/what to review/i.test(html)) {
    problems.push('recap has no "What to review" section');
  }
  return problems;
}

async function runCommand(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, output: excerpt(`${stdout}${stderr}`) };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    const captured = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    return {
      // A timeout or spawn failure has no exit code; -1 marks "never exited".
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      output: excerpt(captured === "" ? messageOf(error) : captured),
    };
  }
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_EXCERPT_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_EXCERPT_CHARS)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
