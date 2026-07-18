# 25 — First claim cuts a worktree

**What to build:** A worker pool (3 workers) claims Todo Tickets while the app runs. Claiming creates the Run row (claim = Run creation, no leases — see [Worktree lifecycle](08-worktree-lifecycle.md)), ensures the Tracker-owned bare clone for the Repo (created on registration, fetched on claim), cuts the branch from the target branch tip, and adds the worktree. The board shows In Progress live; the drawer shows the Run with its branch and worktree.

**Blocked by:** 24 — Promote across the full board.

**Status:** done (2026-07-18)

- [x] Bare clone per Repo in app data, created once, fetched on each claim; the user's checkout at the repo path is never touched
- [x] Worktree keyed by ticket (`<repo>--<trk-id>`), cut from the target branch tip on first claim
- [x] Branch named conventional-commit type + external-ref id (TRK fallback); name recorded in the DB at creation, never parsed for identity
- [x] `kb/` and `checks/` added to the worktree's git exclude at creation (nothing workflow-generated reaches the PR)
- [x] Claim = Run row; claimed Ticket shows In Progress on the board via SSE; audit events for claim and worktree creation
- [x] Worktree-manager behavior proven against a real scratch repo (create + re-claim reuse)

## Resolution (2026-07-18)

Migration v3: `runs` table (claim = Run row, `worktree_path` null until the tree is
up), `tickets.branch` (recorded at claim, never parsed — ADR-0002), and
`tickets.external_ref` (accepted at filing; feeds branch naming). `WorktreeManager`
(`src/server/worktrees.ts`) owns the git estate: bare clone at
`<app-data>/repos/<name>.git` with fetch refspec rewritten to
`refs/remotes/origin/*` so fetches never clobber ticket branches; worktrees at
`<app-data>/worktrees/<repo>--<trk-id>`; `kb/`+`checks/` in the bare repo's shared
`info/exclude` (equivalent to per-worktree exclude — all its worktrees are ticket
worktrees); re-claims are fetch-only reuse. Per-repo promise chain serializes
concurrent claims (three parallel first claims raced the clone).

`WorkerPool` (3 slots; slots stay held because nothing ends Runs until slice 26)
claims on every `ticket.updated`. Claiming is `Store.claimNextTodoTicket` — one
transaction: oldest Todo → In Progress + branch fixed + Run row + `ticket.claimed`
audit (actor agent); `recordWorktree` / `markRunCrashed` follow after git. A
setup-failure cap (3, in-memory) keeps a broken repo from hot-looping claim→crash —
stop-gap until slice 41's crash policy. The claim-inside-promote dispatch exposed a
real EventBus bug: nested emits delivered out of seq order to later subscribers;
emit now drains a FIFO queue.

Deviations: bare clone is created on first claim, not registration (earlier-slice
tests register fake paths; "created once, fetched on each claim" still holds), and
`run.updated` SSE joins the drafted contract (the drawer needs the worktree landing
live). Known hazard flagged for later: repos sharing a directory basename would
share a bare clone. Proven at the HTTP/SSE seam (`tests/claim.test.ts`: claim +
audit + branch naming + 3-slot cap) and module-level against real scratch repos
(`tests/worktrees.test.ts`); verified live in the renderer (board flip + drawer Run
section).
