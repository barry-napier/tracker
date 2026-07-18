# 26 — FakeProvider runs one phase, logs stream live

**What to build:** The Provider interface and the scripted FakeProvider (the spec's primary test fake). The workflow interpreter walks a seeded single-phase workflow graph: the claimed Run executes one phase in a fresh provider session, the Phase Contract is enforced (provider success AND `kb/<phase>.md` exists), and the drawer's agent-log view renders the full conversation live — prompt, thinking, text, tool calls/results, streaming deltas — from the per-run SSE log stream.

Interface shape (decided in [Provider abstraction](09-provider-abstraction.md), drafted in the UI prototype):

```ts
Provider.runPhase(prompt, cwd, opts) → { events: AsyncIterable<AgentEvent>, done: Promise<RunResult> }
// RunResult: { outcome: completed|failed|cancelled|crashed, failureReason?, providerSessionId?, costUsd?, usage? }
// log stream: block.open / block.delta / block.close over prompt|thinking|text|tool_call|tool_result
```

**Blocked by:** 25 — First claim cuts a worktree.

**Status:** ready-for-agent

- [ ] Provider interface + block-level event union in the main process; FakeProvider scripted per-test (write files, commit, emit events, misbehave on demand)
- [ ] Workflow graphs stored as nodes + edges (ADR-0001); interpreter starts at trigger and walks the single unlabeled outgoing edge
- [ ] Phase completion = provider success signal AND contract file exists; either missing → phase failed; recorded in phase executions + audit
- [ ] Per-run SSE log stream delivers open/delta/close block events; drawer renders all five block kinds with live deltas
- [ ] Run ends → Ticket reaches Verifying (battery arrives in slice 29)
