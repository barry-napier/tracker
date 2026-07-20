# 42 — Done-column sweep

**What to build:** Disk hygiene without evidence loss, per [Worktree lifecycle](08-worktree-lifecycle.md): Done does not auto-destroy. A Done-column sweep action reaps worktrees and preview records satisfying the safety predicate — branch merged (or ticket cancelled/deleted) AND all Run artifacts persisted — and lists anything skipped with the reason. Startup reconciliation removes only true orphan directories (no matching ticket). Parked and bounced tickets keep their worktrees indefinitely.

**Blocked by:** 31 — GitHub for real; 34 — PreviewManager.

**Status:** done (2026-07-20)

- [x] Sweep reaps merged-and-persisted tickets' worktrees + preview records; audit event per reap
- [x] Unmerged or artifact-incomplete tickets are skipped and listed with the reason — never silently
- [x] Startup removes only worktree dirs with no matching ticket; everything else untouched
- [x] Proven against scratch repos: merged ticket reaped, parked ticket preserved, orphan dir cleaned

**Resolution notes (2026-07-20):** `DoneSweeper` (src/server/sweep.ts) behind
`POST /api/projects/:id/sweep`; the Done column renders a "⌁ Sweep worktrees"
button whose report (reaped keys, skips with reasons) stays under it. A
candidate is a Done ticket still owning a worktree on disk or a preview
record — parked/bounced tickets are never candidates, and already-clean Done
tickets aren't listed. Predicate: no run in flight, PR recorded AND re-verified
merged via the new `GitHubPort.prMerged` (gh `pr view --json state`; NullGitHub
answers false → honest skip), and every `kb/` file matched by name+sha256
against the ticket's persisted artifact rows — anything unvouched blocks the
reap as "unpersisted evidence". Reap order: `previews.discard` (process + log
file) → `WorktreeManager.removeWorktree` (`git worktree remove --force` on the
bare, chained on the repo lock, rm+prune fallback) → `store.reapTicket`
(preview row delete + `worktree.reaped` audit in one transaction; Done stays
Done). Startup reconciliation: `removeOrphanDirs(keep)` in startServer removes
only worktree dirs no ticket accounts for, then prunes every bare's admin
records. "Cancelled/deleted" tickets from the spec's predicate don't exist as
states yet — merged-only until they do. Tests: tests/sweep.test.ts (store-seam
predicate walk incl. skip reasons; API pipeline reap; parked preserved +
orphan-dir reconciliation across a relaunch).
