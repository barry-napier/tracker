# 45 — Workflow selection: clone-flow picker and project settings

**What to build:** The two places a Project's workflow gets chosen (grill session Q4/Q8). One shared picker component listing active (non-archived) workflows with the current/default selection preselected. First: the Home clone flow gains the picker step with the Default Workflow preselected — happy path stays one click. Second: the topbar settings gear (currently an unwired placeholder in App.tsx) gets wired; with a project tab active it opens project settings, whose first section is the workflow picker. A project currently on an archived workflow still shows that selection, labeled archived — the picker just won't offer archived options as new choices. Changing the selection takes effect at the next claim (Runs pin versions; ticket 43) and emits no audit event.

**Blocked by:** 43 — workflow versions store.

**Status:** ready-for-agent

- [ ] Clone flow shows the picker with the default preselected; cloning without touching it assigns the Default Workflow
- [ ] Settings gear opens project settings for the active project tab; workflow section shows the current selection
- [ ] Picker lists active workflows only; a project sitting on an archived workflow displays it with an archived label
- [ ] Changing the selection affects the next claim only — a running Run finishes on its pinned version (endpoint-level test)
- [ ] Both surfaces use the same picker component and read correctly in both color schemes
