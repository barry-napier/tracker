# T3 Code analysis — chat summary (2026-07-20)

Deep dive on [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (Theo/Ping Labs' open-source
desktop control plane for coding agents, [t3.codes](https://t3.codes/)), and what Tracker should
steal from it. Clone examined at the session scratchpad (`t3code/`); paths below are relative to
that repo unless they point into Tracker.

## What happened

1. Searched GitHub for a "T3 chat desktop app" — no official one exists (T3 Chat is closed-source;
   only third-party wrappers like [0xGingi/T3_Chat_Electron](https://github.com/0xGingi/T3_Chat_Electron)).
2. The real target was **T3 Code** — cloned it and did a deep dive on provider integrations
   (two Explore agents + docs pass).
3. Compared against Tracker's provider seam and produced a ranked steal-list.

## Key findings on T3 Code

- **No direct model APIs.** It wraps locally installed, already-authenticated agent CLIs.
  Exactly 5 providers, three integration styles:
  - **Codex** — custom JSON-RPC over stdio to `codex app-server`, wire types code-generated in
    `packages/effect-codex-app-server`; session RPC in
    `apps/server/src/provider/Layers/CodexSessionRuntime.ts`.
  - **Claude** — official `@anthropic-ai/claude-agent-sdk` in-process
    (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, ~3.9k lines); SDK spawns the `claude` binary.
  - **Cursor / Grok** — ACP (Agent Client Protocol) via home-grown `packages/effect-acp`;
    shared spawn/translate core in `apps/server/src/provider/acp/AcpSessionRuntime.ts` plus thin
    per-vendor extension modules.
  - **OpenCode** — HTTP via `@opencode-ai/sdk`, spawning `opencode serve` locally.
- **Common abstraction:** every adapter implements `ProviderAdapterShape`
  (`apps/server/src/provider/Services/ProviderAdapter.ts`) and emits canonical
  `ProviderRuntimeEvent`s (`packages/contracts/src/providerRuntime.ts`); registry in
  `apps/server/src/provider/builtInDrivers.ts`.
- **Notable tricks:**
  - Zero-token Claude capability probe — start an SDK query with a never-yielding prompt, read
    `initializationResult()` (account, models), abort (`ClaudeProvider.ts:598`).
  - T3 Code injects *itself* as an HTTP MCP server into Claude sessions
    (`mcpServers["t3-code"]` in `ClaudeAdapter.ts`).
  - Per-account isolation via `CLAUDE_CONFIG_DIR` (not `HOME` — overriding HOME breaks keychain
    OAuth) and Codex "shadow homes" (private `auth.json`, shared session history,
    `Drivers/CodexHomeLayout.ts`).
  - Provider kind is an open branded string — unknown kinds degrade to an "unavailable" snapshot
    instead of crashing (`packages/contracts/src/providerInstance.ts`).
- **Around it:** Effect-TS 4 beta everywhere; event-sourced CQRS orchestration
  (`apps/server/src/orchestration/`); SQLite persistence; PRs via `gh`/`glab` CLIs
  (`apps/server/src/sourceControl/`); git checkpoint per turn (`CheckpointReactor`);
  optional Clerk/Cloudflare relay ("T3 Connect"), off by default.
  Their own `docs/architecture/providers.md` is stale (claims Codex-only).

## Steal-list for Tracker

Tracker's seam: `src/server/provider.ts` (`Provider`, `AgentEvent`, `PhaseHandle`), adapters in
`src/server/providers/` (claude-code, copilot via `@github/copilot-sdk`, kiro/ACP, fake).

| # | Steal | Tracker touchpoint |
|---|---|---|
| 1 | Zero-token auth/capability probe → surface "auth expired" pre-claim | add `probe()` to `src/server/provider.ts` |
| 2 | Expose Tracker as an MCP server so agents `declare_outcome()` via typed tools instead of only `kb/<phase>.md` string-matching (file stays as the durable artifact) | Phase Contract, `src/server/engine.ts` |
| 3 | Shared ACP core — extract when a **second** ACP provider lands, not before | `src/server/providers/kiro.ts` |
| 4 | Git checkpoint per Stage (hidden ref) → per-phase diffs in review wizard, rollback on bounce | `src/server/worktrees.ts`, ReviewWizard |
| 5 | One-shot provider call to write PR title/body from the diff | `src/server/github.ts` |
| 6 | Multi-account isolation (`CLAUDE_CONFIG_DIR`, shadow homes) + sensitive env vars stored server-side, never echoed to UI | `ProviderConfig.env` |

**Don't steal:** Effect-TS / event-sourcing rewrite; interactive approval bridging (conflicts with
Tracker's gates model, ADR-0003); relay/cloud infra.

**Adopt on principle:** unknown provider kinds render as "unavailable," never throw.

Verdict: #1 and #5 are ~an afternoon each; #2 is the highest-value structural change.

## Spike result: #1 zero-token probe (done 2026-07-20)

`probe(): Promise<ProbeResult>` added to the Provider seam and implemented in all four
adapters; proven live against every installed CLI via `scripts/prove-probe.ts`:

```
PASS  claude-code (198ms)  — ok account=barry.a.napier@gmail.com (max)
PASS  kiro (1569ms)        — ok models=9 [auto, claude-sonnet-4.5, …]
PASS  copilot (1753ms)     — ok account=barry-napier (via gh) models=1 [auto]
```

Per-transport findings (all zero-token, all verified empirically):

- **Claude:** t3code's SDK idle-query trick does NOT translate to the CLI — with
  stream-json input open and no message sent, v2.1.215 emits hook events but never
  `system/init`. The right primitive is `claude auth status`: JSON on stdout
  (loggedIn, email, subscriptionType), reads the local credential store only. No
  model listing exists at zero cost.
- **Kiro:** ACP handshake is zero-token by design. `initialize` → `session/new`
  (cwd = tmpdir) returns the full model catalog in the response
  (`models.availableModels`); an unauthenticated agent errors the handshake. ~1.5-4s.
  No account identity anywhere on the ACP surface.
- **Copilot:** the SDK has first-class endpoints — `client.getAuthStatus()`
  (isAuthenticated, login, authType) and `client.listModels()`. Wrapper gained a
  `{probe: true}` stdin mode emitting one `{type:"probe"}` line.

Contract: probe never rejects and never hangs — ok:false carries the reason;
per-adapter deadlines (10s/20s/30s) kill the child. Pure parsers
(`parseAuthStatus`, `probeFromSessionNew`, `parseProbeLine`) are unit-tested;
suite 297 green, tsc clean. Nothing reads probe() yet — the first consumer is a
provider-health row in settings or a pre-claim check in the engine.
