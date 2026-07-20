# 49 — Builder chat: AI edits to the draft

**What to build:** The Lindy-style chat panel docked left of the canvas editor (prototyped 2026-07-19 in `WorkflowCanvasPrototype.tsx`). The user describes a change ("add a security stage after review," "give research a web-search step"); a provider session translates it into draft mutations through ticket 47's draft ops — the chat edits the Draft only, never a published version, so nothing runs until the human hits Publish and the validator passes. The agent's tool surface is exactly the draft mutation API (add/remove/rename stages, connect/relabel edges, add/edit/reorder steps, set node fields) — no orchestrator or engine access. Each reply states what changed; the canvas re-renders from the mutated draft, and edits land in the same undo/history space as manual ones.

**Blocked by:** 47 — drafts and publish; 48 — canvas editor.

**Status:** done (2026-07-20) — server side committed; the ChatPanel renderer half is live in the working tree and rides the concurrent canvas/router session's sweep

- [x] Chat request produces draft mutations via the same store ops the canvas uses; canvas reflects them immediately
- [x] The chat cannot publish, discard, or touch published versions — human-only actions stay human-only
- [x] Stage, edge-label, and step edits all reachable through chat (add stage with steps proven end-to-end)
- [x] Invalid requests (cycle, second trigger) are refused with the validator's reason, draft untouched
- [x] Panel matches the prototype's placement and oc-2 look; works in both color schemes (verified visually in both schemes; code uncommitted here)

**Resolution notes (2026-07-20):**
- Mechanism differs from the spec's "tool surface = draft mutation API": one provider phase per message, model returns a fenced JSON `{reply, graph}` full-replacement graph (`src/server/workflow-chat.ts`), saved through `store.updateWorkflowDraft` — the same single mutation surface the canvas PUT uses. Granular-op tooling deferred to the Tracker-as-MCP-server steal (t3code #2); prompt rules guard key stability until then.
- Route `POST /api/workflows/:id/draft/chat`: 400 blank message, 503 no provider, 502 unparseable/shape-invalid answer, 422 with the publish validator's reasons (cycle, second trigger, …) — draft untouched on every failure path, including no draft materialized on a draftless workflow (reads head, only a successful save cuts the draft).
- Chat cannot publish/discard: the route's only write is `updateWorkflowDraft`.
- Tests: tests/workflow-chat.test.ts (7) — success end-to-end with a steps-bearing stage, validator refusal, no-draft-on-failure, parse edge cases.
