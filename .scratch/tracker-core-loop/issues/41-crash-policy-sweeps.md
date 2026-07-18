# 41 — Crash policy and the startup sweep

**What to build:** Crash handling distinct from bouncing (crash = work didn't happen → Todo; bounce = work was wrong → In Progress), per [Workflow engine design](07-workflow-engine.md). Phase death — process crash, non-zero exit, clean exit without the contract file, or 15 minutes of output silence (kill) — retries the phase once; a second death ends the Run crashed and returns the Ticket to Todo with no new criteria. Three crashed Runs park the Ticket in Human Review, mirroring the bounce cap. At app launch, any Run still marked running is an orphan: marked crashed and fed through the same policy. Per-phase wall-clock timeout (default 30 min) SIGTERMs the provider.

**Blocked by:** 30 — Bounce machinery.

**Status:** ready-for-agent

- [ ] Each death mode (crash, non-zero, no-contract clean exit, silence) detected and audited distinctly; retry once, then Run crashed → Todo
- [ ] Crash adds no follow-up criteria; the re-claim reuses the worktree with the tree-state summary available
- [ ] 3 crashed Runs park in Human Review with the cap flag
- [ ] Kill-the-app-mid-phase → relaunch marks the orphan crashed and the Ticket recovers per policy
- [ ] Wall-clock timeout enforced orchestrator-side for any provider

**Note from slice 27 (2026-07-18):** cancelled/orphaned Runs currently skip artifact
persistence entirely (`WorkerPool` bails before `ArtifactStore.persistRun`; the
worktree keeps the `kb/` files, so nothing is lost — just not yet persisted). The
startup orphan sweep here should persist the orphan's `kb/*` when it marks the Run
crashed, closing the "every Run end persists evidence" gap. Same for the unpinned
decision flagged in slice 26: hollow-phase failures currently go to Todo and do not
count toward any cap — decide their home when the bounce/crash policies land.
