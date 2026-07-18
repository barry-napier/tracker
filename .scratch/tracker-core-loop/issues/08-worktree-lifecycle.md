# Worktree lifecycle and claim/lease semantics

Type: grilling
Status: resolved
Blocked by: 05

## Question

How are worktrees and claims managed for the 3-worker pool? Decide: worktree location and naming (prototype: `<repos-dir>/<repo>--<ticket-id>`, cut from the project's target branch), branch naming (`<type>/<ticket-id>-<slug>`), when worktrees are created and destroyed (on claim / on merge / on bounce), claim/lease semantics (prototype shows claim + lease-released events — lease duration? stale-lease recovery after crash or app quit?), what happens to a worktree when a ticket bounces back to In Progress, and disk hygiene for abandoned worktrees.

## Answer

Resolved 2026-07-18 by grilling.

- **Parent clones — Tracker-owned bare clones.** Tracker maintains its own bare clone per repo at `<app-data>/repos/<repo>.git`, created on repo registration and fetched on each claim. All worktrees hang off it; agents never touch the user's checkout at `local_path` (no ref mutation, no worktree-list clutter, moving/deleting the user's clone can't break runs).
- **Worktree location/naming.** `<app-data>/worktrees/<repo>--<trk-id>`, keyed by ticket. Directory name always uses the internal TRK id — stable regardless of external refs.
- **Branch naming.** Conventional-commit type prefix + the external tracking system's ID when the ticket has an `external_ref`, TRK id as fallback: `feat/lin-482-user-avatars`, `fix/gh-231-login-crash`, `feat/trk-12-user-avatars`. The branch name is written to the DB at creation and never parsed for identity (per ADR-0002).
- **Creation.** On a ticket's *first* claim: fetch the bare clone, cut the branch from the target branch tip, `git worktree add`. Bounce/crash re-claims reuse the existing worktree.
- **Claim/lease semantics — no leases.** Claim = Run row creation (per the domain model). Electron's single-instance lock guarantees exactly one orchestrator process, so there is no distributed contention. Stale-claim recovery is a startup sweep: on app launch, any Run still marked `running` is an orphan → mark crashed and apply the existing crash policy (ticket → Todo; 3 crashes park in Human Review). The prototype's lease/lease-released events are dropped.
- **Re-claim tree state — leave as-is.** No reset, no clean, no WIP commits, no auto-rebase: uncommitted work from a crashed phase survives for the next run (agents reconcile via `git status`/`diff`). The orchestrator does `git fetch` and records a tree-state summary (branch, ahead-by, dirty-file count) in the Bounce Report / crash context. Freshness vs the target branch remains the `pr-fresh` gate's job at Final Verdict.
- **Teardown — manual, batched, predicate-guarded.** Done does **not** auto-destroy. The Done-column sweep button (from the prototype) reaps worktrees satisfying the safety predicate: branch merged (or ticket cancelled/deleted) AND all Run artifacts persisted to the DB/blob store; anything unsafe is skipped and listed with the reason. Startup reconciliation removes only true orphans — worktree dirs with no matching ticket (DB reset, repo removed). Parked and bounced tickets keep their worktrees indefinitely; that disk cost buys inspectability. No TTLs, no size caps in v1.
