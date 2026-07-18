# 34 — PreviewManager and the live Manual Walkthrough

**What to build:** The PreviewManager per [Preview environments](10-preview-environments.md): per-Repo preview config (`command`, `kind: ui|api`, optional readiness path/timeout), spawn from the ticket's worktree with `$PORT` injected, deterministic port (`4000 + n % 1000`, probe up, actual port stored), TCP-open readiness with HTTP override, failure captures stdout/stderr. The wizard's Manual Walkthrough goes live: preview status, start/restart, `localhost:<port>` link opening in the system browser, log tail on failure; curl transcript + base URL presentation for `api` repos.

**Blocked by:** 32 — Wizard read-only.

**Status:** ready-for-agent

- [ ] Scratch `ui` and scratch `api` repo each: start, report ready, serve, restart, stop cleanly; port-conflict case falls back and stores the actual port
- [ ] Readiness timeout or process exit → `failed` with captured output surfaced in the wizard
- [ ] Process starts on demand (wizard open), stops on verdict submit and app quit; re-entering the wizard restarts it
- [ ] Preview record (port, status, log pointer) created at first use, keyed to the ticket
- [ ] Repo without preview config still shows the graceful degraded step
