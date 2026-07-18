# 37 — Dogfood gates and the Decisions-for-a-human surface

**What to build:** The battery grows its dogfood teeth: `artifact` includes the dogfood artifacts per node gate requirements; `artifact-lint` validates the results file against the vendored schema with ≥ 1 scenario (report stays existence-only — the template enforces structure through the prompt); the `dogfood-green` gate requires every scenario ∈ {pass, fixed, waived}, each failing row emitting one follow-up AC through the standard bounce machinery. A non-empty "Decisions for a human" never gates — the wizard's Dogfood step surfaces each entry (observed behavior, options with costs, recommendation) for the reviewer to answer, and the answer lands in the Audit Trail.

**Blocked by:** 36 — Dogfood phase.

**Status:** ready-for-agent

- [ ] `dogfood-green` pass/fail/waive semantics proven with scripted results fixtures; failing rows → follow-up ACs; bounce carries them with the batch
- [ ] Schema-invalid or scenario-empty results fail `artifact-lint`
- [ ] Open human decisions do not bounce; they render in the Dogfood step with an answer input; answers audited
- [ ] Full loop demo: dogfood finds a failure → bounce → next Run fixes → `dogfood-green` passes → Human Review
