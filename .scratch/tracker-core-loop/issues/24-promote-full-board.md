# 24 — Promote to Todo across the full six-column board

**What to build:** Register a Project with one or more Repos (local path, GitHub remote, target branch — preview config fields exist but are unused until slice 34). The board shows all six columns (Backlog → Todo → In Progress → Verifying → Human Review → Done). Promoting a Backlog Ticket means picking its target Repo and provider (defaulted from the Project) directly on the card; the Ticket moves to Todo with repo and provider set, and the promotion lands in the Audit Trail and on the SSE stream.

**Blocked by:** 23 — Renderer skeleton.

**Status:** done (2026-07-18)

- [x] Project/Repo registration via API + minimal UI; repo carries path, remote, target branch, provider default
- [x] Ticket `repo_id` is null until promotion; promotion requires exactly one Repo (one Ticket = one branch = one PR)
- [x] Provider picker on the Backlog card, defaulted from the Project, recorded on the Ticket
- [x] All six columns render; state changes arrive over SSE
- [x] Promotion appends an audit event carrying repo + provider

## Resolution (2026-07-18)

Migration v2: `repos` table (path, github_remote, target_branch, dormant preview
columns), `projects.default_provider`, `tickets.repo_id`/`provider` (both null until
promotion). Note: the default provider lives on the **Project**, not the Repo — the
AC's phrasing said "repo carries … provider default" but CONTEXT.md and the spec
(story 3: "provider defaulted from the Project") both put it project-side; spec wins.
Providers are the fixed union `claude-code | kiro | copilot` in `types.ts`.

`POST /api/tickets/:id/promote {repoId, provider}` guards: backlog-only (409 via
`StateError`), same-project repo (400 via `ValidationError`), known repo (404),
known provider (400) — all covered black-box in `tests/promotion.test.ts`, including
SSE delivery of the `ticket.updated` column move and the `ticket.promoted` audit
event carrying repo + provider. `GET /api/projects/:id/audit` added so repo
registration (a project-level event) is auditable.

Renderer: empty state shows a project setup form (name + default provider);
topbar lists repos with an add-repo popover; Backlog cards grow a Promote control
(repo select + provider select, defaulted from the project) — no optimistic move,
the card changes column when SSE says so. Cards and the drawer now show provider
and repo. Verified live in the browser end-to-end (register project → repo →
file → promote → drawer shows Repo/Provider + `ticket.promoted` in activity).
