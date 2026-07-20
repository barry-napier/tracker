# 39 — Kiro adapter

**What to build:** The Kiro adapter over ACP: spawn `kiro-cli acp`, speak JSON-RPC over stdio (new session with the worktree as cwd, prompt, map the update notification stream to the block union with text deltas), success on end-turn stop reason, cancellation via ACP cancel then SIGTERM, trust flags at launch, model pinned off Kiro's `auto` router via provider config. Capability flags: `costReporting` no, `streamsPartialText` yes, `emitsThinking` yes. Never the plain-text no-interactive chat mode (per [the research](02-kiro-cli-headless.md)).

**Blocked by:** 38 — Claude Code adapter (reuses the contract-test harness and provider config).

**Status:** done (2026-07-20) — live-CLI run still owed (deferred by Barry; gated suite in place)

- [x] A real Kiro session runs a phase; deltas stream into the drawer as live-typing text *(proven against the scripted ACP stub; the live `kiro-cli` run is gated behind `TRACKER_LIVE_PROVIDER_TESTS=1` and not yet executed)*
- [x] ACP session lifecycle owned by the adapter; cancellation graceful-then-kill
- [x] Contract-test harness green for Kiro (skippable where the CLI is absent)

`KiroProvider` (`src/server/providers/kiro.ts`), same split as ticket 38 and for the same reason: pure `AcpMapper` (a `session/update` payload in, block events out) so streaming and tolerance are provable without a subprocess; the transport is a small JSON-RPC 2.0 client over newline-delimited stdio. Message and thought chunks stream as deltas onto one open block — the live-typing the drawer renders (`streamsPartialText: true`); tool calls land whole, closing any open stream; terminal `tool_call_update` statuses become results (duplicates deduped); `plan`, `_kiro.dev/*`, and unknown kinds are dropped, never thrown on.

Success is structural, per issue 02's finding that Kiro's exit codes lie: `stopReason: "end_turn"` and nothing else completes; `cancelled` maps to cancelled; anything else fails. Cancellation is graceful-then-kill: ACP `session/cancel` first, SIGTERM after a 2s grace — both halves under test (a stub mode that answers the cancel, and one that ignores it). `--trust-all-tools` at launch; a stray `session/request_permission` is answered allow rather than hung on. Model pinned off the `auto` router via the app-level provider config (`--model`); no budget flag — Kiro has no native cap. Capabilities: `costReporting` no, `streamsPartialText` yes, `emitsThinking` yes.

Registry: `appProviders` now runs real Claude Code and Kiro; Copilot remains scripted until 40. Harness: `tests/fixtures/fake-kiro.mjs` speaks the verified ACP handshake for every `npm test`; the live suite (contract + endings) is registered and CLI-gated. **Per the ticket-38 lesson (the stub shares its author's blind spots), AC1 is not fully discharged until the live run happens** — run `TRACKER_LIVE_PROVIDER_TESTS=1 npx vitest run tests/provider-contract.test.ts` on a machine with `kiro-cli`.
