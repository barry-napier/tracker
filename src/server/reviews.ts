import type { GitHubPort, Mergeability } from "./github.ts";
import { NotFoundError, type Store } from "./store.ts";
import type { RunWithPhases, TicketWithAcs } from "./types.ts";
import type { WorktreeManager } from "./worktrees.ts";

/**
 * Everything the review wizard's chrome needs beyond what the board already
 * streams: the latest Run's evidence, the Ticket's PR with live mergeability,
 * and freshness of the persisted artifacts against the remote branch tip.
 * Read model only — verdicts stay in Verdicts (slice 33).
 */
export interface ReviewPayload {
  ticket: TicketWithAcs;
  /** The latest Run — the one the wizard reads. Null before first claim. */
  run: RunWithPhases | null;
  pr: { number: number; url: string; mergeability: Mergeability } | null;
  /** The branch's tip on the remote right now; null when unresolvable. */
  branchTip: string | null;
  /** The worktree HEAD the latest Run's evidence was persisted at. */
  artifactSha: string | null;
  freshness: Freshness;
}

/** Unknown is a real answer (like Mergeability): it means no banner, ever. */
export type Freshness = "fresh" | "stale" | "unknown";

/**
 * Stale only when provable (ticket 32): both SHAs known and neither a prefix
 * of the other. Prefix compare tolerates one side arriving abbreviated;
 * anything unknowable stays "unknown", never a verdict.
 */
export function freshness(artifactSha: string | null, branchTip: string | null): Freshness {
  if (!artifactSha || !branchTip) return "unknown";
  return artifactSha.startsWith(branchTip) || branchTip.startsWith(artifactSha)
    ? "fresh"
    : "stale";
}

export class Reviews {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubPort,
    private readonly worktrees: WorktreeManager,
  ) {}

  async forTicket(ticketId: number): Promise<ReviewPayload> {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    const run = this.store.listRunsWithPhases(ticket.id)[0] ?? null;
    const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);

    // GitHub answers are best-effort chrome: a gh hiccup degrades to
    // "unknown"/no banner rather than failing the whole wizard open.
    let pr: ReviewPayload["pr"] = null;
    if (ticket.prNumber !== null && ticket.prUrl !== null && repo && repo.githubRemote !== null) {
      const mergeability = await this.github
        .mergeability(repo.githubRemote, ticket.prNumber)
        .catch((): Mergeability => "unknown");
      pr = { number: ticket.prNumber, url: ticket.prUrl, mergeability };
    }
    // A local-only Repo's "remote" tip is the bare clone's — the ref the
    // Done merge will fetch; freshness means exactly the same thing.
    const branchTip =
      ticket.branch !== null && repo
        ? repo.githubRemote === null
          ? await this.worktrees.localBranchTip(repo, ticket.branch)
          : await this.github.branchTip(repo.githubRemote, ticket.branch).catch(() => null)
        : null;

    // All of a run's blobs persist at one worktree HEAD; the newest row wins
    // if a late persist (e.g. the bounce report) ever recorded a mover.
    const artifactSha = run?.artifacts.at(-1)?.worktreeHeadSha ?? null;
    return { ticket, run, pr, branchTip, artifactSha, freshness: freshness(artifactSha, branchTip) };
  }
}
