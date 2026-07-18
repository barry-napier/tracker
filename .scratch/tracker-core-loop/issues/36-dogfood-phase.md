# 36 — Dogfood phase

**What to build:** The seed workflow's fourth node behaves as the real dogfood phase per [Recap doc and dogfood report formats](11-recap-dogfood-formats.md): a fresh session boots the ticket's preview via PreviewManager, derives a scenario Matrix from the diff + ACs (`browser` journeys for `ui` repos, http for `api`), walks it, and may fix under the governor (2/scenario, 4/run; every fix recorded as fix SHA + regression test; over cap → scenario stays failed honestly). Emits the Dogfood Report (five sections from the vendored template) and the machine-readable results file against the vendored matrix schema. Persona is optional per-Repo config — absence stated honestly, never faked. Prototype prompt assets (recap authoring spec, dogfood SKILL/template/governor, matrix schema) are vendored and adapted for Tracker.

**Blocked by:** 34 — PreviewManager.

**Status:** ready-for-agent

- [ ] Dogfood phase boots the preview and receives the vendored prompt assets through the standard template variable set
- [ ] Report + results file land as Run artifacts; results conform to the vendored schema (scenarios with flow_ref → AC ids, kind, branch, status, fix, cut log)
- [ ] Governor caps prompt-enforced; fixes carry SHA + regression test in the Matrix
- [ ] Persona configured → lens applied; absent → report says the experiential judge was skipped
- [ ] An honest red report still completes the phase (contract + artifacts exist) — teeth belong to the gate (slice 37)
