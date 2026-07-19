# 48 — Workflow canvas editor

**What to build:** The Lindy-style node-graph editor, opened as a Home view from a library row (same hosting reasoning as the library itself). Canvas renders the Draft: trigger node (fixed, undeletable, unconfigurable), agent-phase nodes, edges with condition labels shown as pills. Editing: add/delete phase nodes, connect/disconnect/relabel edges, node inspector for name, prompt template, `emitsChecks`, and `gateRequirements`. Editor chrome: draft banner, Publish (runs ticket 47's validator; violations render on the offending nodes/edges, not just a toast), Discard with confirm. No chat builder, no Test button, no template gallery (v1 scope cuts from the grill session). oc-2 token language, light/dark via `data-color-scheme`; keep the tab model untouched — the editor is a view inside the Home tab.

**Blocked by:** 46 — engine branch routing; 47 — drafts and publish.

**Status:** ready-for-agent

- [ ] Open RPIRD from the library → its graph renders; making any edit creates the draft and shows the banner; library row shows "unpublished changes"
- [ ] Build a branch on canvas: two labeled edges out of one node, labels editable inline, fan-in draws correctly
- [ ] Publish with violations highlights the offending elements with the validator's messages; a clean publish lands a new head and closes the draft state
- [ ] Discard restores the canvas to the head version after confirm
- [ ] Trigger node cannot be deleted, duplicated, or given an incoming edge
- [ ] Editor reads correctly in both color schemes and matches the Home/library oc-2 look
