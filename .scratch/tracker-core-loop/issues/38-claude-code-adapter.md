# 38 — Claude Code adapter, provider config, contract-test harness

**What to build:** The first real Provider adapter: spawn Claude Code headless (`-p`, stream-json output) in the phase's worktree, parse NDJSON tolerantly (unknown event types ignored, never thrown), map to the block-level event union, detect success per the research (exit 0 + result line + success subtype), SIGTERM cancellation, native budget cap as defense-in-depth. Plus the two things every later adapter reuses: app-level provider config (binary path, pinned model, extra env — surfaced minimally in the UI) and the adapter contract-test harness (run a scripted prompt in a scratch dir; assert normalized event sequence shape and RunResult; skippable where the CLI is absent). Capability flags: `costReporting` yes, `streamsPartialText` no, `emitsThinking` yes.

**Blocked by:** 26 — FakeProvider runs one phase.

**Status:** done (2026-07-20)

- [x] A real Claude Code session runs a phase in a worktree; the drawer shows the full live conversation
- [x] Tolerant parser: unknown NDJSON types/fields ignored; malformed line doesn't kill the run
- [x] Success/failure/cancellation mapped per [the research](01-claude-code-headless.md); full-trust permission flag posture
- [x] Provider config persisted app-level; promotion uses it; no per-ticket model knob
- [x] Contract-test harness green for FakeProvider and Claude Code

`ClaudeCodeProvider` (`src/server/providers/claude-code.ts`) splits the pure `StreamJsonMapper` (line in → `AgentEvent[]` out) from the thin spawn layer, so tolerance is provable without a subprocess. The adapter opens each phase with a `prompt` block — the CLI never echoes it back — then maps `thinking`/`text`/`tool_use` and `tool_result` blocks. Outcome mapping, in order: abort → SIGTERM → **cancelled**; spawn failure → **crashed**; any non-zero exit → **failed** (issue 01 pins "exit 0 = success, 1 = error", so a refused flag or failed auth is the agent failing, whether or not a result line arrived); exit 0 with no `result` line → **crashed**; then `is_error` or a non-`success` subtype → **failed**; otherwise **completed**. `permission_denials` rides into the failure reason — in `-p` mode a denial aborts the run and the result text never names the tool.

**Deviation needing sign-off:** issue 01 says a missing final `result` line "must be treated as failure". This maps the exit-0 case to `crashed` instead, because `failed` and `crashed` route differently here (crash retry vs. bounce) and the documented pre-2.1.208 truncation bug is a transport tear, not wrong work — blaming the agent would burn a bounce cycle on work it may well have done. The exit-non-zero case follows the research exactly. Capabilities declared on the `Provider` interface (`costReporting` yes, `streamsPartialText` no, `emitsThinking` yes).

Migration 15 adds `provider_config` (binary path, pinned model, budget cap, extra env), app-level and keyed by provider name — no per-ticket knob, so two Runs of one Ticket stay comparable. Rows are created on first edit; a missing row reads as all-defaults. `GET`/`PATCH /api/provider-config`, surfaced as a collapsed per-provider section in Project settings labeled as machine-wide. `appProviders()` (`providers/registry.ts`) is the app's registry: Claude Code real, Kiro and Copilot still scripted until 39/40; config is resolved per phase, so a settings edit lands on the next claim without a restart.

The contract harness (`tests/provider-contract.ts`) runs against FakeProvider and ClaudeCodeProvider. **Deviation from the brief:** rather than skipping when the CLI is absent, the adapter is driven by a scripted stub binary (`tests/fixtures/fake-claude.mjs`) that speaks real NDJSON — so the whole spawn path (argv, chunked stdout, exit codes, SIGTERM, truncation, malformed lines) is covered deterministically on every `npm test` with no API spend. The live-CLI run is the same suite gated behind `TRACKER_LIVE_PROVIDER_TESTS=1` plus CLI presence, and exists to catch the wire format changing underneath us.
