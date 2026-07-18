# 32 — Review wizard, read-only

**What to build:** The six-step review wizard as a centered modal with horizontal stepper (prototype Variant A). All steps render real Run artifacts from the blob store: Visual Recap in a sandboxed iframe (allow-scripts, no same-origin; serving endpoint adds a deny-all CSP), Dogfood Report as rendered markdown, Pull Request (number/URL/mergeable), Documentation & Artifacts (excluding the dogfood report — it has its own step), Manual Walkthrough degraded to "no preview configured" with the ACs as a read-only checklist, Final Verdict as a summary. Chrome — meta header and verification badge row — renders live from ticket/run/git data and gate results, never from agent-authored content. No verdicts yet (slice 33).

**Blocked by:** 30 — Bounce machinery.

**Status:** ready-for-agent

- [ ] Wizard opens from a Human Review card; steps navigable; latest Run is the one read
- [ ] Recap iframe sandboxed exactly per [Recap doc and dogfood report formats](11-recap-dogfood-formats.md); external-resource-free fixture renders, hostile fixture stays contained
- [ ] Meta/badges drawn from DB + gate results live; stale banner only when provably stale (artifact SHA prefix vs branch tip; unknowable → no banner)
- [ ] Steps degrade gracefully: park-by-cap arrival shows an explicit "missing — arrived via bounce cap" placeholder per absent artifact, never a blank panel
- [ ] Human-routed ACs from the plan manifest appear in the Walkthrough checklist
