# 23 — Renderer skeleton: the board shows what the API knows

**What to build:** The React renderer in the Electron window, talking only HTTP/SSE to the Hono layer (no bespoke IPC). A Backlog column lists Tickets; a create form files a Ticket with ACs; the board updates live from the SSE stream; a slide-over drawer (prototype Variant A shape — see [Board and review wizard UI shape](12-board-review-wizard-ui.md)) shows description, ACs with status dots, and the activity feed rendered from the Audit Trail.

**Blocked by:** 22 — Headless skeleton.

**Status:** ready-for-agent

- [ ] Creating a ticket in the UI persists through the API and appears without reload (via SSE, not optimistic-only state)
- [ ] Ticket detail opens as a right slide-over drawer over the board, not a route change
- [ ] Drawer shows description, AC rows (status + origin), and the Audit Trail activity feed
- [ ] Board state survives app relaunch (rendered from the store, no fixture data)
