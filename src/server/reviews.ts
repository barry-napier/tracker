import type { GitHubPort, Mergeability } from "./github.ts";
import { REVIEW_DIGEST_KIND } from "./review-agent.ts";
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
  /**
   * The review agent's pre-digest (TRK-3), with its own staleness verdict:
   * findings produced at one HEAD are invalidated by commits after it
   * (AC-43), independent of the run's other evidence. Null when the agent
   * never produced one — see digestFailure for why.
   */
  digest: { artifactId: number; producedAtSha: string; freshness: Freshness } | null;
  /** AC-42's flag: the agent's failure reason when the wizard opens raw-diff. */
  digestFailure: string | null;
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

    // The digest rides its own freshness (AC-43): its artifact row's HEAD
    // stamp against the live tip, so a commit landing after the agent read
    // the diff invalidates the findings even when other evidence keeps up.
    const digestArtifact = run?.artifacts.filter((a) => a.kind === REVIEW_DIGEST_KIND).at(-1);
    const digest = digestArtifact
      ? {
          artifactId: digestArtifact.id,
          producedAtSha: digestArtifact.worktreeHeadSha,
          freshness: freshness(digestArtifact.worktreeHeadSha, branchTip),
        }
      : null;
    // AC-42: absence is flagged with the agent's own failure, read from the
    // audit trail — the wizard says why it opened raw-diff.
    let digestFailure: string | null = null;
    if (digest === null && run !== null) {
      type DigestDetail = { runId?: number; status?: string; reason?: string };
      const failure = this.store
        .listAuditEvents(ticket.id)
        .filter((event) => {
          const detail = event.detail as DigestDetail;
          return (
            event.type === "review.digest" && detail.runId === run.id && detail.status === "failed"
          );
        })
        .at(-1);
      const reason = (failure?.detail as DigestDetail | undefined)?.reason;
      digestFailure =
        failure === undefined ? null : typeof reason === "string" ? reason : "review agent failed";
    }

    return {
      ticket,
      run,
      pr,
      branchTip,
      artifactSha,
      freshness: freshness(artifactSha, branchTip),
      digest,
      digestFailure,
    };
  }
}
