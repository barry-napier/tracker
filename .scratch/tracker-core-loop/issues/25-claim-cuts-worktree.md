# 25 — First claim cuts a worktree

**What to build:** A worker pool (3 workers) claims Todo Tickets while the app runs. Claiming creates the Run row (claim = Run creation, no leases — see [Worktree lifecycle](08-worktree-lifecycle.md)), ensures the Tracker-owned bare clone for the Repo (created on registration, fetched on claim), cuts the branch from the target branch tip, and adds the worktree. The board shows In Progress live; the drawer shows the Run with its branch and worktree.

**Blocked by:** 24 — Promote across the full board.

**Status:** ready-for-agent

- [ ] Bare clone per Repo in app data, created once, fetched on each claim; the user's checkout at the repo path is never touched
- [ ] Worktree keyed by ticket (`<repo>--<trk-id>`), cut from the target branch tip on first claim
- [ ] Branch named conventional-commit type + external-ref id (TRK fallback); name recorded in the DB at creation, never parsed for identity
- [ ] `kb/` and `checks/` added to the worktree's git exclude at creation (nothing workflow-generated reaches the PR)
- [ ] Claim = Run row; claimed Ticket shows In Progress on the board via SSE; audit events for claim and worktree creation
- [ ] Worktree-manager behavior proven against a real scratch repo (create + re-claim reuse)
