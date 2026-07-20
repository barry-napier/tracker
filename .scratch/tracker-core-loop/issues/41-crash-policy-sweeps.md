# 41 — Crash policy and the startup sweep

**What to build:** Crash handling distinct from bouncing (crash = work didn't happen → Todo; bounce = work was wrong → In Progress), per [Workflow engine design](07-workflow-engine.md). Phase death — process crash, non-zero exit, clean exit without the contract file, or 15 minutes of output silence (kill) — retries the phase once; a second death ends the Run crashed and returns the Ticket to Todo with no new criteria. Three crashed Runs park the Ticket in Human Review, mirroring the bounce cap. At app launch, any Run still marked running is an orphan: marked crashed and fed through the same policy. Per-phase wall-clock timeout (default 30 min) SIGTERMs the provider.

**Blocked by:** 30 — Bounce machinery.

**Status:** done (2026-07-20)

- [x] Each death mode (crash, non-zero, no-contract clean exit, silence) detected and audited distinctly; retry once, then Run crashed → Todo
- [x] Crash adds no follow-up criteria; the re-claim reuses the worktree with the tree-state summary available
- [x] 3 crashed Runs park in Human Review with the cap flag
- [x] Kill-the-app-mid-phase → relaunch marks the orphan crashed and the Ticket recovers per policy
- [x] Wall-clock timeout enforced orchestrator-side for any provider

**Note from slice 27 (2026-07-18):** cancelled/orphaned Runs currently skip artifact
persistence entirely (`WorkerPool` bails before `ArtifactStore.persistRun`; the
worktree keeps the `kb/` files, so nothing is lost — just not yet persisted). The
startup orphan sweep here should persist the orphan's `kb/*` when it marks the Run
crashed, closing the "every Run end persists evidence" gap. Same for the unpinned
decision flagged in slice 26: hollow-phase failures currently go to Todo and do not
count toward any cap — decide their home when the bounce/crash policies land.

**Resolution notes (2026-07-20):** Every phase-level failure is now a death
handled by the crash policy — the slice-26 question settled the wide way. Death
modes (`DeathMode` in engine.ts, audited in `phase.crashed` detail): `crash`
(provider crashed / stream broke), `non-zero-exit` (provider-reported failure —
the claude adapter maps non-zero exits and `is_error` results here),
`hollow-exit` (clean exit, no contract file), `contract-breach` (contract
present but check manifest or branch-outcome declaration unmet), `silence`
(15-min no-output kill), `timeout` (30-min wall-clock SIGTERM), `orphan`
(startup sweep). Consequence: `PhaseFailedError` and run-state `failed` writes
are gone — "wrong work" is only ever the battery's verdict (bounce), and the
engine polices only contract mechanics. Watchdogs arm when the provider starts
(dogfood preview boot is engine time) and are configurable via
`startServer({ phaseTimeouts })` for tests. The crash cap lives in
`store.finishRun` (3 crashed runs → `human_review` + `arrived_by_cap`, audit
`ticket.parked` reason `crash-cap`), replacing the WorkerPool's in-memory
`#failures` stop-gap — `claimNextTicket` lost its exclude param. The crash
audit carries the tree-state summary (`readTreeState` moved to worktrees.ts);
`sweepOrphanedRuns` (workers.ts, awaited in `startServer` before the pool
starts) persists the orphan's `kb/*`, reaps `running` phases with mode
`orphan`, and feeds the run through `finishRun` — closing slice 27's gap.
Tests: tests/crash-policy.test.ts (7 cases incl. kill-the-app-relaunch);
scriptedProvider grew a `"hang"` sabotage verdict.
