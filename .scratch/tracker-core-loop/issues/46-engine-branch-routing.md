# 46 — Engine branch routing: outcomes pick labeled edges

**What to build:** The interpreter learns the branching the schema always had (ADR-0001), per the extended Phase Contract in CONTEXT.md. A node with labeled outgoing edges gets the available labels passed into its phase through the standard template variable set; the phase must declare `outcome: <label>` in `kb/<phase>.md` frontmatter, and the engine string-matches it to pick the next edge — missing or unrecognized outcome fails the phase with the same teeth as a hollow contract. Nodes with a single unlabeled edge behave exactly as today (no outcome required, none read). Walk stays in `src/server/graph.ts`/engine.ts off the Run's pinned version. Stage prompt assembly: a stage's ordered Steps (typed prompt fragments, ticket 47 schema) are concatenated into the single session prompt after the stage's own template — steps never spawn sessions or orchestrator calls. Routing is the phase's judgment, never verification (ADR-0003): whatever path ran, the full gate battery still judges the Run.

**Design reference:** Prototype A (`src/renderer/WorkflowCanvasPrototype.tsx`, `/?prototype=canvas&variant=A`) — source of the Steps taxonomy this ticket's prompt assembly consumes; full verdict recorded in ticket 48.

**Blocked by:** 43 — workflow versions store (done).

**Status:** done

- [x] Hand-seeded branched graph in tests: phase declaring label A runs A's subtree, label B runs B's; fan-in node runs once
- [x] Labeled-edge node: labels arrive via template variables; declared outcome recorded on the PhaseExecution
- [x] Missing outcome, unrecognized outcome, or malformed frontmatter → phase failed (not crashed) with a reason naming the expected labels
- [x] Single-unlabeled-edge nodes require no outcome and ignore a stray one — RPIRD runs unchanged end-to-end
- [x] Gate battery runs identically regardless of which path executed

**Resolution notes:** Graph walk gained `branchLabels()` + `nextNodeByLabel()` in `src/server/graph.ts`; the engine loop (`engine.ts`) follows the single unlabeled edge for non-branch nodes and routes by the phase's declared outcome for branch nodes. A branch node's phase gets its edge labels via the new `{{outcomes}}` template variable ("none" for single-edge nodes) and must declare `outcome: <label>` in its `kb/<phase>.md` frontmatter — parsed by `readContractOutcome()`, string-matched to an edge, and recorded on the PhaseExecution (migration 14 adds `phase_executions.outcome`; `endPhase` writes it). Missing/unrecognized/malformed → `PhaseFailedError` naming the expected labels (same teeth as a hollow contract), and nothing past the failed branch runs. AC5 is structural: every gate reads the pinned graph's *full* node set (`#artifact`/`#owesDogfood`) and Run/ticket facts, never which nodes executed — proven by running the same branched workflow down each path and asserting byte-identical gate statuses. The Steps prompt-assembly the prose mentions is deferred to ticket 47 (its schema); this slice is routing only. Tests: `tests/workflow-branch.test.ts`.
