# 26 — FakeProvider runs one phase, logs stream live

**What to build:** The Provider interface and the scripted FakeProvider (the spec's primary test fake). The workflow interpreter walks a seeded single-phase workflow graph: the claimed Run executes one phase in a fresh provider session, the Phase Contract is enforced (provider success AND `kb/<phase>.md` exists), and the drawer's agent-log view renders the full conversation live — prompt, thinking, text, tool calls/results, streaming deltas — from the per-run SSE log stream.

Interface shape (decided in [Provider abstraction](09-provider-abstraction.md), drafted in the UI prototype):

```ts
Provider.runPhase(prompt, cwd, opts) → { events: AsyncIterable<AgentEvent>, done: Promise<RunResult> }
// RunResult: { outcome: completed|failed|cancelled|crashed, failureReason?, providerSessionId?, costUsd?, usage? }
// log stream: block.open / block.delta / block.close over prompt|thinking|text|tool_call|tool_result
```

**Blocked by:** 25 — First claim cuts a worktree.

**Status:** done (2026-07-18)

- [x] Provider interface + block-level event union in the main process; FakeProvider scripted per-test (write files, commit, emit events, misbehave on demand)
- [x] Workflow graphs stored as nodes + edges (ADR-0001); interpreter starts at trigger and walks the single unlabeled outgoing edge
- [x] Phase completion = provider success signal AND contract file exists; either missing → phase failed; recorded in phase executions + audit
- [x] Per-run SSE log stream delivers open/delta/close block events; drawer renders all five block kinds with live deltas
- [x] Run ends → Ticket reaches Verifying (battery arrives in slice 29)

## Resolution (2026-07-18)

`Provider` interface + block-level `AgentEvent` union in `src/server/provider.ts`
(string union renamed `ProviderName` to free the name). Adapters normalize to
block.open/delta/close directly — the log stream serves provider events verbatim,
opens decorated with the phase. `FakeProvider` (`src/server/providers/fake.ts`)
takes an async-generator script: yield events, do real side effects between
yields, return the RunResult; throwing = crash. The driver pumps eagerly so
`done` settles even unconsumed, and honors `opts.signal` (resolves `cancelled`,
abandons the script) — cancellation got wired end-to-end early because
`pool.stop()` must not await a phase that never ends.

Migration v4: `workflows`/`workflow_nodes`/`workflow_edges` (ADR-0001) with a
seeded single-phase graph (trigger → implement; slice 27 extends the seed), plus
`phase_executions`. `WorkflowEngine` (`src/server/engine.ts`) walks the single
unlabeled edge, renders the node's prompt template from the fixed variable set,
and enforces the contract: provider `completed` AND `kb/<phase>.md` present,
else phase failed. Run outcomes via `Store.finishRun` (replaces
`markRunCrashed`): completed → Verifying; failed/crashed → Todo — recorded
distinctly for the later crash policy. `WorkerPool` frees slots on run end and
its failure cap now covers phase failures, not just setup crashes; on stop it
aborts in-flight phases and leaves Runs `running` for the future orphan sweep.

Per-run log: in-memory `RunLogRegistry` (process-lifetime replay),
`GET /api/runs/:id/log` SSE with Last-Event-ID resume; runs API now embeds
phase executions. Drawer gained the Agent log section (`AgentLog.tsx`):
EventSource per run, all five block kinds, deltas appended live with a
streaming cursor. `demoProviders()` stands in for real adapters in the dev app.

Proven at the HTTP/SSE seam (`tests/one-phase.test.ts`: happy path, log
replay + resume, hollow-phase failure, provider crash + re-claim recovery) and
live in the renderer (streamed deltas mid-phase, board flip to Verifying,
`kb/` staying out of git status). Claim tests now pin a never-ending
`stuckProvider` to keep asserting In Progress semantics.
