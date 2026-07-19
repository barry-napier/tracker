import type { Bouncer } from "./bounce.ts";
import type { GitHubPort } from "./github.ts";
import { freshness } from "./reviews.ts";
import { NotFoundError, StateError, ValidationError, type Store } from "./store.ts";
import {
  REVIEW_STEP_KEYS,
  type Repo,
  type ReviewStepKey,
  type ReviewStepMark,
  type Run,
  type TicketWithAcs,
} from "./types.ts";

/**
 * Drift at the Final Verdict (ticket 33): the freshness subset found the
 * remote ahead of the reviewed evidence. Carried as structured reasons so
 * the wizard can offer the two honest ways out — re-verify (bounce) or
 * force-merge (waive-equivalent, audited) — instead of parsing prose.
 */
export class DriftError extends StateError {
  constructor(readonly reasons: string[]) {
    super(`evidence drifted under the review: ${reasons.join("; ")}`);
  }
}

/**
 * The verdict actions at the API seam — the wizard is the veto point
 * (ticket 33). Pass re-runs the cheap freshness subset (branch-recorded,
 * pr-fresh, mergeability) and merges through the GitHubPort; fail bounces
 * through the slice-30 machinery with the reviewer's notes; reverify is the
 * drift choice that buys a fresh battery run. Every guard runs before the
 * port is touched — a merge is the one side effect here that can't roll back.
 */
export class Verdicts {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubPort,
    private readonly bouncer: Bouncer,
  ) {}

  async pass(ticketId: number, opts: { force?: boolean } = {}) {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    if (ticket.state !== "human_review") {
      throw new StateError(`ticket ${ticket.displayKey} is ${ticket.state}, not human_review`);
    }
    // Done requires every criterion settled: verified or explicitly waived
    // (CONTEXT.md — the loop is proven when nothing is left implicit).
    const unmet = ticket.acceptanceCriteria.filter(
      (ac) => ac.status !== "verified" && ac.status !== "waived",
    );
    if (unmet.length > 0) {
      throw new StateError(
        `cannot merge: unsettled acceptance criteria ${unmet.map((ac) => `AC-${ac.id} (${ac.status})`).join(", ")}`,
      );
    }
    if (ticket.prNumber === null) {
      throw new StateError(`ticket ${ticket.displayKey} has no PR recorded`);
    }
    const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);
    if (!repo) throw new StateError(`ticket ${ticket.displayKey} has no repo`);
    // Conflicts block; "unknown" (GitHub still computing) falls through and
    // lets the merge itself be the arbiter rather than stalling the verdict.
    // Not forceable: force waives freshness, never a merge GitHub refuses.
    const mergeability = await this.github.mergeability(repo.githubRemote, ticket.prNumber);
    if (mergeability === "conflicting") {
      throw new StateError(`PR #${ticket.prNumber} has conflicts with ${repo.targetBranch}`);
    }
    const drift = await this.driftReasons(ticket, repo);
    if (drift.length > 0 && opts.force !== true) throw new DriftError(drift);
    await this.github.mergePr(repo.githubRemote, ticket.prNumber);
    return this.store.mergeTicket(ticket.id, {
      freshnessWaived: drift.length > 0 ? drift : undefined,
    });
  }

  /**
   * The failed review: every failed step needs the reviewer's written note —
   * fail without one is impossible, here and not merely in the UI — and the
   * notes bounce the Ticket through the slice-30 machinery verbatim. A
   * walkthrough that failed ACs is grounds enough on its own: failing any AC
   * bounces the Ticket (CONTEXT.md), so no step mark must be fabricated.
   */
  async fail(ticketId: number, steps: unknown): Promise<TicketWithAcs> {
    const marks = parseSteps(steps);
    const failed = marks.filter((mark) => mark.status === "fail");
    for (const mark of failed) {
      if (typeof mark.note !== "string" || mark.note.trim() === "") {
        throw new ValidationError(`failing a step requires a written note (step "${mark.step}")`);
      }
    }
    const target = this.reviewTarget(ticketId);
    const failedAcs = target.ticket.acceptanceCriteria.filter((ac) => ac.status === "failed");
    if (failed.length === 0 && failedAcs.length === 0) {
      throw new ValidationError(
        "a fail verdict needs a failed step or a failed acceptance criterion",
      );
    }
    const { ticket } = await this.bouncer.bounceFromReview({
      ...target,
      reason: "review-fail",
      steps: marks,
    });
    return ticket;
  }

  /**
   * The drift choice that spends another cycle instead of waiving: bounce so
   * a fresh Run re-earns the evidence against the moved tip. What drifted
   * rides into the audit event and Bounce Report; no follow-up ACs are born.
   */
  async reverify(ticketId: number): Promise<TicketWithAcs> {
    const target = this.reviewTarget(ticketId);
    // Best-effort chrome: a gh hiccup mid-reverify loses the drift detail,
    // never the reviewer's bounce.
    const driftReasons = await this.driftReasons(target.ticket, target.repo).catch(() => []);
    const { ticket } = await this.bouncer.bounceFromReview({
      ...target,
      reason: "stale-evidence",
      steps: [],
      driftReasons,
    });
    return ticket;
  }

  /** The guards shared by both bouncing verdicts: right state, a Run to pin the report on. */
  private reviewTarget(ticketId: number): { ticket: TicketWithAcs; run: Run; repo: Repo } {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    if (ticket.state !== "human_review") {
      throw new StateError(`ticket ${ticket.displayKey} is ${ticket.state}, not human_review`);
    }
    const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);
    if (!repo) throw new StateError(`ticket ${ticket.displayKey} has no repo`);
    const run = this.store.listRuns(ticket.id)[0];
    if (!run) throw new StateError(`ticket ${ticket.displayKey} has no run to bounce`);
    return { ticket, run, repo };
  }

  /**
   * The cheap freshness subset (ticket 06 §7): is what the reviewer just
   * approved still what the remote holds? Answered from the port alone — no
   * worktree, no battery. Unknowable stays non-drift, matching freshness():
   * a blocked merge must rest on provable staleness, never a gh hiccup.
   */
  private async driftReasons(ticket: TicketWithAcs, repo: Repo): Promise<string[]> {
    if (ticket.branch === null) return ["no branch recorded on the ticket"];
    const reasons: string[] = [];
    const branchTip = await this.github.branchTip(repo.githubRemote, ticket.branch).catch(() => null);
    if (branchTip === null) {
      reasons.push(`branch ${ticket.branch} is no longer resolvable on the remote`);
      return reasons;
    }
    // A port hiccup (undefined) stays non-drift; a definite "no open PR"
    // (null) is drift — the PR the reviewer approved is gone.
    const pr = await this.github.findPr(repo.githubRemote, ticket.branch).catch(() => undefined);
    if (pr === null) {
      reasons.push(`no open PR found for branch ${ticket.branch}`);
    } else if (pr !== undefined && pr.headSha !== branchTip) {
      reasons.push(
        `PR #${pr.number} head ${shortSha(pr.headSha)} is not the branch tip ${shortSha(branchTip)}`,
      );
    }
    const run = this.store.listRunsWithPhases(ticket.id)[0] ?? null;
    const artifactSha = run?.artifacts.at(-1)?.worktreeHeadSha ?? null;
    if (freshness(artifactSha, branchTip) === "stale") {
      reasons.push(
        `run evidence was persisted at ${shortSha(artifactSha!)}, but the branch tip is ${shortSha(branchTip)}`,
      );
    }
    return reasons;
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The request body's steps, shape-checked before any guard runs. May be
 * empty — a walkthrough-only fail carries no step marks. */
function parseSteps(steps: unknown): ReviewStepMark[] {
  if (!Array.isArray(steps)) {
    throw new ValidationError("a fail verdict needs its step marks (an array, possibly empty)");
  }
  return steps.map((candidate) => {
    const mark = candidate as Partial<Record<keyof ReviewStepMark, unknown>>;
    if (!isReviewStep(mark.step)) {
      throw new ValidationError(
        `unknown wizard step ${JSON.stringify(mark.step)} — steps are ${REVIEW_STEP_KEYS.join(", ")}`,
      );
    }
    if (mark.status !== "pass" && mark.status !== "fail" && mark.status !== "skip") {
      throw new ValidationError(`step "${mark.step}" has no pass/fail/skip status`);
    }
    return {
      step: mark.step,
      status: mark.status,
      note: typeof mark.note === "string" ? mark.note : undefined,
    };
  });
}

function isReviewStep(value: unknown): value is ReviewStepKey {
  return typeof value === "string" && (REVIEW_STEP_KEYS as readonly string[]).includes(value);
}
