# 40 — Copilot adapter

**What to build:** The Copilot adapter via the official SDK wrapped in a Tracker-owned Node subprocess that emits normalized events as NDJSON on stdout — keeping kill/crash semantics uniform (every provider is a child process the orchestrator can SIGTERM). Full-tool-allowance posture; success on SDK completion; capability flags: `costReporting` partial (premium-request counts, not USD), `streamsPartialText` yes, `emitsThinking` yes. Never the plain-text CLI or undocumented session-state files (per [the research](03-copilot-cli-headless.md)).

**Blocked by:** 38 — Claude Code adapter (reuses the contract-test harness and provider config).

**Status:** done (2026-07-20) — live SDK run included: contract suite green against `@github/copilot-sdk` 1.0.7 (bundled runtime 1.0.71, ~1 premium request per phase)

- [x] Wrapper subprocess translates SDK callbacks → normalized NDJSON → block union
- [x] SIGTERM on the wrapper cancels cleanly; crash of the wrapper is a phase failure, not a hang
- [x] Contract-test harness green for Copilot (skippable where the SDK/auth is absent)

`CopilotProvider` (`src/server/providers/copilot.ts`) + `copilot-wrapper.mjs` beside it: the wrapper reads `{prompt, model, cliPath}` from stdin, drives one `@github/copilot-sdk` session (`streaming: true`, `approveAll`, session `workingDirectory` pinned to cwd), and emits a Tracker-owned NDJSON protocol (`session`/`delta`/`tool_call`/`tool_result`/`result`). The pure `WrapperMapper` on the adapter side turns protocol lines into block events — same split as 38/39, provable without a subprocess. The result line is the verdict; a wrapper death without one is `crashed` (transport → crash policy retries), and internal blow-ups (SDK missing, auth) exit non-zero with stderr as the diagnosis. Cancellation is SIGTERM (wrapper force-stops the SDK runtime it spawned) with a 2s SIGKILL backstop — both halves under test (`hang` and `ignore-term` fixture modes). Capabilities: `costReporting` no (premium-request counts ride in `usage.premiumRequests`, summed from `assistant.usage` billing multipliers — no USD exists to report), `streamsPartialText` yes, `emitsThinking` yes.

Two things only the live run caught (the ticket-38 lesson again): the SDK session's `workingDirectory` must be pinned explicitly (tool ops don't reliably inherit the runtime cwd), and the default persona ends turns asking clarifying questions — the wrapper appends an unattended-posture system message (the SDK-side equivalent of the CLI's `--no-ask-user`, issue 03). Also observed live: the runtime re-emits `assistant.reasoning` finals per agent-loop turn with accumulated content, so the wrapper's delta-vs-final fallback flags are session-scoped, never reset.

Registry: all three providers are real as of this ticket; the demo stop-gap registry (`providers/demo.ts`) retired with it. `ProviderConfig.binaryPath` maps to the CLI runtime the SDK spawns (unset = the bundled platform binary — no PATH dependence). The wrapper ships to `build/` via a `cp` in the compile script. Live gate keys on auth (token env or `~/.copilot`), not a PATH binary, so unauthenticated CI skips loudly-labelled rather than burning 90s of silent retries.
