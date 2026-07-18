# 24 — Promote to Todo across the full six-column board

**What to build:** Register a Project with one or more Repos (local path, GitHub remote, target branch — preview config fields exist but are unused until slice 34). The board shows all six columns (Backlog → Todo → In Progress → Verifying → Human Review → Done). Promoting a Backlog Ticket means picking its target Repo and provider (defaulted from the Project) directly on the card; the Ticket moves to Todo with repo and provider set, and the promotion lands in the Audit Trail and on the SSE stream.

**Blocked by:** 23 — Renderer skeleton.

**Status:** ready-for-agent

- [ ] Project/Repo registration via API + minimal UI; repo carries path, remote, target branch, provider default
- [ ] Ticket `repo_id` is null until promotion; promotion requires exactly one Repo (one Ticket = one branch = one PR)
- [ ] Provider picker on the Backlog card, defaulted from the Project, recorded on the Ticket
- [ ] All six columns render; state changes arrive over SSE
- [ ] Promotion appends an audit event carrying repo + provider
