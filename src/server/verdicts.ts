import type { GitHubPort } from "./github.ts";
import { NotFoundError, StateError, type Store } from "./store.ts";

/**
 * The verdict action at the API seam (ticket 31): pass merges the PR through
 * the GitHubPort and moves the Ticket to Done. Every guard runs before the
 * port is touched — a merge is the one side effect here that can't roll
 * back. The wizard UI driving this (and the fail verdict that bounces)
 * arrives in slice 33.
 */
export class Verdicts {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubPort,
  ) {}

  async pass(ticketId: number) {
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
    const mergeability = await this.github.mergeability(repo.githubRemote, ticket.prNumber);
    if (mergeability === "conflicting") {
      throw new StateError(`PR #${ticket.prNumber} has conflicts with ${repo.targetBranch}`);
    }
    await this.github.mergePr(repo.githubRemote, ticket.prNumber);
    return this.store.mergeTicket(ticket.id);
  }
}
