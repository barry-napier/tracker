# Kiro CLI headless interface

Research ticket: `.scratch/tracker-core-loop/issues/02-kiro-cli-headless.md`
Date: 2026-07-18. Primary sources: local `kiro-cli 2.13.0` (`which kiro-cli` → `~/.local/bin/kiro-cli`; `kiro-cli --version` → `kiro-cli 2.13.0`), official docs at kiro.dev, and the Kiro GitHub tracker. Every behavioral claim below was either reproduced locally against 2.13.0 or is cited to an official page.

## 1. Two headless surfaces, not one

Kiro CLI exposes **two** distinct programmatic interfaces:

1. **Headless chat** — `kiro-cli chat --no-interactive "<prompt>"`: one-shot, plain-text-to-stdout, exits when the turn ends. Documented at [kiro.dev/docs/cli/headless](https://kiro.dev/docs/cli/headless/).
2. **ACP mode** — `kiro-cli acp`: a long-lived subprocess speaking [Agent Client Protocol](https://kiro.dev/docs/cli/acp/) (JSON-RPC 2.0 over stdin/stdout) with streaming structured events, explicit session management, and per-session `cwd`. This is the interface Zed and JetBrains use.

For the Electron app's "spawn in a worktree, parse output for a live log view" use case, ACP mode is the far better fit; headless chat is the simpler fallback. Both are covered below.

## 2. Headless chat (`chat --no-interactive`)

### Invocation

```
kiro-cli chat --no-interactive [--trust-all-tools | --trust-tools=...] "<prompt>"
```

Flags verified from local `kiro-cli chat --help` (2.13.0):

| Flag | Behavior |
|---|---|
| `--no-interactive` | "Whether the command should run without expecting user input" — prints the response and exits |
| `[INPUT]` positional | "The first question to ask" (the prompt) |
| `-a, --trust-all-tools` | "Allows the model to use any tool to run commands without asking for confirmation" |
| `--trust-tools <NAMES>` | Trust only listed tools, e.g. `--trust-tools=fs_read,fs_write`; `--trust-tools=` trusts none |
| `-r, --resume` | Resume the most recent conversation *from this directory* |
| `--resume-id <SESSION_ID>` | Resume a specific conversation by session ID |
| `--agent <AGENT>` | Context profile (custom agent config) to use |
| `--model <MODEL>` | Model selection (local list: `auto`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `deepseek-3.2`, `minimax-m2.5`, `minimax-m2.1`, `glm-5`, `qwen3-coder-next`) |
| `--wrap never` | Raw output, no terminal-width wrapping |
| `--require-mcp-startup` | "exit with code 3 if any fail" (MCP servers) |
| `-l, --list-sessions` / `-f json` | List sessions for the current directory as JSON |
| `--agent-engine <v1\|v2\|v3>` | Engine selection (default v2) |

### Prompt and working directory

- Prompt is the positional argument; **stdin piping also works** — verified locally: `echo "Reply with exactly STDIN-OK..." | kiro-cli chat --no-interactive` returned `STDIN-OK`, exit 0. Docs show `cat build-error.log | kiro-cli chat --no-interactive "..."` ([headless docs](https://kiro.dev/docs/cli/headless/)).
- **Working directory = process cwd.** There is no `--cwd`/`--dir` flag in `chat --help`. Sessions, checkpoints, local agent discovery, and default tool trust ("read, grep, and glob are trusted in the current working directory" — [permissions docs](https://kiro.dev/docs/cli/chat/permissions/)) are all keyed off cwd. Spawn the child with `cwd` set to the worktree.

### Output format

- **Plain text only. No JSON/stream-JSON output mode for chat.** `-f/--format` exists but "Output format for list commands (used with `--list-models` and `--list-sessions`)" (local `--help`). Confirmed by [issue #9066](https://github.com/kirodotdev/Kiro/issues/9066), which requests `--output-format json` for headless mode — open feature request as of 2026-07.
- Verified locally: response text goes to **stdout**; status noise (checkpoint banner, `Credits: … Time: …` footer) goes to **stderr**. Stdout still contains ANSI escape codes even with `--wrap never`; `NO_COLOR=1` reduces but does not fully eliminate them (a residual `ESC[m> ESC[0m` prompt-marker prefix remains before the answer text). A robust parser must strip ANSI (`/\x1b\[[0-9;?]*[a-zA-Z]/g`).
- Tool activity is narrated inline in the same plain-text stream (e.g. `I'll create the following file: … (using tool: write)`, diff-style `+ 1: hello`, `Creating: <path> - Completed in 0.1s`) — human-readable, not machine-parseable events. (Observed locally.)

### Exit codes

- `0` — turn completed. **Verified caveat: exit 0 does not mean the task succeeded.** Locally, a run whose only tool call was denied (see permissions below) still exited 0.
- `1` — CLI-level error (verified locally: `--model nonexistent-model` → exit 1, `error: Model '…' does not exist…` on stderr).
- `3` — MCP server startup failure when `--require-mcp-startup` is set (local `--help`; [CLI commands reference](https://kiro.dev/docs/cli/reference/cli-commands/)).
- No documented richer contract (no "max turns", "budget exceeded" codes).

### Permissions / unattended approval

- With **no** trust flags, non-interactive runs **auto-deny** untrusted tools rather than hanging. Verified locally — an fs_write attempt produced: `Command fs_write is rejected because it matches one or more rules on the denied list: - non-interactive mode (no user to approve)` and the model apologized; exit 0.
- `--trust-all-tools` auto-approves everything (verified: file created). `--trust-tools=<list>` is the least-privilege middle ground ([headless docs](https://kiro.dev/docs/cli/headless/)).
- Finer control lives in **custom agent configs** (`tools`, `allowedTools`, `toolsSettings` with per-command/per-path rules, MCP tools as `@server/tool`) selected via `--agent` — [agent configuration reference](https://kiro.dev/docs/cli/custom-agents/configuration-reference/). Defaults: read-only tools trusted in cwd; `shell`/`write`/`aws` prompt (or are denied headlessly) unless allowed ([permissions docs](https://kiro.dev/docs/cli/chat/permissions/)).

### Sessions and resume

- Sessions are stored per-directory; `kiro-cli chat --list-sessions --format json` (run in that directory) returns `[{"cwd": "...", "sessions": [{"sessionId", "source", "title", "updatedAt", "messageCount"}]}]` — verified locally.
- Resume works headlessly: `--resume` (latest for this cwd) and `--resume-id <uuid>` both accepted alongside `--no-interactive`; verified locally that a resumed non-interactive turn recalled earlier conversation content.
- **Gap:** the session ID of a just-finished headless run is *not printed*; you must diff `--list-sessions` output afterward, which is racy with concurrent runs ([issue #9066](https://github.com/kirodotdev/Kiro/issues/9066)).
- Session files live at `~/.kiro/sessions/cli/<uuid>.json` + `<uuid>.jsonl` (event log) + `.history`/`.lock` — verified locally; documented in [ACP docs](https://kiro.dev/docs/cli/acp/).

### Auth for CI

Headless mode in CI uses a `KIRO_API_KEY` env var (Pro+ tiers), skipping browser login ([headless docs](https://kiro.dev/docs/cli/headless/), [headless-mode blog post](https://kiro.dev/blog/introducing-headless-mode/)). A locally logged-in machine (our case) needs nothing extra.

## 3. ACP mode (`kiro-cli acp`) — the structured option

From local `kiro-cli acp --help`: `kiro-cli acp [--agent A] [--model M] [--effort E] [-a|--trust-all-tools] [--trust-tools ...] [--agent-engine v1|v2|v3]`. Protocol details: [kiro.dev/docs/cli/acp](https://kiro.dev/docs/cli/acp/) and the ACP spec ([agentclientprotocol.com](https://agentclientprotocol.com)).

Verified end-to-end locally against 2.13.0 (newline-delimited JSON-RPC 2.0 over stdio):

- `initialize` → `{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},"mcpCapabilities":{"http":true},...},"agentInfo":{"name":"Kiro CLI Agent","version":"2.13.0"}}`
- `session/new` **takes `cwd` explicitly** (`{"cwd": "...", "mcpServers": []}`) → returns `sessionId` plus available modes (`kiro_default`, `kiro_planner`, `kiro_guide`, …).
- `session/prompt` with content blocks → streamed `session/update` notifications: `tool_call` (with `kind`, `title`, and `content: [{"type":"diff","path":...,"oldText"/"newText"}]`), `tool_call_update` (`status: "completed"`, `rawInput`, file `locations`), `agent_message_chunk` (`{"type":"text","text":...}`), plus Kiro extension notifications (`_kiro.dev/metadata`, `_kiro.dev/commands/available`, `_kiro.dev/subagent/list_update`).
- Prompt response resolves with `{"stopReason":"end_turn"}`. Cancellation via `session/cancel`; resume via `session/load` (capability `loadSession: true`); mode/model switching via `session/set_mode` / `session/set_model` ([ACP docs](https://kiro.dev/docs/cli/acp/)).
- `--trust-all-tools` auto-approves in ACP mode too (verified: file written with no `session/request_permission` round-trip). Without it, ACP sends the client a `session/request_permission` request the host app must answer — i.e. **programmable permission prompts**, which headless chat lacks.

## 4. Gaps vs Claude Code's headless contract

Claude Code reference points: `claude -p` with `--output-format stream-json` (typed JSON events incl. init/session_id/result with `is_error`, cost, usage), `--resume <session-id>`/`--continue`, `--permission-mode` + `--allowedTools`/`--disallowedTools` + `--permission-prompt-tool`, `--add-dir`, exit codes tied to result. Kiro gaps:

| Claude Code capability | Kiro headless chat | Kiro ACP |
|---|---|---|
| `--output-format stream-json` typed event stream | **Missing** — ANSI-laden plain text; open FR [#9066](https://github.com/kirodotdev/Kiro/issues/9066) | Covered (JSON-RPC `session/update` stream), but different schema and framing (LSP-style RPC vs line-delimited events) |
| Session ID returned in output (`init`/`result` events) | **Missing** — must scrape `--list-sessions` afterward (racy) | Covered — `session/new` returns `sessionId` |
| Resume by ID | Covered (`--resume-id`), but only IDs you discovered out-of-band | Covered (`session/load`) |
| Result envelope (`is_error`, `num_turns`, cost, duration) | **Missing** — exit 0 even when the sole tool call was denied; cost only as human text `Credits: 0.05` on stderr | Partial — `stopReason` only; no cost/usage in result (Kiro `_kiro.dev/metadata` extension notifications carry some metadata) |
| Permission modes (`plan`, `acceptEdits`, `bypassPermissions`) + dynamic `--permission-prompt-tool` | **Missing** — binary trust-at-launch (`--trust-all-tools` / `--trust-tools` / agent-config `allowedTools`); untrusted → hard deny | Partial — `session/request_permission` lets the host approve per-call; "modes" exist but are Kiro agent personas (`kiro_planner`), not permission postures |
| `--add-dir` extra working directories | **Missing** — cwd only (agent config `toolsSettings` can allow paths) | `cwd` per session; no multi-root |
| `--max-turns`, budget guards | **Missing** | **Missing** |
| System-prompt append/override flags | **Missing** on CLI (use custom agent config `prompt` field) | Same (via `--agent`) |
| MCP config per-invocation (`--mcp-config`) | Via agent config file only | `session/new` accepts `mcpServers` list |

Also note: model lineup differs (Kiro fronts Claude Sonnet/Haiku 4.x plus non-Anthropic models; "auto" default), and Kiro sessions are keyed to cwd — a worktree path change orphans resume-by-`--resume` (resume-by-ID still works).

## 5. Recommendations for the provider interface

1. **Abstract to an event stream, not stdout text.** Define the provider contract as `start(phasePrompt, cwd, opts) → AsyncIterable<AgentEvent>` with a small event union (`session_started {sessionId}`, `assistant_text`, `tool_call {id,title,kind,status,diff?}`, `permission_request`, `turn_complete {stopReason, ok}`, `fatal_error`). Claude Code's stream-json maps onto this trivially; Kiro maps onto it via **ACP**, not headless chat.
2. **Use `kiro-cli acp` as the Kiro backend.** One child process per phase (or per workflow), `session/new` with the worktree path as `cwd`, `session/prompt` per phase, `session/update` notifications feeding the live log view, `stopReason` for completion. This sidesteps every text-parsing problem and gives per-call permission mediation (`session/request_permission`) that headless chat cannot offer.
3. **If headless chat is used anyway (simplest v1):** spawn with `cwd` = worktree, prompt as argv (argv length limits: pipe long context via stdin), `--no-interactive --trust-tools=<explicit list> --wrap never`, `NO_COLOR=1`, strip ANSI, treat stderr as status noise. Do not trust exit 0 as success — verify outcomes structurally (e.g. `git status` in the worktree) or require the prompt to end with a sentinel the parser checks.
4. **Session identity:** don't rely on Kiro to report it in headless chat. Either use ACP (explicit `sessionId`) or, for chat mode, snapshot `--list-sessions --format json` before/after and serialize runs per worktree to disambiguate. Persist `sessionId` per phase so later phases can `--resume-id`/`session/load` for context continuity.
5. **Permission posture mapping:** map the app's "auto" phase mode to `--trust-tools`/agent-config `allowedTools` (least privilege: `fs_read,fs_write,shell` scoped by `toolsSettings.allowedCommands`/`allowedPaths` in a checked-in custom agent JSON selected with `--agent`), and map "supervised" mode to ACP `session/request_permission` surfaced in the Electron UI. Reserve `--trust-all-tools` for sandboxed/worktree-isolated runs only.
6. **Capability flags in the provider interface.** Providers should declare `{structuredOutput, reportsSessionId, resumable, midRunPermissionPrompts, costReporting, maxTurns}` so the orchestrator can degrade gracefully (e.g. skip live cost display for Kiro, disable "pause on permission" for Kiro headless chat).

## Sources

- Local command output, `kiro-cli 2.13.0`, macOS: `kiro-cli --help`, `--help-all`, `chat --help`, `acp --help`, `agent --help`; live runs of `chat --no-interactive` (trust/deny/exit-code/resume/stdin tests) and a scripted ACP session (initialize → session/new → session/prompt).
- [Headless mode — Kiro CLI docs](https://kiro.dev/docs/cli/headless/)
- [Run Kiro CLI programmatically: introducing headless mode — Kiro blog](https://kiro.dev/blog/introducing-headless-mode/)
- [CLI commands reference — Kiro CLI docs](https://kiro.dev/docs/cli/reference/cli-commands/)
- [ACP (Agent Client Protocol) — Kiro CLI docs](https://kiro.dev/docs/cli/acp/)
- [Managing tool permissions — Kiro CLI docs](https://kiro.dev/docs/cli/chat/permissions/)
- [Agent configuration reference — Kiro CLI docs](https://kiro.dev/docs/cli/custom-agents/configuration-reference/)
- [Issue #9066 — Expose the conversation's session ID in headless mode](https://github.com/kirodotdev/Kiro/issues/9066) (open feature request)
