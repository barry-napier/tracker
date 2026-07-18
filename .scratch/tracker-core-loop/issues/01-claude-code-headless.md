# Research: Claude Code headless interface

Type: research
Status: resolved

## Question

How does Claude Code run headless as a subprocess for the provider abstraction? Pin down, from primary sources (official docs, `claude --help`, Agent SDK docs): non-interactive invocation (`claude -p` / print mode), structured output formats (`--output-format stream-json` etc.), session management/resume, permission modes for unattended runs, how completion and failure are signaled (exit codes, final message), cost/usage reporting, and how to pass a working directory (worktree) and system-prompt/workflow-phase instructions. Findings feed the provider abstraction interface (issue 09).

## Answer

Full findings: `docs/research/claude-code-headless.md` on branch `research/claude-code-headless` (commit 8140a36). Verified against `claude --help` v2.1.159, code.claude.com docs, and live local runs.

- **Invocation:** `claude -p <prompt> --output-format stream-json --verbose`, spawned with `cwd` set to the worktree (no `--cwd` flag). Per-phase instructions via `--append-system-prompt`; budget cap via `--max-budget-usd`. Do NOT use `--bare` — verified it breaks OAuth/keychain auth for subscription-login users (`authentication_failed`).
- **Output:** stream-json is NDJSON: `system/init` (cwd, tools, model, session_id) → `assistant`/`user` messages (Messages-API content blocks; subagents tagged via `parent_tool_use_id`) → terminal `result` line with `subtype`, `is_error`, result text, `total_cost_usd`, `usage`, `permission_denials`.
- **Sessions:** every result carries `session_id`; `--resume <id>` verified working; `--session-id` pre-mints a UUID; `--fork-session` branches; resume scope covers the project dir *and its git worktrees* — good fit for session-per-phase resume.
- **Permissions:** `--permission-mode` (`acceptEdits`/`dontAsk`/`auto`/`bypassPermissions`) + `--allowedTools` prefix rules. In `-p` mode an unapproved tool call aborts the run (no prompt possible), surfaced in `permission_denials`.
- **Completion:** exit 0 = success, 1 = error, 143 = SIGTERM. Success requires exit 0 AND `result.subtype === "success"` AND `is_error === false`; a missing final `result` line must be treated as failure (documented truncation bug pre-2.1.208).
