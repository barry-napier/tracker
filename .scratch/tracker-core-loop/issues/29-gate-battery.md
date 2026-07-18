# 29 — Gate battery at Verifying

**What to build:** The orchestrator-executed Evidence Gate battery per [Evidence gate battery v1](06-evidence-gate-battery.md): `artifact` (per node gate requirements), `artifact-lint` (recap lint rules: external resources + missing "What to review" hard-fail), `branch-recorded`, `suite`, `pr-fresh`, `demo-fresh`, plus every AC check (orchestrator runs each script in the worktree; exit 0 → AC verified with machine provenance). GitHub-flavored gates go through the GitHubPort with its test backing (local bare "remote" + in-memory PR state). The battery is diagnostic — everything runs even after a failure. All gates green → Human Review.

**Blocked by:** 28 — Plan phase emits AC checks.

**Status:** ready-for-agent

- [ ] Battery runs at Verifying; every gate + AC check executes even after the first failure; each result is a gate-result row (pass/fail/skip + detail, AC checks linked to their AC row)
- [ ] Skips are fact-driven only (`demo-fresh` by ticket type from the branch prefix; `suite` when no test command configured) and render as "n/a", never green
- [ ] AC check pass sets the AC verified with provenance; fail sets it failed — results cannot be agent-reported
- [ ] GitHubPort seam exists with test backing; `branch-recorded`/`pr-fresh` evaluated against it
- [ ] Waived ACs skip their checks; waiving (human-only, mandatory reason) is exposed on ticket detail in any state
- [ ] Full pass moves the Ticket to Human Review; failures are recorded and visible (bounce lands in slice 30); gate results stream over SSE
