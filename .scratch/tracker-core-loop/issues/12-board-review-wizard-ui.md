# Board and review wizard UI shape

Type: prototype
Status: open
Blocked by: 06, 11

## Question

What is the minimal renderer UI for the core loop, and on what framework? Scope: the six-column board (create ticket in Backlog, drag/promote to Todo, watch state changes), ticket detail (description, activity ledger, artifacts, properties incl. provider picker, agent logs), and the review wizard (steps: Visual Recap, Dogfood Report, Pull Request, Documentation & Artifacts, Manual Walkthrough w/ preview env + demo video, Final Verdict; pass/fail/skip per step; fail emits follow-up criteria and bounces the ticket). The prototype screenshots are the reference spec.

Constraint from [Workflow engine design](07-workflow-engine.md) (2026-07-18): a wizard step failed by the reviewer **must require a written reviewer note** — it lands verbatim in the follow-up AC row and the Bounce Report the next run reads. Stack is decided (map Notes): TypeScript, React renderer, Hono localhost API/SSE in the main process — so this ticket resolves the UI shape itself: component/route structure, the SSE event contract the renderer consumes (ticket state changes, agent log streams, gate results), and drag/promote interaction; proven by a throwaway /prototype.
