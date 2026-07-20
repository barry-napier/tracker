# 45 — Workflow selection: clone-flow picker and project settings

**What to build:** The two places a Project's workflow gets chosen (grill session Q4/Q8). One shared picker component listing active (non-archived) workflows with the current/default selection preselected. First: the Home clone flow gains the picker step with the Default Workflow preselected — happy path stays one click. Second: the topbar settings gear (currently an unwired placeholder in App.tsx) gets wired; with a project tab active it opens project settings, whose first section is the workflow picker. A project currently on an archived workflow still shows that selection, labeled archived — the picker just won't offer archived options as new choices. Changing the selection takes effect at the next claim (Runs pin versions; ticket 43) and emits no audit event.

**Design reference:** Prototype A (`src/renderer/WorkflowCanvasPrototype.tsx`, `/?prototype=canvas&variant=A`) — the workflow-builder design verdict; full verdict recorded in ticket 48.

**Blocked by:** 43 — workflow versions store.

**Status:** in-review — settings surface done; add-flow picker blocked on the Home add-local rework

- [ ] Clone flow shows the picker with the default preselected; cloning without touching it assigns the Default Workflow — *second half holds and is tested (creation falls back to the default, ticket 43); the picker step itself waits for the in-flight Home add-local rework to land, then drops in as `WorkflowPicker`*
- [x] Settings gear opens project settings for the active project tab; workflow section shows the current selection
- [x] Picker lists active workflows only; a project sitting on an archived workflow displays it with an archived label
- [x] Changing the selection affects the next claim only — a running Run finishes on its pinned version (endpoint-level test)
- [x] Both surfaces use the same picker component and read correctly in both color schemes — *the shared component (`ProjectSettings.tsx` exports `WorkflowPicker`) drives settings today; the add-project flow reuses it when it lands*

**Resolution notes (partial):** Gear is disabled with no project tab; with one it opens `ProjectSettings`, which fetches the live project row (the cached tab row can be stale) plus the library, and applies picks immediately via `PATCH /api/projects/:id` — forward-acting, no audit event, with rollback on error. An archived current selection renders checked + "Archived" and is inert as a new choice. The next-claim-only behavior is `tests/workflow-library.test.ts` ("mid-flight selection change"). Verified live in both color schemes.
