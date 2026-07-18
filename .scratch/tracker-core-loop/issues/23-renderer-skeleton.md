# 23 — Renderer skeleton: the board shows what the API knows

**What to build:** The React renderer in the Electron window, talking only HTTP/SSE to the Hono layer (no bespoke IPC). A Backlog column lists Tickets; a create form files a Ticket with ACs; the board updates live from the SSE stream; a slide-over drawer (prototype Variant A shape — see [Board and review wizard UI shape](12-board-review-wizard-ui.md)) shows description, ACs with status dots, and the activity feed rendered from the Audit Trail.

**Blocked by:** 22 — Headless skeleton.

**Status:** done (2026-07-18)

- [x] Creating a ticket in the UI persists through the API and appears without reload (via SSE, not optimistic-only state)
- [x] Ticket detail opens as a right slide-over drawer over the board, not a route change
- [x] Drawer shows description, AC rows (status + origin), and the Audit Trail activity feed
- [x] Board state survives app relaunch (rendered from the store, no fixture data)

## Resolution (2026-07-18)

Vite + React renderer in `src/renderer/` (no react plugin — esbuild's automatic JSX
keeps the strict CSP workable in dev), loaded by Electron from `build/renderer` with
the API base passed as a query param. SSE flows through a tested pure reducer
(`boardState.ts`: idempotent upserts, audit dedupe by event id — `tests/board-state.test.ts`);
the stream opens before the snapshot fetch and buffers, so no event is lost. Hono
gained CORS (renderer origin is `file://` / vite dev). Verified live in the browser
(create → SSE card, drawer, out-of-band PATCH updating card + feed, server restart
persistence) plus an Electron smoke test (embedded server up, renderer SSE connected).
