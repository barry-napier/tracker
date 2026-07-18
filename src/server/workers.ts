import type { ArtifactStore } from "./artifacts.ts";
import type { EventBus } from "./bus.ts";
import { PhaseCancelledError, PhaseFailedError, type WorkflowEngine } from "./engine.ts";
import type { GateBattery } from "./gates.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs } from "./types.ts";
import type { WorktreeManager } from "./worktrees.ts";

const MAX_FAILURES = 3;

/**
 * The factory's claiming half (spec: 3 workers, more melted the CPU). A slot
 * is held from claim until the Run ends — setup, workflow phases, and the
 * run's verdict all happen inside it — then freed for the next Todo ticket.
 */
export class WorkerPool {
  #active = new Set<number>();
  #inFlight = new Set<Promise<void>>();
  #failures = new Map<number, number>();
  #stopped = false;
  #abort = new AbortController();

  constructor(
    private readonly store: Store,
    private readonly worktrees: WorktreeManager,
    private readonly engine: WorkflowEngine,
    private readonly artifacts: ArtifactStore,
    private readonly battery: GateBattery,
    private readonly capacity: number,
  ) {}

  start(bus: EventBus): void {
    if (this.capacity <= 0) return;
    // A promotion is a ticket.updated; re-check on every one rather than parse.
    bus.subscribe((event) => {
      if (event.type === "ticket.updated") this.claimUpToCapacity();
    });
    this.claimUpToCapacity();
  }

  /**
   * Cancel in-flight phases and resolve once nothing is mid-git or mid-DB.
   * Cancelled Runs stay "running" on disk — the startup orphan sweep of a
   * later slice marks them crashed (spec: no leases, ticket 08).
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#inFlight]);
  }

  claimUpToCapacity(): void {
    if (this.#stopped) return;
    while (this.#active.size < this.capacity) {
      // Stop-gap until slice 41's crash policy (which parks in Human Review):
      // a ticket that keeps dying — setup crash, hollow phase, provider
      // crash — is skipped instead of hot-looping claim → fail. It sits in
      // Todo, unclaimed, until an app restart.
      const exclude = new Set(
        [...this.#failures]
          .filter(([, count]) => count >= MAX_FAILURES)
          .map(([ticketId]) => ticketId),
      );
      const claimed = this.store.claimNextTodoTicket(exclude);
      if (!claimed) return;
      this.#active.add(claimed.run.id);
      const work = this.#work(claimed);
      this.#inFlight.add(work);
      void work.finally(() => {
        this.#inFlight.delete(work);
        this.#active.delete(claimed.run.id);
        this.claimUpToCapacity();
      });
    }
  }

  async #work(claimed: { ticket: TicketWithAcs; run: Run; repo: Repo }): Promise<void> {
    const { ticket, run, repo } = claimed;
    let worktreePath: string;
    try {
      const result = await this.worktrees.ensureWorktree(repo, ticket.displayKey, ticket.branch!);
      if (this.#stopped) return;
      this.store.recordWorktree(run.id, result);
      worktreePath = result.worktreePath;
    } catch (error) {
      if (this.#stopped) return;
      this.#recordFailure(ticket.id);
      this.store.finishRun(run.id, "crashed", messageOf(error));
      return;
    }

    if (this.#stopped) return;
    try {
      await this.engine.execute({ run, ticket, repo, worktreePath, signal: this.#abort.signal });
      // Verifying implies evidence on disk: failing to persist a completed
      // run's artifacts crashes it rather than shipping it unevidenced.
      await this.artifacts.persistRun(run.id, worktreePath);
      this.store.finishRun(run.id, "completed");
      this.#failures.delete(ticket.id);
      if (this.#stopped) return;
      // The battery judges the Run at Verifying (ADR-0003) — still inside
      // the worker slot, so a claim can't land on an unjudged worktree. A
      // battery blow-up leaves the ticket visibly parked in Verifying with
      // whatever results were recorded; it must not be mistaken for a
      // crashed run — the work itself completed.
      try {
        await this.battery.run({ run, ticket, repo, worktreePath });
      } catch (error) {
        console.error(`run ${run.id}: gate battery crashed mid-flight`, error);
      }
    } catch (error) {
      if (error instanceof PhaseCancelledError || this.#stopped) return;
      // Best effort on the failure paths — evidence survives, but a persist
      // hiccup must not mask the run's real outcome. Loudly best-effort:
      // an invisible skip would fake "evidence persisted on every run end".
      await this.artifacts.persistRun(run.id, worktreePath).catch((persistError: unknown) => {
        console.error(`run ${run.id}: artifact persist failed`, persistError);
      });
      this.#recordFailure(ticket.id);
      this.store.finishRun(
        run.id,
        error instanceof PhaseFailedError ? "failed" : "crashed",
        messageOf(error),
      );
    }
  }

  #recordFailure(ticketId: number): void {
    this.#failures.set(ticketId, (this.#failures.get(ticketId) ?? 0) + 1);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
