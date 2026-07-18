# Implement the orchestrator: workers, workflow interpreter, gate battery

Type: task
Status: closed (superseded)
Blocked by: 14, 15, 16, 20

## Question

Build the factory core per [Workflow engine design](07-workflow-engine.md) and [Evidence gate battery v1](06-evidence-gate-battery.md), in Electron's main process: 3-worker pool with claim loop (claim = Run row), the dumb interpreter over the stored workflow graph, fresh provider session per phase with `kb/<phase>.md` Phase Contract enforcement, plan-phase `checks/` manifest validation, orchestrator-executed gate battery (run everything, batch failures), Bounce Report rendering, bounce/crash policy (retry phase once → crashed → Todo; 3 crashes or 3 bounces park in Human Review), startup orphan sweep, per-phase wall-clock timeout, audit-trail events for every transition. Done when a fake-provider run walks the seeded workflow end-to-end through gates and a bounce.

Constraint from [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) (2026-07-18): the seeded workflow is research → plan → implement → **dogfood** → document (review node renamed; dogfood phase boots the preview, walks diff+AC-derived journeys, fixes under governor caps 2/scenario 4/run with fix SHA + regression test in the matrix, emits `dogfood-report.md` + `dogfood-results.json`). Vendor the prototype's prompt assets (recap authoring spec, dogfood SKILL/template/governor, `matrix.schema.json`) adapted for Tracker. Gate implementations: `artifact` = existence per node gate-requirements; `artifact-lint` = ported `lintRecap` (external-resource + "What to review" hard rules, strip warning) + schema-validate `dogfood-results.json` (≥1 scenario); `dogfood-green` = every scenario ∈ {pass, fixed, waived}, one follow-up AC per failing row; non-empty "Decisions for a human" never gates. At the end of every run (pass/bounce/crash) persist `kb/*` to `<app-data>/artifacts/<run-id>/` with artifact rows recording the worktree HEAD SHA.

## Superseded (2026-07-18)

Superseded by vertical slices: interpreter + Phase Contract → [26](26-fakeprovider-one-phase.md)/[27](27-full-seeded-workflow.md); AC checks → [28](28-plan-emits-ac-checks.md); gate battery → [29](29-gate-battery.md); bounce → [30](30-bounce-machinery.md); dogfood → [36](36-dogfood-phase.md)/[37](37-dogfood-gates.md); crash policy → [41](41-crash-policy-sweeps.md).
