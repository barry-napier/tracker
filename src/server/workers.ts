import type { EventBus } from "./bus.ts";
import type { Store } from "./store.ts";
import type { WorktreeManager } from "./worktrees.ts";

const MAX_SETUP_FAILURES = 3;

/**
 * The factory's claiming half (spec: 3 workers, more melted the CPU). A slot
 * is held from claim until the Run ends; nothing ends Runs yet in this slice,
 * so a claimed ticket occupies its slot until the app quits — slice 26 frees
 * slots when phases finish.
 */
export class WorkerPool {
  #active = new Set<number>();
  #inFlight = new Set<Promise<void>>();
  #setupFailures = new Map<number, number>();
  #stopped = false;

  constructor(
    private readonly store: Store,
    private readonly worktrees: WorktreeManager,
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

  /** Resolves once no setup is mid-git, so teardown can't race a clone. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#inFlight]);
  }

  claimUpToCapacity(): void {
    if (this.#stopped) return;
    while (this.#active.size < this.capacity) {
      // Stop-gap until slice 41's crash policy (which parks in Human Review):
      // a ticket whose setup keeps dying is skipped instead of hot-looping
      // claim → crash. It sits in Todo, unclaimed, until an app restart.
      const exclude = new Set(
        [...this.#setupFailures]
          .filter(([, count]) => count >= MAX_SETUP_FAILURES)
          .map(([ticketId]) => ticketId),
      );
      const claimed = this.store.claimNextTodoTicket(exclude);
      if (!claimed) return;
      this.#active.add(claimed.run.id);
      const setup = this.#setUp(claimed);
      this.#inFlight.add(setup);
      void setup.finally(() => this.#inFlight.delete(setup));
    }
  }

  async #setUp(claimed: {
    ticket: { id: number; displayKey: string; branch: string | null };
    run: { id: number };
    repo: { path: string; targetBranch: string };
  }): Promise<void> {
    const { ticket, run, repo } = claimed;
    try {
      const result = await this.worktrees.ensureWorktree(repo, ticket.displayKey, ticket.branch!);
      if (this.#stopped) return;
      this.store.recordWorktree(run.id, result);
      this.#setupFailures.delete(ticket.id);
      // The Run now idles in its worktree; slice 26 starts the first phase here.
    } catch (error) {
      if (this.#stopped) return;
      this.#setupFailures.set(ticket.id, (this.#setupFailures.get(ticket.id) ?? 0) + 1);
      this.#active.delete(run.id);
      this.store.markRunCrashed(run.id, error instanceof Error ? error.message : String(error));
    }
  }
}
