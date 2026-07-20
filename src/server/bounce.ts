import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import { failureLabel, type BatteryContext } from "./gates.ts";
import type { Store } from "./store.ts";
import type {
  Artifact,
  FollowUpSeed,
  GateResult,
  Repo,
  ReviewBounceReason,
  ReviewStepMark,
  Run,
  TicketWithAcs,
  TreeState,
} from "./types.ts";
import { readTreeState } from "./worktrees.ts";

/** Worktree-relative; also what the {{bounceReportPath}} template var carries. */
export const BOUNCE_REPORT_PATH = "kb/bounce-report.md";

/**
 * The bounce machinery (ticket 30): a failed battery bounces the Ticket once
 * with the whole batch. The orchestrator renders the Bounce Report
 * deterministically from recorded gate results — structured data first,
 * never LLM-summarized — writes it into the persisting worktree, records it
 * as a Run artifact, and only then moves the Ticket. Failed gates become
 * follow-up ACs; failed AC checks need no duplicate row — the criterion
 * itself resets to pending on the next Run (ticket 05) and its diagnostics
 * travel in the report.
 */
export class Bouncer {
  constructor(
    private readonly store: Store,
    private readonly artifacts: ArtifactStore,
  ) {}

  async bounce(ctx: BatteryContext): Promise<void> {
    const failures = this.store
      .listGateResults(ctx.run.id)
      .filter((result) => result.status === "fail");
    const treeState = await readTreeState(ctx.worktreePath, ctx.repo.targetBranch);
    const followUps = failures
      .filter((result) => result.acId === null)
      .flatMap((result) => followUpSeeds(result));

    // Snapshot fresh: the claim-time ticket predates the battery's AC settling.
    const ticket = this.store.getTicket(ctx.ticket.id)!;
    const report = renderBounceReport({
      ticket,
      run: ctx.run,
      failures,
      followUps,
      treeState,
      targetBranch: ctx.repo.targetBranch,
      priorArtifacts: this.store.listArtifacts(ctx.run.id),
    });
    mkdirSync(path.join(ctx.worktreePath, "kb"), { recursive: true });
    writeFileSync(path.join(ctx.worktreePath, BOUNCE_REPORT_PATH), report);
    // Evidence lands before the state moves: a bounced ticket always has its
    // report on record, even if the transition below were to fail.
    await this.artifacts.persistFile(ctx.run.id, ctx.worktreePath, BOUNCE_REPORT_PATH, "bounce-report");

    this.store.bounceTicket(ctx.run.id, {
      failed: failures.map(failureLabel),
      followUps,
      treeState,
    });
  }

  /**
   * The review wizard's bounce (ticket 33): same machinery, human trigger.
   * The Bounce Report carries the reviewer's feedback verbatim — it is how
   * the notes reach the next Run alongside the follow-up AC rows — plus any
   * ACs the reviewer failed in the Manual Walkthrough (those reset to
   * pending on re-claim rather than duplicating). Report first, state move
   * second, exactly like the battery path.
   */
  async bounceFromReview(ctx: {
    ticket: TicketWithAcs;
    run: Run;
    repo: Repo;
    reason: ReviewBounceReason;
    steps: ReviewStepMark[];
    /** What the Final Verdict freshness subset found, for stale-evidence bounces. */
    driftReasons?: string[];
  }): Promise<{ ticket: TicketWithAcs; followUpAcIds: number[] }> {
    // Notes were validated non-empty upstream (Verdicts.fail); the fallback
    // keeps this total rather than trusting a `!` across the layer boundary.
    const failedSteps = ctx.steps
      .filter((mark) => mark.status === "fail")
      .map((mark) => ({ step: mark.step, note: (mark.note ?? "").trim() }));
    // Snapshot fresh: walkthrough verdicts may have settled ACs since load.
    const ticket = this.store.getTicket(ctx.ticket.id)!;
    const worktreePath = ctx.run.worktreePath;
    let treeState: TreeState | null = null;
    if (worktreePath !== null && existsSync(worktreePath)) {
      treeState = await readTreeState(worktreePath, ctx.repo.targetBranch);
      const report = renderReviewBounceReport({
        ticket,
        run: ctx.run,
        reason: ctx.reason,
        failedSteps,
        driftReasons: ctx.driftReasons ?? [],
        treeState,
        targetBranch: ctx.repo.targetBranch,
        priorArtifacts: this.store.listArtifacts(ctx.run.id),
      });
      mkdirSync(path.join(worktreePath, "kb"), { recursive: true });
      writeFileSync(path.join(worktreePath, BOUNCE_REPORT_PATH), report);
      await this.artifacts.persistFile(ctx.run.id, worktreePath, BOUNCE_REPORT_PATH, "bounce-report");
    } else {
      // A Human Review ticket always came through the battery, which needs a
      // worktree — a missing one is an anomaly worth a loud trace, not a
      // reason to strand the reviewer's verdict.
      console.error(`run ${ctx.run.id}: no worktree to write the bounce report into`);
    }
    return this.store.reviewBounceTicket(ctx.run.id, {
      reason: ctx.reason,
      steps: ctx.steps,
      followUps: failedSteps.map((failed) => failed.note),
      treeState,
      driftReasons: ctx.driftReasons,
    });
  }
}

/**
 * The follow-up criteria a failed gate contributes to the bounce batch. Most
 * gates yield one, phrased as the state the next Run must reach. dogfood-green
 * is the exception (ticket 37): each failing scenario row becomes its own
 * follow-up AC, so the next Run earns each journey back independently — the
 * whole batch still rides one bounce.
 */
function followUpSeeds(result: GateResult): FollowUpSeed[] {
  if (result.gate === "dogfood-green" && Array.isArray(result.detail.failing)) {
    const failing = result.detail.failing as Array<Record<string, unknown>>;
    if (failing.length > 0) {
      return failing.map((row) => ({
        gate: result.gate,
        text: `Dogfood scenario ${String(row.id)} reaches pass, fixed, or waived (was ${String(row.status)}): ${String(row.journey)}`,
      }));
    }
  }
  return [{ gate: result.gate, text: followUpText(result) }];
}

/**
 * A follow-up criterion's text, generated from the gate's detail (ticket 06
 * §5) — phrased as the state the next Run must reach, not as a complaint.
 */
function followUpText(result: GateResult): string {
  const reason = reasonFrom(result.detail);
  return `Evidence gate ${result.gate} passes${reason === "" ? "" : `: ${reason}`}`;
}

function reasonFrom(detail: Record<string, unknown>): string {
  if (typeof detail.reason === "string") return detail.reason;
  if (Array.isArray(detail.problems)) return detail.problems.join("; ");
  if (Array.isArray(detail.missing) && detail.missing.length > 0) {
    return `missing ${detail.missing.join(", ")}`;
  }
  if (typeof detail.exitCode === "number") return `exit ${detail.exitCode}`;
  if (typeof detail.error === "string") return detail.error;
  return "";
}

/** What each gate verifies, for the report's "the check" line (ticket 06). */
const GATE_CHECKS: Record<string, string> = {
  artifact: "every artifact the workflow's nodes owe exists in the worktree",
  "artifact-lint":
    "kb/recap.html is self-contained and ends with review notes; kb/dogfood-results.json conforms to the matrix schema",
  "dogfood-green": "every dogfood scenario reached pass, fixed, or waived",
  "branch-recorded": "the branch is recorded on the ticket and exists on the GitHub remote",
  suite: "the repo's test suite exits 0 in the worktree",
  "pr-fresh": "the PR head SHA matches the branch tip",
  "demo-fresh": "a fresh demo artifact exists for user-facing work",
};

/**
 * Deterministic render, no prose generation: per failed AC or gate — the
 * criterion, the check, an output excerpt (full result linked), evidence
 * pointers — plus reviewer feedback verbatim, prior-run pointers, and the
 * tree-state summary (CONTEXT.md, Bounce Report).
 */
function renderBounceReport(input: {
  ticket: TicketWithAcs;
  run: Run;
  failures: GateResult[];
  followUps: FollowUpSeed[];
  treeState: TreeState;
  targetBranch: string;
  priorArtifacts: Artifact[];
}): string {
  const { ticket, run, failures, followUps, treeState, targetBranch, priorArtifacts } = input;
  const gateFailures = failures.filter((failure) => failure.acId === null);
  const acFailures = failures.filter((failure) => failure.acId !== null);
  const lines: string[] = [
    ...reportHeader(ticket, run),
    ...treeStateLines(treeState, targetBranch),
    "## Failed acceptance criteria",
    "",
  ];
  if (acFailures.length === 0) lines.push("None.", "");
  for (const failure of acFailures) {
    const criterion = ticket.acceptanceCriteria.find((ac) => ac.id === failure.acId);
    lines.push(
      `### AC-${failure.acId}: ${criterion?.text ?? "(criterion no longer on the ticket)"}`,
      "",
      `- Check: ${typeof failure.detail.scriptPath === "string" ? failure.detail.scriptPath : "see detail"}`,
      ...detailLines(failure.detail),
      `- Evidence: gate result #${failure.id} on run ${run.id}`,
      "",
    );
  }
  lines.push("## Failed gates", "");
  if (gateFailures.length === 0) lines.push("None.", "");
  for (const failure of gateFailures) {
    lines.push(
      `### ${failure.gate}`,
      "",
      `- Check: ${GATE_CHECKS[failure.gate] ?? "see gate detail"}`,
      ...detailLines(failure.detail),
      `- Evidence: gate result #${failure.id} on run ${run.id}`,
      "",
    );
  }
  lines.push(
    "## Reviewer feedback",
    "",
    "None — this bounce came from the Evidence Gate battery, not a human review.",
    "",
    "## Follow-up criteria added by this bounce",
    "",
  );
  if (followUps.length === 0) lines.push("None — the failed criteria above reset to pending instead.", "");
  for (const followUp of followUps) lines.push(`- [${followUp.gate}] ${followUp.text}`);
  if (followUps.length > 0) lines.push("");
  lines.push(...priorRunLines(ticket, run, priorArtifacts));
  return lines.join("\n");
}

/**
 * The review bounce's render (ticket 33), as deterministic as the battery's:
 * the reviewer's notes land verbatim, never summarized, and the failed ACs
 * section reads from the rows the walkthrough settled.
 */
function renderReviewBounceReport(input: {
  ticket: TicketWithAcs;
  run: Run;
  reason: ReviewBounceReason;
  failedSteps: Array<{ step: string; note: string }>;
  driftReasons: string[];
  treeState: TreeState;
  targetBranch: string;
  priorArtifacts: Artifact[];
}): string {
  const { ticket, run, reason, failedSteps, driftReasons, treeState, targetBranch, priorArtifacts } = input;
  const failedAcs = ticket.acceptanceCriteria.filter((criterion) => criterion.status === "failed");
  const lines: string[] = [
    ...reportHeader(ticket, run),
    ...treeStateLines(treeState, targetBranch),
    "## Failed acceptance criteria",
    "",
  ];
  if (failedAcs.length === 0) lines.push("None.", "");
  for (const criterion of failedAcs) {
    lines.push(
      `### AC-${criterion.id}: ${criterion.text}`,
      "",
      criterion.provenance === "human"
        ? "- Failed by the reviewer in the Manual Walkthrough; resets to pending on the next run."
        : "- Failed by the prior gate battery; resets to pending on the next run.",
      "",
    );
  }
  lines.push(
    "## Failed gates",
    "",
    "None — this bounce came from the review wizard, not the Evidence Gate battery.",
    "",
    "## Reviewer feedback",
    "",
  );
  if (reason === "stale-evidence") {
    lines.push("Re-verify requested at Final Verdict — the evidence drifted:", "");
    lines.push(
      ...(driftReasons.length === 0
        ? ["- (no drift detail recorded)"]
        : driftReasons.map((drift) => `- ${drift}`)),
      "",
    );
  }
  if (failedSteps.length === 0 && reason === "review-fail") lines.push("None recorded.", "");
  for (const failed of failedSteps) {
    lines.push(`### Step: ${failed.step}`, "", failed.note, "");
  }
  lines.push("## Follow-up criteria added by this bounce", "");
  if (failedSteps.length === 0) lines.push("None.", "");
  for (const failed of failedSteps) lines.push(`- [review-fail] ${failed.note}`);
  if (failedSteps.length > 0) lines.push("");
  lines.push(...priorRunLines(ticket, run, priorArtifacts));
  return lines.join("\n");
}

function reportHeader(ticket: TicketWithAcs, run: Run): string[] {
  return [`# Bounce Report — ${ticket.displayKey}, run ${run.id} (bounce ${ticket.bounceCount + 1})`, ""];
}

function treeStateLines(treeState: TreeState, targetBranch: string): string[] {
  return [
    "## Tree state (inherited as-is by the next run)",
    "",
    `- Branch: ${treeState.branch}`,
    `- Ahead of origin/${targetBranch} by: ${treeState.aheadBy} commit(s)`,
    `- Dirty files: ${treeState.dirtyCount}`,
    "",
  ];
}

function priorRunLines(ticket: TicketWithAcs, run: Run, priorArtifacts: Artifact[]): string[] {
  return [
    "## Prior run",
    "",
    `- Run ${run.id} on branch ${ticket.branch ?? "(none recorded)"}`,
    `- Full gate results: GET /api/tickets/${ticket.id}/runs`,
    "- Persisted artifacts:",
    ...(priorArtifacts.length === 0
      ? ["  - none"]
      : priorArtifacts.map((artifact) => `  - ${artifact.name} → ${artifact.path}`)),
    "",
  ];
}

/** Known detail keys rendered plainly; command output as a fenced excerpt. */
function detailLines(detail: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === "output" || key === "scriptPath") continue;
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join("; ") : String(value)}`);
  }
  if (typeof detail.output === "string" && detail.output !== "") {
    lines.push("- Output excerpt (full result on the gate row):", "", "```", detail.output, "```");
  }
  return lines;
}
