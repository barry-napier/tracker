# Implement the PreviewManager

Type: task
Status: closed (superseded)
Blocked by: 16

## Question

Build the PreviewManager per [Preview environments](10-preview-environments.md): spawn the repo's preview `command` from the ticket's worktree with `$PORT` injected (preferred port `4000 + ticket n % 1000`, probe upward on conflict, actual port stored on the preview record), TCP-open readiness with optional per-repo HTTP `readiness_path` override and ~60s default timeout, `failed` status with captured stdout/stderr, on-demand start/stop/restart (stop on verdict submit and app quit), and preview-record teardown via the same Done-sweep predicate as the worktree. Two consumer APIs: the orchestrator's demo phase (Playwright `demo.spec` with `baseURL` for `kind: ui`, curl-script transcript for `kind: api`) and the wizard's Manual Walkthrough endpoints. Done when a scratch `ui` repo and a scratch `api` repo each start, report ready, serve, restart, and tear down cleanly, with a port-conflict case falling back correctly.

Constraint from [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) (2026-07-18): the dogfood phase is a third consumer — it boots the ticket's preview to walk its scenario matrix (`browser` journeys for `ui` repos, http for `api`), before the demo phase and the wizard's Manual Walkthrough.

## Superseded (2026-07-18)

Superseded by vertical slices: PreviewManager + walkthrough → [34](34-preview-manager.md); demo recording → [35](35-demo-recording.md); dogfood consumer → [36](36-dogfood-phase.md); record teardown → [42](42-done-sweep.md).
