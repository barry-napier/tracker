# 31 — GitHub for real: push, PR, freshness, merge

**What to build:** The GitHubPort's production backing via `gh`. A run pushes its branch and opens a real PR on the Ticket's Repo (the agent's job in production; the FakeProvider script exercises it here against a scratch GitHub repo). `branch-recorded`, `pr-fresh`, and mergeability evaluate for real. A verdict action at the API level merges the PR and moves the Ticket to Done (the wizard UI for verdicts is slice 33).

**Blocked by:** 29 — Gate battery.

**Status:** done (2026-07-19)

- [x] One GitHubPort seam covers branch-recorded / pr-fresh / mergeability / PR create + merge; production = `gh`, tests = local bare remote + in-memory PR state (spec's seam decision)
- [x] PR number/URL recorded on the Ticket (branch and PR belong to the Ticket, stable across bounces)
- [x] `pr-fresh` = PR head SHA == branch tip; `branch-recorded` = branch on the remote and recorded on the ticket — both proven against a real scratch GitHub repo
- [x] Done merge goes through the port; merged state and audit event verifiable from the API
- [x] Lifecycle test runs green with the test backing; the real-`gh` path exercised once against a scratch repo and recorded in the ticket resolution

**Resolution notes (2026-07-19):** The port grew `createPr` / `mergeability` / `mergePr` alongside the existing reads; production backing is `GhGitHub` (`gh` CLI, squash merge — one ticket = one PR = one commit on the target), now `startServer`'s default, with tests pinned to explicit backings via server-helpers. The PR is recorded on the Ticket by the *orchestrator* when the `pr-fresh` gate observes it on the remote (`pr.recorded` audit, idempotent across battery cycles) — never self-reported. The verdict action is `POST /api/tickets/:id/verdict` `{outcome: "pass"}`: guards (Human Review state, every AC verified/waived, PR recorded, no conflicts) all run before the port merge, then `verdict.recorded` + `ticket.merged` audits land with the Done transition; fail verdicts are refused until slice 33. Test backing upgraded per the seam decision: FakeGitHub keys each remote to a local repo standing in for GitHub's copy — branches are real pushed refs, PR head SHAs resolve live (a push moves the PR head, as on GitHub), `mergePr` performs a real merge — while PR state stays in memory. Real-`gh` proof: `scripts/prove-github-port.ts` ran 2026-07-19 against scratch repo `barry-napier/tracker-gh-proof` — all nine checks passed (pushed branch exists / unpushed doesn't / no PR before create / create returns [PR #1](https://github.com/barry-napier/tracker-gh-proof/pull/1) / findPr finds it / head SHA `cd03f52` == branch tip / mergeability `mergeable` / merged state `MERGED` / merged PR no longer open). The scratch repo could not self-delete (token lacks `delete_repo`); flagged for manual cleanup.
