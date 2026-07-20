import { existsSync } from "node:fs";
import type { ArtifactStore } from "./artifacts.ts";
import type { GitHubPort } from "./github.ts";
import type { PreviewManager } from "./previews.ts";
import { NotFoundError, type Store } from "./store.ts";
import type { TicketWithAcs } from "./types.ts";
import type { WorktreeManager } from "./worktrees.ts";

export interface SweepReap {
  ticketId: number;
  displayKey: string;
  worktreePath: string | null;
  previewRemoved: boolean;
}

export interface SweepSkip {
  ticketId: number;
  displayKey: string;
  reason: string;
}

export interface SweepResult {
  reaped: SweepReap[];
  skipped: SweepSkip[];
}

/**
 * The Done-column sweep (ticket 42): disk hygiene without evidence loss.
 * Done does not auto-destroy — this is the deliberate, batched action. A
 * candidate is a Done ticket that still owns something reapable (a worktree
 * on disk, a preview record); it is reaped only when the safety predicate
 * holds — its PR verifiably merged on the remote AND every kb/ file in the
 * worktree persisted to the artifact store — and skipped WITH the reason
 * otherwise, never silently. Parked and bounced tickets aren't candidates
 * at all: they keep their worktrees indefinitely; that disk cost buys
 * inspectability.
 */
export class DoneSweeper {
  constructor(
    private readonly store: Store,
    private readonly worktrees: WorktreeManager,
    private readonly previews: PreviewManager,
    private readonly artifacts: ArtifactStore,
    private readonly github: GitHubPort,
  ) {}

  async sweep(projectId: number): Promise<SweepResult> {
    if (!this.store.getProject(projectId)) {
      throw new NotFoundError(`project ${projectId} not found`);
    }
    const result: SweepResult = { reaped: [], skipped: [] };
    const skip = (ticket: TicketWithAcs, reason: string) =>
      result.skipped.push({ ticketId: ticket.id, displayKey: ticket.displayKey, reason });

    for (const ticket of this.store.listTickets(projectId)) {
      if (ticket.state !== "done") continue;
      const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);
      if (!repo) {
        // A Done ticket should always know its repo; if it somehow doesn't,
        // a lingering preview record must still be reported, never orphaned
        // in silence (the worktree half is startup reconciliation's job).
        if (this.store.getPreview(ticket.id) !== undefined) {
          skip(ticket, "repo no longer registered — preview record kept");
        }
        continue;
      }
      const worktreePath = this.worktrees.worktreePath(repo, ticket.displayKey);
      const onDisk = existsSync(worktreePath);
      // Nothing left to reap → not a candidate; listing it every sweep
      // would bury the skips that matter.
      if (!onDisk && this.store.getPreview(ticket.id) === undefined) continue;

      // One ticket's reap failing must not abort the batch or lose the
      // report — the sweep's contract is the whole story, every time.
      try {
        const reason = await this.#unsafeReason(ticket, repo.githubRemote, onDisk ? worktreePath : null);
        if (reason !== null) {
          skip(ticket, reason);
          continue;
        }
        // Process and log first (the preview's cwd is the worktree), then the
        // tree, then the record + audit in one transaction.
        await this.previews.discard(ticket.id);
        const removed = onDisk ? await this.worktrees.removeWorktree(repo, ticket.displayKey) : null;
        const { previewRemoved } = this.store.reapTicket(ticket.id, { worktreePath: removed });
        result.reaped.push({
          ticketId: ticket.id,
          displayKey: ticket.displayKey,
          worktreePath: removed,
          previewRemoved,
        });
      } catch (error) {
        skip(ticket, `reap failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /** Null when the reap is safe; otherwise the skip's honest reason. */
  async #unsafeReason(
    ticket: TicketWithAcs,
    remote: string,
    worktreePath: string | null,
  ): Promise<string | null> {
    if (this.store.listRuns(ticket.id).some((run) => run.state === "running")) {
      return "a run is still in flight";
    }
    if (ticket.prNumber === null) {
      return "no PR recorded on the ticket";
    }
    // "Not verifiably" is exact: a NullGitHub workspace can't verify anything,
    // and an unverifiable merge must read as unsafe, not as an accusation.
    if (!(await this.github.prMerged(remote, ticket.prNumber))) {
      return `PR #${ticket.prNumber} is not verifiably merged on the remote`;
    }
    if (worktreePath !== null) {
      const runIds = this.store.listRuns(ticket.id).map((run) => run.id);
      const unpersisted = this.artifacts.unvouchedKbFiles(runIds, worktreePath);
      if (unpersisted.length > 0) {
        return `unpersisted evidence: ${unpersisted.join(", ")}`;
      }
    }
    return null;
  }
}
