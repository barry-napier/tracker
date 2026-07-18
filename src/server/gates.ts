import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitHubPort } from "./github.ts";
import type { Store } from "./store.ts";
import type { AcceptanceCriterion, GateStatus, Repo, Run, TicketWithAcs } from "./types.ts";
import { git } from "./worktrees.ts";

const execFileAsync = promisify(execFile);

/** Generous — a suite that needs longer should be split, not waited on. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Full logs live elsewhere; gate detail carries a readable excerpt. */
const OUTPUT_EXCERPT_CHARS = 2000;

/** Branch prefixes whose tickets aren't user-facing → no demo expected. */
const NON_USER_FACING_TYPES = new Set(["chore", "refactor", "docs", "test", "ci", "build"]);

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
      ["branch-recorded", () => this.#branchRecorded(ticket, ctx.repo)],
      ["suite", () => this.#suite(ctx)],
      ["pr-fresh", () => this.#prFresh(ticket, ctx)],
      ["demo-fresh", () => this.#demoFresh(ticket, ctx.repo)],
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
      .map((outcome) => (outcome.acId === undefined ? outcome.gate : `ac-check:AC-${outcome.acId}`));
    const passed = failed.length === 0;
    this.store.concludeVerification(ctx.run.id, { passed, failed });
    return { passed, failed };
  }

  /** Every artifact the workflow's nodes owe (gate requirements) exists. */
  #artifact(ctx: BatteryContext): GateOutcome {
    const required = this.store
      .getDefaultWorkflow()
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

  /** The recap obeys its hard rules; everything else is the reviewer's call. */
  #artifactLint(ctx: BatteryContext): GateOutcome {
    const recap = path.join(ctx.worktreePath, "kb", "recap.html");
    const problems = existsSync(recap)
      ? lintRecap(readFileSync(recap, "utf8"))
      : ["kb/recap.html missing — nothing to lint"];
    return {
      gate: "artifact-lint",
      status: problems.length === 0 ? "pass" : "fail",
      detail: { problems },
    };
  }

  /** Branch on the ticket row AND on the GitHub remote (ticket 06 mechanics). */
  async #branchRecorded(ticket: TicketWithAcs, repo: Repo): Promise<GateOutcome> {
    const recordedOnTicket = ticket.branch !== null;
    const onRemote = recordedOnTicket
      ? await this.github.branchExists(repo.githubRemote, ticket.branch!)
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

  /** PR head SHA == branch tip: the PR shows exactly what the run produced. */
  async #prFresh(ticket: TicketWithAcs, ctx: BatteryContext): Promise<GateOutcome> {
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
    const branchTip = await git(ctx.worktreePath, "rev-parse", "HEAD");
    return {
      gate: "pr-fresh",
      status: pr.headSha === branchTip ? "pass" : "fail",
      detail: { prNumber: pr.number, prHeadSha: pr.headSha, branchTip },
    };
  }

  /**
   * Fact-driven skips only: the ticket type (branch prefix) says no demo is
   * owed, or the repo offers no preview to demo against. When a demo IS owed
   * there is no recorder yet (slice 35), and that's a fail — a skip here
   * would masquerade as "not applicable".
   */
  #demoFresh(ticket: TicketWithAcs, repo: Repo): GateOutcome {
    const type = ticket.branch?.split("/")[0] ?? "";
    if (NON_USER_FACING_TYPES.has(type)) {
      return {
        gate: "demo-fresh",
        status: "skip",
        detail: { reason: `ticket type "${type}" is not user-facing` },
      };
    }
    if (repo.previewCommand === null) {
      return {
        gate: "demo-fresh",
        status: "skip",
        detail: { reason: "no preview configured — no demo expected" },
      };
    }
    return { gate: "demo-fresh", status: "fail", detail: { reason: "no demo artifact recorded" } };
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
