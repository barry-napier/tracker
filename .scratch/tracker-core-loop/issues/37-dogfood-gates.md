# 37 — Dogfood gates and the Decisions-for-a-human surface

**What to build:** The battery grows its dogfood teeth: `artifact` includes the dogfood artifacts per node gate requirements; `artifact-lint` validates the results file against the vendored schema with ≥ 1 scenario (report stays existence-only — the template enforces structure through the prompt); the `dogfood-green` gate requires every scenario ∈ {pass, fixed, waived}, each failing row emitting one follow-up AC through the standard bounce machinery. A non-empty "Decisions for a human" never gates — the wizard's Dogfood step surfaces each entry (observed behavior, options with costs, recommendation) for the reviewer to answer, and the answer lands in the Audit Trail.

**Blocked by:** 36 — Dogfood phase.

**Status:** done (2026-07-19)

- [x] `dogfood-green` pass/fail/waive semantics proven with scripted results fixtures; failing rows → follow-up ACs; bounce carries them with the batch
- [x] Schema-invalid or scenario-empty results fail `artifact-lint`
- [x] Open human decisions do not bounce; they render in the Dogfood step with an answer input; answers audited
- [x] Full loop demo: dogfood finds a failure → bounce → next Run fixes → `dogfood-green` passes → Human Review

Landed as migration 13 (dogfood node owes `kb/dogfood-report.md` + `kb/dogfood-results.json` via `gate_requirements`, driving the existence `artifact` gate). `artifact-lint` grew a dogfood arm (`lintDogfoodResults` in `src/server/dogfood.ts`) validating the results file against the vendored matrix schema with ≥ 1 scenario — the report stays existence-only. New `dogfood-green` gate (`evaluateDogfoodGreen`): every scenario ∈ {pass, fixed, waived} or it fails, fact-driven skip when the workflow owes no dogfood results; each un-green row becomes one follow-up AC in `bounce.ts` (`followUpSeeds`), all riding one batch. `decisions[]` added to `MATRIX_SCHEMA`; the wizard's Dogfood step reads them from the results artifact and posts answers to `POST /api/tickets/:id/dogfood-decisions` → `store.answerDogfoodDecision` → a `dogfood.decision_answered` human audit event. Decisions never gate.
