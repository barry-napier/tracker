# Implement the Hono API and SSE layer

Type: task
Status: closed (superseded)
Blocked by: 12, 17

## Question

Build the localhost Hono server in the main process fronting the orchestrator and store (map Notes stack decision): REST endpoints for projects/repos/tickets/ACs/runs/artifacts/provider config, ticket promotion and verdict actions, and the SSE streams the renderer consumes — ticket state changes, live agent-log event streams (the block-level union with deltas), gate results. The SSE event contract comes from [Board and review wizard UI shape](12-board-review-wizard-ui.md). Done when the API drives a full ticket lifecycle from curl and a subscribed SSE client sees every transition.

Constraint from [Board and review wizard UI shape](12-board-review-wizard-ui.md) (2026-07-18, resolved): two streams — app-wide `GET /api/events` (`ticket.updated`, `run.created`, `run.phase_changed`, `gate.result`, `ac.updated`, `run.ended`, `audit.appended` carrying a monotonic seq for Last-Event-ID resume, `preview.status`) and per-run `GET /api/runs/:runId/log` (`block.open`/`block.delta`/`block.close` over the prompt/thinking/text/tool_call/tool_result union, replay + live). Typed draft: `src/renderer-prototype/events.ts` on branch `prototype/renderer-ui` — treat as the starting contract, refine as implementation demands.

## Superseded (2026-07-18)

Superseded by vertical slices: the API/SSE skeleton is [22](22-headless-skeleton.md); every subsequent slice extends the API alongside its behavior (the spec fixes this as the primary test seam). The SSE contract constraint above carries into 22 and 26.
