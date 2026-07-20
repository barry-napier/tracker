# 49 — Builder chat: AI edits to the draft

**What to build:** The Lindy-style chat panel docked left of the canvas editor (prototyped 2026-07-19 in `WorkflowCanvasPrototype.tsx`). The user describes a change ("add a security stage after review," "give research a web-search step"); a provider session translates it into draft mutations through ticket 47's draft ops — the chat edits the Draft only, never a published version, so nothing runs until the human hits Publish and the validator passes. The agent's tool surface is exactly the draft mutation API (add/remove/rename stages, connect/relabel edges, add/edit/reorder steps, set node fields) — no orchestrator or engine access. Each reply states what changed; the canvas re-renders from the mutated draft, and edits land in the same undo/history space as manual ones.

**Blocked by:** 47 — drafts and publish; 48 — canvas editor.

**Status:** ready-for-agent

- [ ] Chat request produces draft mutations via the same store ops the canvas uses; canvas reflects them immediately
- [ ] The chat cannot publish, discard, or touch published versions — human-only actions stay human-only
- [ ] Stage, edge-label, and step edits all reachable through chat (add stage with steps proven end-to-end)
- [ ] Invalid requests (cycle, second trigger) are refused with the validator's reason, draft untouched
- [ ] Panel matches the prototype's placement and oc-2 look; works in both color schemes
