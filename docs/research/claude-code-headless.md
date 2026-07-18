# Claude Code as a Headless Subprocess

Research for the Tracker orchestrator's provider abstraction: spawning `claude` as a child
process in a git worktree, one workflow phase at a time, and parsing its output for a live log
view.

**Sources.** All claims cite one of:

- `[help]` — local `claude --help` output, Claude Code v2.1.159 (`claude --version`, run 2026-07-18)
- `[headless]` — https://code.claude.com/docs/en/headless (official "Run Claude Code programmatically" doc)
- `[cli-ref]` — https://code.claude.com/docs/en/cli-reference
- `[perm-modes]` — https://code.claude.com/docs/en/permission-modes
- `[local-run]` — output of actual local `claude -p` invocations run for this research (commands quoted inline)

---

## 1. Non-interactive invocation (`claude -p`)

- `claude` "starts an interactive session by default, use -p/--print for non-interactive output". `[help]`
- `-p, --print`: "Print response and exit (useful for pipes)". The workspace trust dialog is
  skipped in non-interactive mode; settings files that fail validation are silently ignored
  (no error dialog). `[help]`
- All CLI options work with `-p`, including `--continue`, `--allowedTools`, `--output-format`. `[headless]`
- The prompt is a positional argument (`claude -p "Fix the bug"`) and stdin is also read, so
  data can be piped in (`cat log.txt | claude -p 'explain'`). Piped stdin is capped at 10MB
  (since v2.1.128); exceeding it exits with an error and a non-zero status. `[headless]`
- `--bare`: minimal mode — skips hooks, LSP, plugin sync, auto-memory, keychain reads, and
  CLAUDE.md auto-discovery; sets `CLAUDE_CODE_SIMPLE=1`. Auth in bare mode is strictly
  `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` — OAuth/keychain are never read. `[help]`
  Docs call `--bare` "the recommended mode for scripted and SDK calls, and will become the
  default for `-p` in a future release". `[headless]`
  - Caveat verified locally: on a machine authenticated only via OAuth (subscription login),
    `claude --bare -p ...` fails with `"Not logged in · Please run /login"` — the result message
    carries `is_error: true` and the assistant message carries `"error":"authentication_failed"`.
    Exit code was 1 (`claude --bare -p "hi" --output-format json; echo $?` → 1). `[local-run]`
    So for an Electron app riding the user's existing OAuth login, do **not** pass `--bare`.
- `--max-budget-usd <amount>`: "Maximum dollar amount to spend on API calls (only works with
  --print)". `[help]` Verified: exceeding it yields a `result` event with
  `"subtype":"error_max_budget_usd"`, `"is_error":true`, an `"errors":["Reached maximum budget ($0.1)"]`
  array, and exit code 1. `[local-run]`
- `--max-turns <n>` (documented in `[cli-ref]`): "Limit the number of agentic turns (print mode
  only). Exits with an error when the limit is reached." Note: not listed in v2.1.159 `--help`
  output, but accepted by the binary. `[cli-ref]` `[local-run]`
- `--fallback-model <model>`: automatic fallback when the default model is overloaded or
  unavailable (print mode only); `[cli-ref]` says it accepts a comma-separated list tried in
  order. `[help]` `[cli-ref]`
- Background Bash tasks Claude started are terminated ~5s after the final result once stdin
  closes; background subagents are waited on (capped at 10 min by default,
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). `[headless]`

## 2. Output formats

`--output-format` (print mode only): `"text"` (default), `"json"` (single result object),
`"stream-json"` (newline-delimited JSON, realtime). `[help]` `[headless]`

`--input-format`: `"text"` (default) or `"stream-json"` for realtime streaming *input* —
this is how you keep one process alive and feed it multiple user turns. `[help]`
`--replay-user-messages` re-emits stdin user messages on stdout for acknowledgment (requires
stream-json in and out). `[help]`

### 2.1 `json` — observed result object

Captured locally from `claude -p "Reply with exactly the word: pong" --output-format json`
(exit 0): `[local-run]`

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 2418,
  "duration_api_ms": 1172,
  "ttft_ms": 1175,
  "num_turns": 1,
  "result": "pong",
  "stop_reason": "end_turn",
  "session_id": "25fed8ae-f48b-4381-9511-8562c8b6806a",
  "total_cost_usd": 0.027971,
  "usage": { "input_tokens": 3691, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 18232, "output_tokens": 16, "...": "..." },
  "modelUsage": { "claude-fable-5[1m]": { "inputTokens": 3691, "outputTokens": 16, "costUSD": 0.027971, "contextWindow": 1000000, "...": "..." } },
  "permission_denials": [],
  "terminal_reason": "completed",
  "uuid": "add0683f-cf18-4c5d-bba2-5fa29039fc33"
}
```

- The text answer is in `result`; with `--json-schema <schema>`, validated structured output
  appears in a `structured_output` field instead. `[headless]`
- `total_cost_usd` plus per-model `modelUsage` breakdown is included "so scripted callers can
  track spend per invocation". `[headless]`

### 2.2 `stream-json` — observed event stream

Captured locally from a run with a tool use
(`claude -p "Read package.json ..." --allowedTools "Read" --output-format stream-json --verbose`).
Each line is one JSON object. Observed sequence and shapes: `[local-run]`

| Order | `type` / `subtype` | Key fields observed |
|---|---|---|
| 1 | `system` / `hook_started`, `hook_response` | `hook_event`, `hook_name`, `exit_code`, `stdout`, `stderr` (only when hooks are configured) |
| 2 | `system` / `init` | `cwd`, `session_id`, `tools[]`, `mcp_servers[]`, `model`, `permissionMode`, `slash_commands[]`, `agents[]`, `skills[]`, `plugins[]`, `apiKeySource`, `claude_code_version`, `output_style`, `uuid` |
| 3+ | `assistant` | `message` (Anthropic Messages-API shape: `content[]` blocks of `thinking`, `text`, `tool_use` with `name`/`input`), `parent_tool_use_id`, `request_id`, `session_id`, `uuid` |
| interleaved | `user` | `message.content[]` with `tool_result` blocks (`tool_use_id`, `is_error`), plus a `tool_use_result` convenience field, `timestamp` |
| interleaved | `rate_limit_event` | `rate_limit_info` |
| n−1 | `system` / `post_turn_summary` | `status_category`, `status_detail`, `needs_action` |
| last | `result` / `success` (or error subtype) | same shape as the `json` result object above |

Documented semantics of the stream: `[headless]`

- "The last line of the stream is a `result` message with the final response text, cost, and
  session metadata."
- `system/init` "is the first event in the stream unless startup events precede it" (hook
  events, plugin installs). It carries an optional `capabilities` string array for
  feature-detection (v2.1.205+).
- Subagent messages appear as `assistant`/`user` messages whose `parent_tool_use_id` is the
  spawning tool call's ID; main-conversation messages have `null` there. By default only
  subagent `tool_use`/`tool_result` blocks are emitted; `--forward-subagent-text` (v2.1.211+)
  adds subagent text/thinking.
- `system/api_retry` events precede retries of retryable API errors, with `attempt`,
  `max_retries`, `retry_delay_ms`, `error_status`, and an `error` category string
  (`authentication_failed`, `rate_limit`, `overloaded`, `billing_error`, `server_error`, ...).
- Token-level streaming: add `--include-partial-messages` (with `--verbose`) to get
  `stream_event` lines wrapping raw API deltas, e.g.
  `.event.delta.type == "text_delta"` carries `.event.delta.text`.
- `--include-hook-events` includes all hook lifecycle events (stream-json only). `[help]`
- `--prompt-suggestions` emits a `prompt_suggestion` message after each turn. `[help]`

## 3. Sessions: IDs, resume, persistence

- Every result carries `session_id`. Capture it and resume:
  `claude -p "..." --resume "$session_id"`. Verified locally: a fact stated in run 1 was
  recalled after `--resume <id>` in run 2, and the resumed run reported the **same**
  `session_id`. `[local-run]` `[headless]`
- `-c, --continue`: continue the most recent conversation in the current directory. `[help]`
- `--session-id <uuid>`: pre-assign a specific session ID (must be a valid UUID) — useful for
  correlating logs before the first output line arrives. `[help]`
- `--fork-session`: when resuming, mint a new session ID instead of reusing the original
  (use with `--resume`/`--continue`) — branch a conversation without mutating the original. `[help]`
- `--no-session-persistence`: don't save the session to disk; it cannot be resumed
  (print mode only). `[help]`
- Scope: "session ID lookup is scoped to the current project directory **and its git
  worktrees**" — resume works across worktrees of the same repo, but run resume commands from
  the same project. `[headless]` `[cli-ref]`

## 4. Permission modes for unattended runs

`--permission-mode` choices in v2.1.159: `acceptEdits`, `auto`, `bypassPermissions`,
`default`, `dontAsk`, `plan` (`manual` accepted as an alias for `default` in v2.1.200+).
`[help]` `[cli-ref]`

Per the official mode table ("What runs without asking"): `[perm-modes]`

| Mode | Runs without asking | Doc's "Best for" |
|---|---|---|
| `default` | Reads only | sensitive work |
| `acceptEdits` | Reads, file edits, common fs commands (`mkdir`, `touch`, `rm`, `mv`, `cp`, `sed`) in-scope | iterating |
| `plan` | Reads only; proposes, never edits | exploring |
| `auto` | Everything, with a background classifier model vetting each action | long tasks |
| `dontAsk` | Only pre-approved tools; everything else auto-denied | "Locked-down CI and scripts" |
| `bypassPermissions` | Everything | "Isolated containers and VMs only" |

Headless-relevant specifics:

- In `-p` mode there is no user to prompt. A tool call that would prompt **aborts/fails** the
  run instead: with `acceptEdits`, "Other shell commands and network requests still need an
  `--allowedTools` entry or a `permissions.allow` rule, otherwise the run aborts when one is
  attempted." `[headless]` In `auto` mode, "repeated blocks abort the session since there is
  no user to prompt." `[perm-modes]`
- `--allowedTools` / `--allowed-tools`: tools that execute without prompting; uses permission
  rule syntax with prefix matching, e.g. `Bash(git diff *)` (the space before `*` matters —
  `Bash(git diff*)` would also match `git diff-index`). `[help]` `[headless]`
- `--disallowedTools`: deny rules; a bare tool name removes the tool from the model's context
  (`"*"` removes every tool, `"mcp__*"` every MCP tool). `[cli-ref]`
- `--tools <list>`: restrict which built-in tools exist at all (`""` disables all,
  `"default"` all, or e.g. `"Bash,Edit,Read"`). `[help]`
- `--dangerously-skip-permissions` is "Equivalent to `--permission-mode bypassPermissions`".
  `[cli-ref]` It "Bypass[es] all permission checks. Recommended only for sandboxes with no
  internet access." `[help]` Refuses to run as root/sudo outside a recognized sandbox. In
  non-interactive mode no acceptance dialog is shown. Explicit `ask` rules and
  `rm -rf /`/`rm -rf ~` circuit breakers still prompt even in this mode. `[perm-modes]`
- `--allow-dangerously-skip-permissions` enables bypass as an *option* without activating it. `[help]`
- The `result` object's `permission_denials` array reports denied tool calls, so an
  orchestrator can detect "stalled by permissions" outcomes. `[local-run]`
- Settings injection per-invocation: `--settings <file-or-json>` (overrides settings.json keys
  for the session) and `--setting-sources user,project,local` to control which settings files
  load at all. `--strict-mcp-config` limits MCP servers to those in `--mcp-config`. `[help]` `[cli-ref]`

## 5. Completion and failure signaling

- **Exit codes** (verified locally): `0` on success; `1` on failure (auth failure, budget
  exceeded). `[local-run]` `--max-turns` "exits with an error when the limit is reached".
  `[cli-ref]` On SIGTERM, Claude Code aborts the turn, kills the Bash process tree, runs
  `SessionEnd` hooks, and exits with code **143**. `[headless]`
- **Result message**: terminal `result` line has `subtype` (`"success"` on success; error
  subtypes otherwise — observed `"error_max_budget_usd"` locally; docs name `error_max_turns`
  and `error_during_execution` in the Agent SDK type reference at
  https://code.claude.com/docs/en/agent-sdk/typescript), plus `is_error: boolean`,
  `terminal_reason`, optional `errors: string[]`, and `api_error_status`. `[local-run]`
  Note the two channels can disagree in edge cases (a result with `is_error:true` can still be
  printed before the process exits non-zero) — check **both** `is_error`/`subtype` and the
  exit code.
- **Truncation guard**: before v2.1.208 a large piped response could truncate the final line
  and omit the `result` message — treat "stream ended with no `result` line" as a failure. `[headless]`

## 6. Cost and usage reporting

- `total_cost_usd` on every `json`/`stream-json` result. `[local-run]` `[headless]`
- `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `server_tool_use` counts, `service_tier`, per-iteration
  breakdown. `[local-run]`
- `modelUsage`: per-model map with `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheCreationInputTokens`, `costUSD`, `contextWindow`. `[local-run]`
- `duration_ms`, `duration_api_ms`, `ttft_ms`, `num_turns` for latency accounting. `[local-run]`
- `--max-budget-usd` enforces a hard per-invocation spend cap (see §1). `[help]` `[local-run]`

## 7. Working directory and system prompt per invocation

- **Working directory**: there is no `--cwd` flag in `claude --help` — the session's project
  directory is the process's cwd (the `system/init` event echoes it back as `cwd`). Spawn the
  child with `cwd` set to the target worktree (`child_process.spawn(claude, args, { cwd: worktreePath })`).
  `[help]` `[local-run]` Session-resume lookup is scoped to that project directory and its git
  worktrees. `[headless]`
- `--add-dir <directories...>`: additional directories the tools may access; grants file
  access but does not discover `.claude/` config from them. `[help]` `[cli-ref]`
- **System prompt flags**: `[help]` `[cli-ref]`
  - `--system-prompt <prompt>` / `--system-prompt-file <path>` — replace the entire default
    system prompt.
  - `--append-system-prompt <prompt>` / `--append-system-prompt-file <path>` — append to the
    default prompt while keeping Claude Code's default behavior (docs' recommended pattern for
    role instructions, e.g. security-reviewer). `[headless]`
- `--agents <json>` defines custom agents inline; `--agent <name>` selects one for the
  session. `--model <alias|full-name>` and `--effort <low|medium|high|xhigh|max>` select model
  and effort per invocation. `[help]`
- Claude Code also has native worktree support (`-w, --worktree [name]` creates a worktree for
  the session) `[help]`, but since Tracker manages worktrees itself, spawning with `cwd` set is
  the right integration point.

---

## Recommendations for the provider interface

1. **Invocation shape.** Spawn `claude` with
   `-p <phase prompt> --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools <phase allowlist> --append-system-prompt <phase instructions> --max-budget-usd <cap> --session-id <uuid-we-mint>`,
   `cwd` = the phase's worktree, stdin closed (or piped context then closed). Skip `--bare`
   for now: it disables OAuth/keychain auth, which is how a desktop user will be logged in
   (verified failure locally); revisit if the app ships API-key auth.
2. **Provider abstraction surface.** Model the provider as:
   `run(phase): { events: AsyncIterable<Event>, done: Promise<RunResult> }` where `Event` is
   the parsed NDJSON line discriminated on `type`/`subtype` (`system/init`, `assistant`,
   `user`, `system/api_retry`, `stream_event`, `result`, plus an `unknown` passthrough —
   Claude Code adds event types over time, so the parser must ignore unrecognized `type`s and
   fields rather than throw). `RunResult` maps directly from the terminal `result` line:
   `{ ok, subtype, resultText, sessionId, numTurns, costUsd, usage, permissionDenials, errors }`.
3. **Live log view.** Render from `assistant` messages (`text`, `thinking`, `tool_use` blocks)
   and `user` `tool_result` blocks; group subagent activity under `parent_tool_use_id`. Add
   `--include-partial-messages` only if token-level streaming is wanted — block-level events
   are sufficient for a phase log and much less chatty.
4. **Completion detection.** A run succeeded iff: process exited 0 AND a `result` line was
   seen AND `result.is_error === false` AND `subtype === "success"`. Treat missing `result`
   line, non-zero exit (1 = error, 143 = SIGTERM/cancelled), or error subtypes
   (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`) as distinct failure
   reasons. Surface `permission_denials` and `errors[]` in the failure detail.
5. **Sessions across phases.** Persist `session_id` per phase. For "continue this phase"
   use `--resume <id>`; for "retry phase from its end state without polluting the original"
   use `--resume <id> --fork-session`. Always spawn from the same repo (worktrees share the
   project's session scope). Pre-minting IDs with `--session-id` lets the orchestrator key
   its log store before the child emits anything.
6. **Permissions policy.** Default to `acceptEdits` + explicit `--allowedTools` per phase
   (e.g. `Bash(npm test *)`, `Bash(git commit *)`); expose `bypassPermissions` only behind an
   explicit "I understand" toggle since worktrees isolate the checkout but not the machine.
   `dontAsk` is the right mode for a strict phase where only the allowlist may run. Watch
   `permission_denials` to tell the user *why* a phase stalled.
7. **Cost ledger.** Sum `total_cost_usd` per result across phases; keep `modelUsage` for a
   per-model breakdown. Enforce per-phase `--max-budget-usd` and treat
   `error_max_budget_usd` as a resumable pause (the session persists — `--resume` continues it
   with a fresh budget).
8. **Cancellation.** Kill with SIGTERM; expect exit 143 and no further output. Claude Code
   cleans up its Bash process tree and runs SessionEnd hooks itself.
