# Provider abstraction interface

Type: grilling
Status: resolved
Blocked by: 01, 02, 03

## Question

What is the provider interface that Claude Code, Kiro CLI, and Copilot CLI all implement, with room for future providers? Informed by the three research tickets: spawn contract (binary, args, cwd, env), prompt delivery, streaming output/event parsing for the UI's agent-logs view, completion/failure detection, session resume across phases (if the workflow engine wants it), unattended-permission configuration per provider, and capability flags for gaps (e.g. a provider without structured output). Also: how a ticket gets assigned a provider (per-ticket picker as in the prototype's properties panel).

## Answer

Resolved 2026-07-18 by grilling. Prior decisions narrowed the space first: the Phase Contract mandates a fresh provider session per phase (so cross-phase resume drops out of the interface entirely), and gates stay orchestrator-side (ADR-0003).

- **The contract is a TypeScript interface, not a wire format.** `Provider.runPhase(prompt, cwd, opts) → { events: AsyncIterable<AgentEvent>, done: Promise<RunResult> }`, living in Electron's main process with one adapter per provider. The native transports (one-way NDJSON, bidirectional JSON-RPC, SDK callbacks) are irreconcilable as a single wire shape; the TS seam is the honest one.
- **Adapters.**
  - *Claude Code*: spawn `claude -p <prompt> --output-format stream-json --verbose`, cwd = worktree, parse NDJSON. Unknown event types/fields are ignored, never thrown (Claude Code adds types over time). No `--bare` (kills OAuth auth), no `--include-partial-messages`.
  - *Kiro*: spawn `kiro-cli acp`, speak ACP JSON-RPC over stdio — `session/new` with the worktree as `cwd`, `session/prompt`, map the `session/update` notification stream. Never `chat --no-interactive` (ANSI-laden plain text, exit 0 on denied work, racy session discovery).
  - *Copilot*: the official Copilot SDK (Node/TS) wrapped in a Tracker-owned Node subprocess that emits normalized events as NDJSON on stdout. Never the plain-text CLI, never the undocumented `~/.copilot/session-state/*/events.jsonl`. Keeps kill/crash semantics uniform: every provider is a child process the orchestrator can SIGTERM.
- **Event union — full conversation, block-level.** Append-only entries: `prompt_sent`, `thinking`, `assistant_text`, `tool_call {name, input}`, `tool_result {output, isError}`, `status` (retries, rate limits), `run_result`. The agent-logs view must show the whole back-and-forth: prompts in, thinking, text, tool calls/results. Providers that stream text chunks (Kiro, Copilot SDK) emit deltas onto the latest entry; Claude lands whole blocks as each completes.
- **RunResult is thin.** `{outcome: completed | failed | cancelled | crashed, failureReason?, providerSessionId?, costUsd?, usage?}` — only what every provider can honestly report; provider-specific richness rides in a raw detail blob for the log view. Success detection per adapter (Claude: exit 0 + result line + `is_error false` + subtype `success`; Kiro: `stopReason end_turn`; Copilot: SDK completion). True phase success stays orchestrator-side: provider-done AND `kb/<phase>.md` exists.
- **Guards are orchestrator-side.** Uniform wall-clock timeout per phase (default 30 min), SIGTERM on breach — the one guard all providers honor. Claude additionally gets native `--max-budget-usd` as defense-in-depth. No pretending Kiro/Copilot have caps they lack.
- **Permissions: full trust, uniformly.** `--dangerously-skip-permissions`-equivalent postures everywhere: Claude `--permission-mode bypassPermissions`, Kiro `--trust-all-tools`, Copilot `--allow-all-tools`. Phases must run builds, tests, git, `gh pr create` — any real allowlist converges on everything, and a mid-factory permission stall is what the loop can't tolerate. Containment = worktree isolation + human veto at Human Review (standing constraint: no mid-flight approval).
- **Assignment: human picks at promotion.** Choosing the provider is part of moving a ticket to Todo, defaulted from the Project's default provider, editable in the properties panel; bounce re-claims keep it. Model is pinned per provider in app-level provider config (binary path, model, extra env) — no per-ticket model/effort knob; Kiro must be pinned off its `auto` model router. The prototype launch dialog's "auto-assign least-busy" belongs to recurring task templates (fog), not the core loop.
- **Capability flags: exactly three.** `costReporting` (Claude yes; Kiro no; Copilot partial — premium-request counts, not USD), `streamsPartialText` (Kiro/Copilot yes, Claude no), `emitsThinking` (all yes-ish). Flags exist only where a component genuinely branches: cost column, live-typing text, thinking section. Everything else (session ids, budget caps, permission RPC) is adapter-internal.
- **Cancellation.** SIGTERM the child; Kiro gets ACP `session/cancel` first, then kill. Claude exits 143 → `cancelled`.

Reference docs: [claude-code-headless](../../docs/research/claude-code-headless.md), [kiro-cli-headless](../../docs/research/kiro-cli-headless.md), [copilot-cli-headless](../../docs/research/copilot-cli-headless.md) (on their `research/*` branches).
