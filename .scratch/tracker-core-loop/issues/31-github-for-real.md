# 31 — GitHub for real: push, PR, freshness, merge

**What to build:** The GitHubPort's production backing via `gh`. A run pushes its branch and opens a real PR on the Ticket's Repo (the agent's job in production; the FakeProvider script exercises it here against a scratch GitHub repo). `branch-recorded`, `pr-fresh`, and mergeability evaluate for real. A verdict action at the API level merges the PR and moves the Ticket to Done (the wizard UI for verdicts is slice 33).

**Blocked by:** 29 — Gate battery.

**Status:** ready-for-agent

- [ ] One GitHubPort seam covers branch-recorded / pr-fresh / mergeability / PR create + merge; production = `gh`, tests = local bare remote + in-memory PR state (spec's seam decision)
- [ ] PR number/URL recorded on the Ticket (branch and PR belong to the Ticket, stable across bounces)
- [ ] `pr-fresh` = PR head SHA == branch tip; `branch-recorded` = branch on the remote and recorded on the ticket — both proven against a real scratch GitHub repo
- [ ] Done merge goes through the port; merged state and audit event verifiable from the API
- [ ] Lifecycle test runs green with the test backing; the real-`gh` path exercised once against a scratch repo and recorded in the ticket resolution
