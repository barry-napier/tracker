# Implement the renderer: board, ticket detail, review wizard

Type: task
Status: closed (superseded)
Blocked by: 12, 18

## Question

Shape decided (2026-07-18): Variant A "Kanban classic" from branch `prototype/renderer-ui` — six-column board, ticket detail as a right slide-over drawer (not a route), review wizard as a centered modal with horizontal stepper; wizard step content as one shared component set; phase bar on in-progress cards; provider picker on the Backlog card for promotion. Reference the branch, don't port the code.

Build the React renderer per the shape resolved in [Board and review wizard UI shape](12-board-review-wizard-ui.md), talking HTTP/SSE to the Hono layer: six-column board with create/promote (provider picked at promotion, defaulted from project), ticket detail (description, ACs, audit-trail feed, artifacts, properties incl. provider picker, live agent logs showing the full prompt/thinking/tool conversation), and the review wizard (all six steps, pass/fail/skip, mandatory reviewer note on fail feeding follow-up ACs and the Bounce Report, verdict actions incl. merge via Done). Done when the loop is drivable entirely from the UI against the real API.

## Superseded (2026-07-18)

Superseded by vertical slices: renderer skeleton → [23](23-renderer-skeleton.md); full board + promotion → [24](24-promote-full-board.md); wizard → [32](32-wizard-read-only.md)/[33](33-wizard-verdicts.md); live logs land with [26](26-fakeprovider-one-phase.md).
