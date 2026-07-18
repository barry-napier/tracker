# GitHub Copilot CLI as a headless subprocess

Research ticket: `.scratch/tracker-core-loop/issues/03-copilot-cli-headless.md`
Date: 2026-07-18

## Sources

Primary sources only:

- **Local install**: `copilot` v0.0.384 (Homebrew, `/opt/homebrew/bin/copilot`) — `copilot --help`, `copilot help environment|permissions|config|logging`, plus live test runs and inspection of `~/.copilot/`. Note: the deprecated `gh copilot` extension (v1.2.0, suggest/explain only) is a different, older product and is ignored here.
- **Official docs** (docs.github.com):
  - [Running Copilot CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
  - [CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
  - [Automation quickstart](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/quickstart)
  - [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
  - [Install Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli)
  - [Using Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli)
- **Official changelog** (github.blog/changelog): [Copilot CLI GA (2026-02-25)](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/), [Copilot SDK GA (2026-06-02)](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)

Version caveat: online docs describe flags (`--no-ask-user`, `--secret-env-vars`, `COPILOT_HOME`) and models (`claude-sonnet-4.6`, `gpt-5.2`) that do **not** appear in the locally installed 0.0.384 help output. The CLI auto-updates by default (`--no-auto-update` / `COPILOT_AUTO_UPDATE=false` to pin). Treat flag availability as version-dependent.

## Non-interactive invocation

- `copilot -p, --prompt <text>` — "Execute a prompt in non-interactive mode (exits after completion)" (`copilot --help`). Docs: "The CLI runs the prompt and exits when done" ([programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)).
- Prompt may also be **piped on stdin** (`echo "..." | copilot`). "Piped input is ignored if you also provide a prompt with the `-p` or `--prompt` option" ([run programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)).
- `-i, --interactive <prompt>` starts the TUI with a first prompt — not useful for subprocess use.
- `--no-ask-user` (newer versions, per docs): "Prevent the agent from pausing to seek additional user input" — important for unattended runs so the agent can't stall on a clarifying question.
- `--agent <agent>` selects a custom agent; `--model <model>` selects the model (local 0.0.384 lists `claude-sonnet-4.5`, `claude-opus-4.5`, `gpt-5.2-codex`, `gemini-3-pro-preview`, etc.); `COPILOT_MODEL` env var also works (`copilot help environment`).
- Canonical unattended invocation (from `copilot --help` examples):

  ```sh
  copilot -p "Fix the bug in main.js" --allow-all-tools
  ```

## Output format

- **Plain text only. There is no JSON/stream-JSON output mode.** No `--output-format`, `--json`, or event-stream flag exists in `copilot --help` (v0.0.384) or in the [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference). (The only `--json` in the product is `copilot plugins list --json`, per the [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).)
- **stdout** carries the agent's response text; **stderr** carries errors and the run-stats footer. Verified empirically (failed run, v0.0.384): stdout was empty; stderr contained `Model call failed: ...` lines, `Execution failed: Error: ...`, and the footer:

  ```
  Total usage est:       0 Premium requests
  Total duration (API):  0s
  Total duration (wall): 1m 35.054s
  Total code changes:    0 lines added, 0 lines removed
  ```

- `-s, --silent` — "Output only the agent response (no stats), useful for scripting with -p" (`copilot --help`). Docs quickstart captures output as `description=$(copilot -p "..." -s 2>/dev/null)` ([quickstart](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/quickstart)).
- `--no-color` disables ANSI color; `--stream <on|off>` toggles streaming of text as it is generated (`copilot --help`, `copilot help config`).
- `--share [path]` — "Share session to markdown file after completion in non-interactive mode (default: ./copilot-session-<id>.md)" (`copilot --help`). This is the only supported way to get a full machine-readable-ish transcript out of a `-p` run. `--share-gist` publishes to a secret gist instead.
- **Undocumented but observed**: every session (including `-p` runs) is journaled to `~/.copilot/session-state/<session-uuid>/events.jsonl` as line-delimited JSON events. Observed event types (v0.0.384, inspected locally):
  - `session.start` (data: `sessionId`, `copilotVersion`, `selectedModel`, `startTime`, `producer`, `version`)
  - `session.info`, `session.error` (data: `errorType`, `message`, `stack`), `session.model_change`
  - `user.message` (data: `content`, `attachments`, `transformedContent`)
  - `assistant.turn_start` / `assistant.turn_end` (data: `turnId`)
  - `assistant.reasoning` (data: `content`, `reasoningId`)
  - `assistant.message` (data: `content`, `messageId`, `toolRequests`)
  - `tool.execution_start` (data: `toolCallId`, `toolName`, `arguments`) / `tool.execution_complete` (data: `toolCallId`, `success`, `result`, `toolTelemetry`)

  This file can be tailed for a live log view, but it is an **internal format** — not documented anywhere on docs.github.com — so treat it as fragile. State dir is overridable via `XDG_STATE_HOME` / `--config-dir` (`copilot help environment`, `copilot --help`), which lets a host app give each run an isolated state dir and find the session's `events.jsonl` deterministically.

## Working directory and file-path scoping

- The working directory is simply the process cwd — there is no `--cwd` flag; spawn the child with `cwd` set to the target worktree.
- "By default, file access is restricted to paths within the current working directory and its subdirectories, plus the system temporary directory" (`copilot help permissions`).
- Widen with `--add-dir <directory>` (repeatable) or `--allow-all-paths`; `--disallow-temp-dir` removes the temp-dir exemption (`copilot --help`).
- **Git-worktree gotcha**: a linked worktree's `.git` is a file pointing at the main repo's `.git/worktrees/...` directory, which is *outside* the cwd. Default path scoping may block git operations that touch the main repo's git dir; pass `--add-dir <main-repo-path>` (or `--allow-all-paths`) when spawning in a worktree.
- Interactive mode maintains `trusted_folders` in `~/.copilot/config.json` (`copilot help config`). Empirically, a `-p` run from an untrusted directory did **not** block on a trust prompt (v0.0.384) — it proceeded straight to execution.
- Custom instructions are auto-loaded "from AGENTS.md and related files" (git root, cwd, plus `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`); disable with `--no-custom-instructions` (`copilot --help`, `copilot help environment`).

## Completion / failure signaling

- **Exit codes are not documented anywhere official.** Neither `copilot --help`, the help topics, the [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), nor the changelog specify them.
- Empirically (v0.0.384): a `-p` run whose model calls fail exits **1** with the error on stderr; an invalid flag exits **1** (`error: unknown option ...`). A successful run exits 0 (implied by docs' scripting examples that branch on captured output).
- There is no structured "result" record (no cost/usage/turn-count JSON). The human-readable stats footer on stderr ("Total usage est: N Premium requests ...") is the only usage signal.

## Session resume

- `--continue` — "Resume the most recent session"; `--resume [sessionId]` — "Resume from a previous session (optionally specify session ID)"; without an ID interactive mode shows a picker (`copilot --help`). Help example: `copilot --allow-all-tools --resume`.
- Session IDs are the directory names under `~/.copilot/session-state/` (UUIDs); `--share`'s default filename embeds the ID (`copilot-session-<id>.md`).
- **Not documented**: whether `--resume <id> -p "next phase"` performs a non-interactive resume. Both flags exist and are not documented as mutually exclusive, but no official doc or help example shows the combination; verify per version before relying on it.
- The session ID of a `-p` run is **not printed to stdout**; a host app must discover it (newest dir in an isolated `--config-dir`/`XDG_STATE_HOME` state dir, or parse the `--share` filename).
- In-TUI equivalents: `/resume`, `/continue`, `/session ...` ([command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)).

## Unattended permission behavior

From `copilot --help` and `copilot help permissions`:

- `--allow-all-tools` — "Allow all tools to run automatically without confirmation; **required for non-interactive mode**" (env: `COPILOT_ALLOW_ALL=true`).
- `--allow-all-paths`, `--allow-all-urls`; `--allow-all` / `--yolo` = all three combined.
- Granular: `--allow-tool` / `--deny-tool` take patterns `shell(command:*)`, `write`, `<mcp-server>(tool)`, `url(domain)`. "Denial rules always take precedence over allow rules, even `--allow-all-tools`."
- Tool *visibility* (what the model can see) is separate: `--available-tools` / `--excluded-tools`.
- Docs warning: "If you use an automatic approval option such as `--allow-all-tools`, Copilot has the same access as you do to files on your computer, and can run any shell commands that you can run" ([using Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli)).
- There are **no permission-prompt callbacks and no "plan"/"acceptEdits"-style modes** — only allow/deny lists decided at spawn time. If a tool needs approval in `-p` mode and is not allowed, there is no one to approve it (hence "required for non-interactive mode").

## Auth requirements

From [install docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli) and `copilot help environment`:

- Requires "an active GitHub Copilot subscription"; Node.js 22+ for the npm install path.
- Interactive: `/login` device flow on first launch, credential cached in `~/.copilot`.
- Headless: token env vars, in precedence order `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` — "an authentication token that takes precedence over previously stored credentials" (`copilot help environment`). The PAT must be a fine-grained token with the "Copilot Requests" permission, resource owner = personal account.
- Failure mode observed locally: with a stale/entitlement-less credential, every model call fails with `Model call failed: The requested model is not supported.`, the CLI retries 5 times (~90 s of backoff), then exits 1. A host app should health-check auth (cheap `-p` ping) before long phases, and impose its own timeout.
- Usage is metered in "Premium requests" (stats footer; GA changelog).

## Gaps vs Claude Code headless contract

Claude Code's headless contract: `claude -p --output-format stream-json` (NDJSON events on stdout incl. init event with session id and a final result record with cost/usage), `--resume <session-id> -p`, permission modes (`default`/`acceptEdits`/`plan`/`bypassPermissions`), `--allowedTools`/`--disallowedTools`, `--permission-prompt-tool` for programmatic approval, documented exit-code semantics.

| Capability | Claude Code | Copilot CLI | Gap |
| --- | --- | --- | --- |
| Structured stdout stream | `stream-json` NDJSON events | Plain text only; no JSON output flag | **Hard gap.** Only workarounds: tail undocumented `~/.copilot/session-state/<id>/events.jsonl`, or post-hoc `--share` markdown |
| Session id discovery | Emitted in init event / result | Never printed in `-p` mode | Must be inferred from state dir or `--share` filename |
| Result record (cost, usage, status) | Final JSON result object | Human-readable stats footer on stderr | Parse text or ignore |
| Exit codes | Documented | Undocumented (observed: 0 ok / 1 failure) | Treat as boolean only |
| Non-interactive resume | `--resume <id> -p` documented | `--resume <id>` exists; combination with `-p` undocumented | Verify per version; fallback = re-prompt with phase context |
| Permission modes | 4 modes + permission-prompt tool (interactive-approval RPC) | Static allow/deny lists at spawn only; all-or-granular | No mid-run approval; no plan mode; no edit-only mode |
| Tool allowlist syntax | `--allowedTools "Bash(git:*)"` etc. | `--allow-tool 'shell(git:*)'`, `write`, `url(...)`, MCP | Comparable concept, different vocabulary — needs per-provider mapping |
| Prompt via stdin stream (multi-turn `stream-json` input) | Supported | Single prompt per process (arg or piped stdin) | One phase = one process for Copilot |
| Working dir scoping | `--add-dir` | `--add-dir` / `--allow-all-paths` (cwd-scoped by default) | Comparable; worktree `.git` indirection needs `--add-dir` on Copilot |
| Programmatic embedding | Claude Agent SDK | [Copilot SDK](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) (Node/TS, Python, Go, .NET, Rust, Java) — "planning, tool invocation, file edits, streaming, and multi-turn sessions", hooks incl. "permission requests" | SDK, not CLI, is Copilot's real equivalent of stream-json + permission callbacks |

## Recommendations for the provider interface

1. **Abstract to an event stream, not a CLI flag set.** Define provider events (`session-started {sessionId}`, `assistant-text`, `reasoning`, `tool-start {name,args}`, `tool-end {ok,result}`, `turn-end`, `error`, `result {exitCode, usage?}`). Claude Code maps 1:1 from stream-json; Copilot needs an adapter.
2. **For Copilot, strongly consider the Copilot SDK (Node/TS) instead of raw CLI spawning.** It runs in the Electron main process, exposes streaming events, multi-turn sessions, and permission-request hooks — closing exactly the gaps the CLI has. The Rust SDK "bundles the Copilot CLI binary by default", i.e. the SDK is the supported programmatic facade over the same engine.
3. **If spawning the CLI anyway**: `copilot -p "<phase prompt>" --allow-all-tools --no-color --stream on` with `cwd` = worktree, `--add-dir <main repo>` (worktree `.git` indirection), and an isolated state dir (`XDG_STATE_HOME` or `--config-dir` per run) so the new `session-state/<uuid>/events.jsonl` is unambiguous. Tail that file for the live log view; treat its schema as version-fragile and fall back to raw stdout lines.
4. **Completion contract**: process exit is the only reliable phase-completion signal; exit 0 = success, nonzero = failure; surface stderr tail as the error message. Add a host-side timeout — auth/model failures burn ~90 s in silent retries before exiting.
5. **Resume**: model "resume" as optional per provider (`supportsResume: boolean`). For Copilot, test `--resume <id> -p` on the pinned version; if unsupported, emulate by injecting prior-phase summary into the next prompt.
6. **Permissions**: expose a provider-level policy object (allow-all vs. tool patterns) and compile it per provider (Claude `--allowedTools` / Copilot `--allow-tool`+`--deny-tool`). Don't model interactive approval for Copilot CLI — it has none.
7. **Auth preflight**: per provider, run a cheap health check (`copilot -p "reply OK" -s` with a short timeout) at provider-registration time; pass `COPILOT_GITHUB_TOKEN` explicitly rather than relying on cached device-flow credentials.
8. **Pin the binary version** (`--no-auto-update`) — flags observed to differ across releases (`--no-ask-user`, `--secret-env-vars` absent in 0.0.384), and the events.jsonl schema is unversioned.
