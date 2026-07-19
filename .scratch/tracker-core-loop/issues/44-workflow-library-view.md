# 44 — Workflow library view on Home

**What to build:** The app-global Workflows surface, hosted as a view within Home (CONTEXT.md: Home hosts the workflow library; grill session Q7). Lindy-style list on the oc-2 token language, light/dark via `data-color-scheme`: each row shows name (default badge on the Default Workflow), a phase-names preview line from the head version, used-by-N-projects, and archived state as an enabled-style toggle. Row actions: duplicate, rename (inline), archive/unarchive, set default — archiving the default routes through the pick-a-successor flow in one dialog. Archived rows stay visible in the list (dimmed / behind a filter), since archive is reversible and "in use by N" still matters. No graph editing anywhere — creation is duplicate-only until the editor ticket (grill session Q6).

**Blocked by:** 43 — workflow versions store.

**Status:** ready-for-agent

- [ ] Home offers navigation between Recent Projects and Workflows without touching the tab model (tabs remain project-ids-only)
- [ ] List renders live data: names, default badge, phase preview, used-by counts, archived state
- [ ] Duplicate creates "X (copy)" and it appears immediately; rename edits identity only
- [ ] Archive toggle hides the workflow from selection surfaces but keeps the row (and its projects) working; unarchive restores it
- [ ] Archiving the default forces choosing a successor in the same dialog; cancel leaves both untouched
- [ ] View is correct in both color schemes and matches the oc-2 look of Home
