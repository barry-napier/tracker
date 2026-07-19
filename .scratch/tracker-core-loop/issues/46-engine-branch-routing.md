# 46 — Engine branch routing: outcomes pick labeled edges

**What to build:** The interpreter learns the branching the schema always had (ADR-0001), per the extended Phase Contract in CONTEXT.md. A node with labeled outgoing edges gets the available labels passed into its phase through the standard template variable set; the phase must declare `outcome: <label>` in `kb/<phase>.md` frontmatter, and the engine string-matches it to pick the next edge — missing or unrecognized outcome fails the phase with the same teeth as a hollow contract. Nodes with a single unlabeled edge behave exactly as today (no outcome required, none read). Walk stays in `src/server/graph.ts`/engine.ts off the Run's pinned version. Routing is the phase's judgment, never verification (ADR-0003): whatever path ran, the full gate battery still judges the Run.

**Blocked by:** 43 — workflow versions store (done).

**Status:** ready-for-agent

- [ ] Hand-seeded branched graph in tests: phase declaring label A runs A's subtree, label B runs B's; fan-in node runs once
- [ ] Labeled-edge node: labels arrive via template variables; declared outcome recorded on the PhaseExecution
- [ ] Missing outcome, unrecognized outcome, or malformed frontmatter → phase failed (not crashed) with a reason naming the expected labels
- [ ] Single-unlabeled-edge nodes require no outcome and ignore a stray one — RPIRD runs unchanged end-to-end
- [ ] Gate battery runs identically regardless of which path executed
