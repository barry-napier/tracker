import { existsSync } from "node:fs";
import type { ArtifactStore } from "./artifacts.ts";
import type { Bouncer } from "./bounce.ts";
import type { EventBus } from "./bus.ts";
import type { DemoOutcome, DemoRecorder } from "./demos.ts";
import { DeadGraphError, PhaseCancelledError, type WorkflowEngine } from "./engine.ts";
import type { GateBattery } from "./gates.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs, TreeState } from "./types.ts";
import { readTreeState, type WorktreeManager } from "./worktrees.ts";

/**
 * The factory's claiming half (spec: 3 workers, more melted the CPU). A slot
 * is held from claim until the Run ends — setup, workflow phases, and the
 * run's verdict all happen inside it — then freed for the next Todo ticket.
 * A ticket that keeps dying is no longer skipped in memory: the crash cap
 * (ticket 41, store.finishRun) parks it in Human Review after 3 crashed runs.
 */
export class WorkerPool {
  #active = new Set<number>();
  #inFlight = new Set<Promise<void>>();
  #stopped = false;
  #abort = new AbortController();

  constructor(
    private readonly store: Store,
    private readonly worktrees: WorktreeManager,
    private readonly engine: WorkflowEngine,
    private readonly artifacts: ArtifactStore,
    private readonly demos: DemoRecorder,
    private readonly battery: GateBattery,
    private readonly bouncer: Bouncer,
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
   * Cancelled Runs stay "running" on disk — the startup orphan sweep marks
   * them crashed on the next launch (spec: no leases, ticket 08).
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#inFlight]);
  }

  claimUpToCapacity(): void {
    if (this.#stopped) return;
    while (this.#active.size < this.capacity) {
      const claimed = this.store.claimNextTicket();
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
      // Setup errors are deterministic (empty repo, bad target branch), not
      // weather: "failed" parks the ticket with the reason instead of letting
      // the crash cap burn three identical attempts in milliseconds.
      this.store.finishRun(run.id, "failed", `setup failed: ${messageOf(error)}`);
      return;
    }

    if (this.#stopped) return;
    try {
      await this.engine.execute({ run, ticket, repo, worktreePath, signal: this.#abort.signal });
      // Verifying implies evidence on disk: failing to persist a completed
      // run's artifacts crashes it rather than shipping it unevidenced.
      await this.artifacts.persistRun(run.id, worktreePath);
      this.store.finishRun(run.id, "completed");
      if (this.#stopped) return;
      // The demo phase (ticket 35): boot the preview from the finished
      // worktree and record against it. However it ends, it's an outcome the
      // demo-fresh gate judges — a broken demo bounces the ticket, never
      // crashes the run.
      const demo: DemoOutcome = await this.demos
        .record({ run, ticket, repo, worktreePath, signal: this.#abort.signal })
        .catch((error: unknown): DemoOutcome => ({ status: "failed", reason: messageOf(error) }));
      if (this.#stopped) return;
      // The battery judges the Run at Verifying (ADR-0003) — still inside
      // the worker slot, so a claim can't land on an unjudged worktree. A
      // battery blow-up leaves the ticket visibly parked in Verifying with
      // whatever results were recorded; it must not be mistaken for a
      // crashed run — the work itself completed.
      let verdict: { passed: boolean } | undefined;
      try {
        verdict = await this.battery.run({ run, ticket, repo, worktreePath, demo });
      } catch (error) {
        console.error(`run ${run.id}: gate battery crashed mid-flight`, error);
      }
      if (this.#stopped || verdict === undefined || verdict.passed) return;
      // A bounce blow-up strands the ticket in Verifying the same way — say
      // which half died so the parked state is diagnosable.
      try {
        await this.bouncer.bounce({ run, ticket, repo, worktreePath });
      } catch (error) {
        console.error(`run ${run.id}: bounce crashed mid-flight`, error);
      }
    } catch (error) {
      if (error instanceof PhaseCancelledError || this.#stopped) return;
      // A dead graph is deterministic like a setup failure: no phase ran and
      // no retry can change that, so park the ticket wearing the reason
      // instead of burning three identical no-op attempts through the cap.
      if (error instanceof DeadGraphError) {
        this.store.finishRun(run.id, "failed", messageOf(error));
        return;
      }
      // Best effort on the failure paths — evidence survives, but a persist
      // hiccup must not mask the run's real outcome. Loudly best-effort:
      // an invisible skip would fake "evidence persisted on every run end".
      await this.artifacts.persistRun(run.id, worktreePath).catch((persistError: unknown) => {
        console.error(`run ${run.id}: artifact persist failed`, persistError);
      });
      // Crash = work didn't happen (ticket 41): back to Todo with no new
      // criteria, the reused worktree summarized for the re-claim to inherit.
      const treeState = await readTreeState(worktreePath, repo.targetBranch).catch(() => null);
      this.store.finishRun(run.id, "crashed", messageOf(error), { treeState });
    }
  }
}

/**
 * The startup orphan sweep (ticket 41): no leases means an app death leaves
 * Runs still marked running. Each one is fed through the same crash policy —
 * its worktree's `kb/` persisted first (closing slice 27's "every Run end
 * persists evidence" gap), its mid-flight phases reaped with the `orphan`
 * death mode, the Run crashed, and the Ticket recovered (Todo, or parked at
 * the crash cap). Runs before the pool starts claiming.
 */
export async function sweepOrphanedRuns(store: Store, artifacts: ArtifactStore): Promise<void> {
  for (const run of store.listRunningRuns()) {
    const ticket = store.getTicket(run.ticketId)!;
    let treeState: TreeState | null = null;
    if (run.worktreePath !== null && existsSync(run.worktreePath)) {
      await artifacts.persistRun(run.id, run.worktreePath).catch((error: unknown) => {
        console.error(`run ${run.id}: orphan artifact persist failed`, error);
      });
      const repo = ticket.repoId === null ? undefined : store.getRepo(ticket.repoId);
      if (repo) {
        treeState = await readTreeState(run.worktreePath, repo.targetBranch).catch(() => null);
      }
    }
    for (const phase of store.listPhaseExecutions(run.id)) {
      if (phase.state !== "running") continue;
      store.endPhase(phase.id, "crashed", {
        failureReason: "orphaned: the app quit mid-phase",
        deathMode: "orphan",
      });
    }
    store.finishRun(run.id, "crashed", "orphaned: still marked running at app launch", {
      treeState,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
