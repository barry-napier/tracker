# 50 — Home recents: remove from list, row menu, and the stray gear

**What to build:** The Home project list gets the management affordances every recents surface converges on (researched 2026-07-20 across VS Code, Zed, JetBrains, GitHub Desktop, and opencode desktop — the design reference). Each row gains a hover-revealed kebab menu (opencode's pattern) with **Reveal in Finder** and **Remove from list**. Remove is *forget, never delete* — the universal semantic: a `hidden_at` flag on the project row, filtered out of `listProjects`; tickets, runs, events, and repos are untouched, and `GET /api/projects/:id` still resolves. Recovery is the add-repo flow: picking a checkout of a hidden project un-hides it instead of duplicating it. Second, the topbar settings gear stops rendering on Home — today it sits there disabled ("open a project to edit its settings"), a dead control on the app's front door; it now renders only with an active project tab.

**Deliberately skipped** (survey says nobody needs them at this scale): clear-all (menu-buried everywhere it exists), pinning (no surveyed app ships it), confirmation on single remove (nobody confirms a forget), delete-key removal.

**Follow-up spawned, not built here:** splitting the app-global Providers section out of ProjectSettings into a real app-settings surface reachable from Home (opencode: settings row in home's utility nav + ⌘,).

**Status:** shipped

- [x] Row kebab reveals on hover/focus; Remove from list hides the project immediately, no confirmation
- [x] Remove is forget-only: no rows deleted; project id still resolves; audit trail intact
- [x] Re-adding a hidden project's checkout (by path or remote) un-hides it and reopens it as the same Project
- [x] Reveal in Finder opens the project's repo folder
- [x] Settings gear absent on Home, present and wired with an active project tab
- [x] Menu and kebab read correctly in both color schemes

**Resolution notes:** Migration 16 adds `projects.hidden_at` (null = visible). `Store.hideProject`/`unhideProject` audit as `project.hidden`/`project.unhidden` per the every-mutation-audits rule — which also makes an un-hidden project surface at the top of recents, where a just-re-added project belongs. `Home.addLocal` clears `hidden_at` on the already-tracked path (both dedupe routes). Routes follow the workflow-archive shape: `POST /api/projects/:id/hide`, `POST /api/projects/:id/reveal` (server-side `open`, macOS-only like `pickFolderNative`; no repo → 409). Renderer: kebab + popover live in `Home.tsx` (`dots-horizontal` icon added to the oc-2 set); App's `useWorkspace` gains `forgetProject` to drop the row from state without a refetch; open tabs of a hidden project survive until closed (hiding is a Home-list concern, not a tab concern) but won't restore after a restart because tab rehydration reads the visible list. Tests: `tests/home.test.ts` "remove from recents".
