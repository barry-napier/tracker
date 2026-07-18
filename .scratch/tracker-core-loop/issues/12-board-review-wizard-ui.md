# Board and review wizard UI shape

Type: prototype
Status: closed
Assignee: bnapier
Blocked by: 06, 11

## Question

What is the minimal renderer UI for the core loop, and on what framework? Scope: the six-column board (create ticket in Backlog, drag/promote to Todo, watch state changes), ticket detail (description, activity ledger, artifacts, properties incl. provider picker, agent logs), and the review wizard (steps: Visual Recap, Dogfood Report, Pull Request, Documentation & Artifacts, Manual Walkthrough w/ preview env + demo video, Final Verdict; pass/fail/skip per step; fail emits follow-up criteria and bounces the ticket). The prototype screenshots are the reference spec.

Constraint from [Preview environments](10-preview-environments.md) (2026-07-18): the Manual Walkthrough step's shape is decided — preview status + start/restart, `localhost:<port>` link opening in the system browser (no embedded webview), log tail on failure, ACs as the walkthrough checklist; curl transcript + base URL for `api` repos. Prototype the chrome around it, not the decision.

Constraint from [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) (2026-07-18): the Visual Recap step renders agent-authored self-contained HTML in a sandboxed iframe (`allow-scripts`, no same-origin; serving endpoint adds CSP `default-src 'none'` defense-in-depth); the Dogfood step renders `dogfood-report.md` as markdown; the wizard — not the artifacts — renders the meta header and verification badge row live from ticket/run/git data, `gate_results`, and AC rows; stale banner only when provably stale (prefix SHA compare vs branch tip, unknowable → no banner); steps are conditional / gracefully empty, and a park-by-cap arrival shows an explicit "missing — arrived via bounce cap" placeholder per absent artifact; the Documentation & Artifacts step excludes `dogfood-report.md` (own step); "Decisions for a human" entries from the dogfood report surface in the Dogfood step for the reviewer to answer.

Constraint from [Workflow engine design](07-workflow-engine.md) (2026-07-18): a wizard step failed by the reviewer **must require a written reviewer note** — it lands verbatim in the follow-up AC row and the Bounce Report the next run reads. Stack is decided (map Notes): TypeScript, React renderer, Hono localhost API/SSE in the main process — so this ticket resolves the UI shape itself: component/route structure, the SSE event contract the renderer consumes (ticket state changes, agent log streams, gate results), and drag/promote interaction; proven by a throwaway /prototype.

## Resolution (2026-07-18)

Prototyped three structurally different shapes (kanban classic / split workspace / factory console) as a /prototype on branch `prototype/renderer-ui` (`npm run prototype`, `?variant=A|B|C`). **Variant A — "Kanban classic" — won.**

The decided UI shape:

- **Board**: full-width six-column kanban (Backlog → Done), one column per state. New-ticket input lives at the top of the Backlog column; promotion is the provider picker directly on a Backlog card. In-progress cards show a five-segment phase bar (research→plan→implement→dogfood→document) with the active phase pulsing. Human Review cards carry a `Review →` button.
- **Ticket detail**: right slide-over drawer over the board (not a separate route). Stacked sections: state badge, properties (repo, provider picker, run), description, ACs (status dot + provenance + follow-up marker), live agent log, artifacts, activity feed (rendered Audit Trail).
- **Review wizard**: centered modal over the board. Top-to-bottom: wizard-chrome meta header (ticket/run/branch/SHA + live gate-badge row), horizontal six-step stepper (step chips show pass/fail/skip state), step body, footer with pass/fail/skip + mandatory reviewer note on fail + Back/Next. Verdict step gates Merge (no fails) vs Bounce (≥1 fail, counts follow-ups).
- **Component structure**: wizard step *content* is one shared set of components (content shape was already decided in tickets 10/11); board/detail/wizard chrome is what this ticket decided. Naive markdown rendering and the sandboxed `srcdoc` iframe (`sandbox="allow-scripts"`) proved out as expected.
- **SSE contract draft** (for ticket 18): two streams — app-wide `GET /api/events` (`ticket.updated`, `run.created`, `run.phase_changed`, `gate.result`, `ac.updated`, `run.ended`, `audit.appended` with monotonic seq for Last-Event-ID resume, `preview.status`) and per-run `GET /api/runs/:runId/log` (`block.open`/`block.delta`/`block.close` over the block-level union: prompt/thinking/text/tool_call/tool_result). Full draft: `src/renderer-prototype/events.ts` on the prototype branch.

Worth stealing later (not part of the decision): Variant C's worker-lanes strip is a candidate future "factory view" — noted, not scoped.

Prototype is throwaway: reference the branch, don't port the code.
