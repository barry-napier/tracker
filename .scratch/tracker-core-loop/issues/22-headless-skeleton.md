# 22 — Headless skeleton: file a Ticket from curl

**What to build:** Tracker's main process boots the SQLite store (with migrations) and the localhost Hono API + SSE stream. From curl alone: create a Project and a Ticket with Acceptance Criteria, read them back, and watch a subscribed SSE client see every mutation. No UI in this slice — the API is the primary test seam (per [the spec](21-core-loop-spec.md)) and this slice establishes it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Fresh app-data dir migrates to a working schema; second launch is a no-op (idempotent migrations)
- [ ] Tickets carry immutable `TRK-<n>` display keys allocated per project (ADR-0002)
- [ ] ACs are first-class rows (status pending, origin original) created with the ticket
- [ ] Every mutation appends an Audit Trail event (actor, type, detail); events are never updated or deleted
- [ ] App-wide SSE stream emits `ticket.updated` / `ac.updated` / `audit.appended` with monotonic seq; Last-Event-ID resume replays missed events
- [ ] A curl-level lifecycle test (create → read → mutate → SSE assertions) runs green against real SQLite
