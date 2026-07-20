# 44 — Workflow library view on Home

**What to build:** The app-global Workflows surface, hosted as a view within Home (CONTEXT.md: Home hosts the workflow library; grill session Q7). Lindy-style list on the oc-2 token language, light/dark via `data-color-scheme`: each row shows name (default badge on the Default Workflow), a phase-names preview line from the head version, used-by-N-projects, and archived state as an enabled-style toggle. Row actions: duplicate, rename (inline), archive/unarchive, set default — archiving the default routes through the pick-a-successor flow in one dialog. Archived rows stay visible in the list (dimmed / behind a filter), since archive is reversible and "in use by N" still matters. No graph editing anywhere — creation is duplicate-only until the editor ticket (grill session Q6).

**Design reference:** Prototype A (`src/renderer/WorkflowCanvasPrototype.tsx`, `/?prototype=canvas&variant=A`) — the workflow-builder design verdict; full verdict recorded in ticket 48.

**Blocked by:** 43 — workflow versions store.

**Status:** done

- [x] Home offers navigation between Recent Projects and Workflows without touching the tab model (tabs remain project-ids-only)
- [x] List renders live data: names, default badge, phase preview, used-by counts, archived state
- [x] Duplicate creates "X (copy)" and it appears immediately; rename edits identity only
- [x] Archive toggle hides the workflow from selection surfaces but keeps the row (and its projects) working; unarchive restores it
- [x] Archiving the default forces choosing a successor in the same dialog; cancel leaves both untouched
- [x] View is correct in both color schemes and matches the oc-2 look of Home

**Resolution notes:** `WorkflowLibrary.tsx` is fully self-contained (fetches `/api/workflows`, refetches after every action since default/archive move flags across rows). The Home↔Workflows switch lives in App.tsx as pure view state (`homeView`) with a bottom-center segmented `home-nav` — Home.tsx untouched, tab model untouched. Row actions surface on hover (plus `:focus-visible`); the archived state is a `role="switch"` toggle; archiving the default routes through `SuccessorDialog` client-side instead of letting the server 409. Styles are the `wf-*` section appended to styles.css, tokens only. Verified live against the migrated dev DB in both schemes; behavior ACs (atomic handover, duplicate independence) are covered by `tests/workflow-library.test.ts` from ticket 43.
