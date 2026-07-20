# 48 — Workflow canvas editor

**What to build:** The Lindy-style node-graph editor, opened as a Home view from a library row (same hosting reasoning as the library itself). Canvas renders the Draft: trigger node (fixed, undeletable, unconfigurable), agent-phase nodes, edges with condition labels shown as pills. Editing: add/delete phase nodes, connect/disconnect/relabel edges, node inspector for name, prompt template, `emitsChecks`, and `gateRequirements`. Editor chrome: draft banner, Publish (runs ticket 47's validator; violations render on the offending nodes/edges, not just a toast), Discard with confirm. No Test button, no template gallery (v1 scope cuts from the grill session); the chat builder was un-cut on 2026-07-19 and is ticket 49 — this ticket only leaves room for its panel left of the canvas. oc-2 token language, light/dark via `data-color-scheme`; keep the tab model untouched — the editor is a view inside the Home tab.

**Blocked by:** 46 — engine branch routing; 47 — drafts and publish.

**Status:** ready-for-agent

**Design verdict (2026-07-19, prototype):** Variant A — free canvas with draggable nodes, floating inspector top-right, sticky Publish/Discard chrome — but with **straight** edge lines, not beziers. Additions from prototype iteration: Lindy-style dotted-grid canvas replacing the `.main` card (flatten via the canvas view, dot pattern on `--border-strong`); Stages carry a "N steps" pill and the inspector hosts the Steps drill-in — ordered typed rows (taxonomy: search global/project knowledge, search codebase, web search, perform action, author document), click-through to a per-step title+prompt editor with back navigation, "+ Add step" opens the typed menu. Steps are prompt fragments only (CONTEXT.md Step term; schema in ticket 47, prompt assembly in 46). Prototyped in `src/renderer/WorkflowCanvasPrototype.tsx` (three variants, `/?prototype=canvas&variant=A|B|C`); the prototype lands on a throwaway branch, not main — rebuild properly here.

- [ ] Open RPIRD from the library → its graph renders; making any edit creates the draft and shows the banner; library row shows "unpublished changes"
- [ ] Build a branch on canvas: two labeled edges out of one node, labels editable inline, fan-in draws correctly
- [ ] Publish with violations highlights the offending elements with the validator's messages; a clean publish lands a new head and closes the draft state
- [ ] Discard restores the canvas to the head version after confirm
- [ ] Trigger node cannot be deleted, duplicated, or given an incoming edge
- [ ] Editor reads correctly in both color schemes and matches the Home/library oc-2 look
