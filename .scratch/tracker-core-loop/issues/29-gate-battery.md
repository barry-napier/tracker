# 29 — Gate battery at Verifying

**What to build:** The orchestrator-executed Evidence Gate battery per [Evidence gate battery v1](06-evidence-gate-battery.md): `artifact` (per node gate requirements), `artifact-lint` (recap lint rules: external resources + missing "What to review" hard-fail), `branch-recorded`, `suite`, `pr-fresh`, `demo-fresh`, plus every AC check (orchestrator runs each script in the worktree; exit 0 → AC verified with machine provenance). GitHub-flavored gates go through the GitHubPort with its test backing (local bare "remote" + in-memory PR state). The battery is diagnostic — everything runs even after a failure. All gates green → Human Review.

**Blocked by:** 28 — Plan phase emits AC checks.

**Status:** done (2026-07-18)

- [x] Battery runs at Verifying; every gate + AC check executes even after the first failure; each result is a gate-result row (pass/fail/skip + detail, AC checks linked to their AC row)
- [x] Skips are fact-driven only (`demo-fresh` by ticket type from the branch prefix; `suite` when no test command configured) and render as "n/a", never green
- [x] AC check pass sets the AC verified with provenance; fail sets it failed — results cannot be agent-reported
- [x] GitHubPort seam exists with test backing; `branch-recorded`/`pr-fresh` evaluated against it
- [x] Waived ACs skip their checks; waiving (human-only, mandatory reason) is exposed on ticket detail in any state
- [x] Full pass moves the Ticket to Human Review; failures are recorded and visible (bounce lands in slice 30); gate results stream over SSE

## Resolution (2026-07-18)

`GateBattery` (src/server/gates.ts) runs inside the worker slot after a completed run: six gates + AC checks, diagnostic, each result a `gate_results` row streamed as `gate.result` (plus an enriched `run.updated` so board state — where live events outrank snapshot fetches — never shows stale gates). All green → Human Review via `concludeVerification`; failures audit as `gates.failed` and the ticket stays in Verifying for slice 30's bounce. Decisions and deferrals:

- **`demo-fresh` also skips when the repo has no preview config** — grounded in CONTEXT.md's skip facts ("ticket type, repo config"): no preview → no demo owed. With a preview configured and no recorder yet, it fails honestly (recorder lands in slice 35).
- **`artifact` reads node `gate_requirements`** (document node owes `kb/recap.html`; seeded template extended to author it). ADR-0003 amended: the column records what nodes owe; the battery alone judges. Dogfood artifacts join in slice 37.
- **GitHubPort test backing is in-memory only** (`tests/github-fake.ts`); the local-bare-remote + real `gh` backing is slice 31's stated deliverable. Until then the dev app uses `NullGitHub`, so `branch-recorded`/`pr-fresh` fail honestly rather than skip.
- **Follow-up for domain modeling:** gate audit events carry `actor: "agent"` because the Audit Trail's actor union is `human | agent` and all orchestrator-side events already use `agent`; if the trust story wants a distinct `orchestrator` actor, that's a CONTEXT.md/ticket-05 amendment, not a battery change.
