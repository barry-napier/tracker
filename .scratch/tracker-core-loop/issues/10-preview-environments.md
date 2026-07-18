# Preview environments

Type: grilling
Status: resolved
Assignee: Barry Napier (session 2026-07-18)

## Question

How does Tracker spin up a running app from a ticket's branch so the human can manually walk the acceptance criteria during review? Decide: per-project run configuration (command, port, readiness check — set once per project, since repos are arbitrary but adapters are out of scope), whether the preview runs from the ticket's worktree or a fresh checkout, lifecycle (start from review wizard, stop on verdict), port allocation across concurrent previews, and how the wizard's Manual Walkthrough step links to it.

## Answer

Resolved 2026-07-18 by grilling. The prototype's Previews page (screenshot in session history 2026-07-18: per-ticket rows with repo/URL/port/status/start-delete actions, ticket-number-derived ports, `*.preview.localhost` proxy URLs, standing named environments, Garbage Collect) served as the reference; v1 ships the core and fogs the rest.

- **Source: the ticket's worktree.** The human reviews the exact tree the gates passed on. Local only.
- **Config is per-repo, set at registration**: `command`, `kind: ui | api`, optional `readiness_path`, optional readiness timeout (default ~60s). Tracker injects the bound port as `$PORT`. A repo with no preview config shows "no preview configured" in the wizard; review leans on demo video + curl.
- **Port allocation: deterministic-with-fallback.** Preferred port `4000 + (ticket number % 1000)` (mirrors the prototype's AS-566→4566); probe upward if taken; the actual bound port is stored on the preview record so links are always right.
- **Readiness: TCP-open by default**, per-repo HTTP `readiness_path` override (2xx/3xx) for frameworks that bind early and serve late. Timeout or process exit → status `failed` with captured stdout/stderr surfaced in the wizard.
- **One PreviewManager, two consumers.** (a) During the run, the orchestrator boots the preview and records the demo against it — Playwright `demo.spec` with `baseURL=localhost:<port>` + `recordVideo` for `ui` repos (per the demo-video research), an agent-authored curl script whose transcript is the demo artifact for `api` repos. (b) At Human Review, the wizard's Manual Walkthrough starts/links the same preview.
- **Lifecycle: record follows the worktree; process runs on demand.** The preview record (port, config, status, log pointer) is created at first use and reaped by the same Done-column sweep as the worktree — Garbage Collect *is* the sweep, no separate GC UI in v1. The process starts on demand (demo phase, wizard open), stops on verdict submit and on app quit; re-entering the wizard restarts it.
- **Wizard step shape**: preview status + start/restart, `localhost:<port>` link opening in the **system browser** (no embedded webview), log tail on failure, and the ticket's ACs as the walkthrough checklist; for `api` repos, the curl transcript plus base URL. Step fail requires the mandatory reviewer note → follow-up AC.

**Fogged** (added to the map's Not yet specified): reverse proxy with `*.preview.localhost` hostnames + local HTTPS, standing named environments, a dedicated Previews management page, remote development environments.
