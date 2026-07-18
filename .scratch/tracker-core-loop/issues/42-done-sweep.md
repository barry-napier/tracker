# 42 — Done-column sweep

**What to build:** Disk hygiene without evidence loss, per [Worktree lifecycle](08-worktree-lifecycle.md): Done does not auto-destroy. A Done-column sweep action reaps worktrees and preview records satisfying the safety predicate — branch merged (or ticket cancelled/deleted) AND all Run artifacts persisted — and lists anything skipped with the reason. Startup reconciliation removes only true orphan directories (no matching ticket). Parked and bounced tickets keep their worktrees indefinitely.

**Blocked by:** 31 — GitHub for real; 34 — PreviewManager.

**Status:** ready-for-agent

- [ ] Sweep reaps merged-and-persisted tickets' worktrees + preview records; audit event per reap
- [ ] Unmerged or artifact-incomplete tickets are skipped and listed with the reason — never silently
- [ ] Startup removes only worktree dirs with no matching ticket; everything else untouched
- [ ] Proven against scratch repos: merged ticket reaped, parked ticket preserved, orphan dir cleaned
