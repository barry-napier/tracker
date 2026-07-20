# Spike: kiro ACP honors stdio MCP servers — `declare_outcome` verified live

**Question.** Before committing the Phase Contract's outcome declaration to typed MCP tools
(replacing the `kb/<phase>.md` `outcome:` string-match as the signaling channel), does the
weakest link — kiro-cli over ACP — actually connect to an MCP server passed in `session/new`
and route a tool call through it?

**Verdict: yes.** Ran 2026-07-20 against kiro-cli 2.13.0. Full chain observed, first attempt,
captured in `evidence-2026-07-20.jsonl`:

1. `session/new` carried a stdio server spec (`{name, command, args, env}`) → kiro spawned the
   stub itself and MCP-initialized it (client identifies as "Q DEV CLI", MCP protocol
   2025-11-25), confirmed by kiro's `_kiro.dev/mcp/server_initialized` extension event.
2. Kiro fetched `tools/list`, and the agent made a real `tools/call`:
   `declare_outcome({outcome: "success", reason: "ACP MCP spike"})` — landing in the stub's
   evidence log exactly as prompted.
3. ACP surfaced the invocation as `tool_call` / `tool_call_update` session updates, then
   `stopReason: end_turn`.

The spec backs it up: ACP mandates stdio MCP support for all agents (only HTTP/SSE are
capability-gated); kiro's `initialize` additionally advertises
`mcpCapabilities: {http: true, sse: false}`.

## Implications

- Tools-only outcome declaration is safe across all three providers: Claude (native MCP),
  Copilot (`MCPServerConfig` / `defineTool` in the SDK), kiro (this spike). The contract-file
  string-match fallback is optional, not required.
- The adapter change is just populating the `mcpServers: []` already sent at
  `src/server/providers/kiro.ts` (`session/new`).
- `mcp-stub.mjs` (~80 dependency-free lines) is the seed of Tracker's real MCP server;
  `acp-driver.mjs` doubles as an integration-test fixture for that ticket.

## Gotchas for the real ticket

- Kiro namespaces the tool as `@tracker/declare_outcome` in session updates — don't assume
  the bare tool name when mapping ACP events.
- `_kiro.dev/mcp/server_initialized` fired **twice** for one server — dedupe on
  `(sessionId, serverName)` if keying off it.

## Re-run

```bash
node spikes/acp-mcp-declare-outcome/acp-driver.mjs
```

Needs a logged-in `kiro-cli` on PATH. Writes a fresh `evidence.jsonl` (gitignored) and exits
0 iff the `tools/call` arrived; `evidence-2026-07-20.jsonl` is the committed proof from the
original run. Times out after 240s.
