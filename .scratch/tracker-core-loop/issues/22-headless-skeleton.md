# 22 — Headless skeleton: file a Ticket from curl

**What to build:** Tracker's main process boots the SQLite store (with migrations) and the localhost Hono API + SSE stream. From curl alone: create a Project and a Ticket with Acceptance Criteria, read them back, and watch a subscribed SSE client see every mutation. No UI in this slice — the API is the primary test seam (per [the spec](21-core-loop-spec.md)) and this slice establishes it.

**Blocked by:** None — can start immediately.

**Status:** done (2026-07-18)

- [x] Fresh app-data dir migrates to a working schema; second launch is a no-op (idempotent migrations)
- [x] Tickets carry immutable `TRK-<n>` display keys allocated per project (ADR-0002)
- [x] ACs are first-class rows (status pending, origin original) created with the ticket
- [x] Every mutation appends an Audit Trail event (actor, type, detail); events are never updated or deleted
- [x] App-wide SSE stream emits `ticket.updated` / `ac.updated` / `audit.appended` with monotonic seq; Last-Event-ID resume replays missed events
- [x] A curl-level lifecycle test (create → read → mutate → SSE assertions) runs green against real SQLite

Resolution notes (2026-07-18): server lives in `src/server/` (db/migrations, store, event bus, Hono app), started by the Electron main (`src/main.ts`, compiled via `tsc` to `build/`) on `app.getPath('userData')`, port `TRACKER_PORT` ?? 4400. SQLite via `node:sqlite` (`DatabaseSync`) — no native module, works in Node 24 and Electron 37; verified by booting Electron and driving the API with curl. SSE resume is in-process (seq resets on relaunch — buffer-backed Last-Event-ID, cap 5000). Tests: `tests/lifecycle.test.ts` at the HTTP seam per the spec.
