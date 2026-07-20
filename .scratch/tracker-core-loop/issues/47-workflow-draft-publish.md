# 47 — Workflow drafts, publish validation, versions appended

**What to build:** The mutable editing layer over ADR-0004's immutable versions, per the Draft language in CONTEXT.md. Each workflow has at most one Draft — created from the head version on first edit, invisible to claims, discardable. Publish runs the validator and appends the Draft as the new immutable head; Projects following the workflow pick it up at their next claim. The validator enforces: exactly one fixed "ticket claimed" trigger; every node reachable; per-node edges all-or-nothing (one unlabeled, or ≥2 uniquely-labeled — no mixing, no default edge); every trigger-to-terminal path contains ≥1 check-emitting node; unique node names; non-empty prompt templates on agent phases; acyclic (ADR-0005). Stages own ordered, typed Steps (CONTEXT.md: prompt fragments, never runtime machinery) — versioned content like nodes/edges (`workflow_steps`: stage node, position, type, title, prompt). Store ops + routes: get-or-create draft, mutate draft graph (nodes/edges/steps/node fields: name, prompt, `emitsChecks`, `gateRequirements`), validate (returns the full violation list, not first-failure), publish, discard. Library listing gains an "unpublished changes" flag.

**Design reference:** Prototype A (`src/renderer/WorkflowCanvasPrototype.tsx`, `/?prototype=canvas&variant=A`) — source of the Steps taxonomy behind `workflow_steps`; full verdict recorded in ticket 48.

**Blocked by:** 43 — workflow versions store (done).

**Status:** ready-for-agent

- [ ] Draft is invisible to claims: a claim during editing pins the head version, never draft content
- [ ] Publish appends a version atomically; the previous head and all pinned Runs are untouched; discard leaves head identical
- [ ] Validator rejects each rule individually with a per-violation message (cycle, orphan, mixed edges, duplicate labels, uncovered path, duplicate names, empty prompt, missing/multiple triggers) and accepts RPIRD's graph
- [ ] Path-coverage rule proven both ways: a branch bypassing every check-emitting node fails; adding `emitsChecks` on the bypass path passes
- [ ] Re-opening the editor resumes the existing draft; publish and discard both clear it
