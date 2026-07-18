# Research: Kiro CLI headless interface

Type: research
Status: resolved

## Question

How does Kiro CLI run headless as a subprocess for the provider abstraction? Pin down, from primary sources (official docs, `kiro --help`, release notes): non-interactive/print mode, output formats (structured/JSON if any), how a prompt and working directory are passed, completion/failure signaling (exit codes), session or context resume, and unattended-permission behavior. Note any gaps where Kiro cannot match the Claude Code contract — those gaps shape the provider interface (issue 09).

## Answer

Full findings: `docs/research/kiro-cli-headless.md` on branch `research/kiro-cli-headless` (commit ccfa599). Verified against locally installed `kiro-cli 2.13.0` plus official kiro.dev docs.

- **Two headless surfaces:** `kiro-cli chat --no-interactive "<prompt>"` (one-shot plain text) and `kiro-cli acp` (JSON-RPC 2.0 / Agent Client Protocol over stdio with streaming structured events). **ACP is the right backend for Tracker.**
- **Headless chat has no JSON output** (open FR #9066) — ANSI-laden stdout, status noise on stderr. cwd = working directory (no flag); stdin piping works.
- **Exit codes are weak:** 0 = turn finished (verified even when the only tool call was denied), 1 = CLI error, 3 = MCP startup failure with `--require-mcp-startup`. Success must be verified structurally, not by exit code.
- **Permissions:** non-interactive runs hard-deny untrusted tools; `--trust-all-tools` / `--trust-tools=` / agent-config `allowedTools` are launch-time only — no dynamic permission modes in chat mode; ACP adds per-call `session/request_permission`.
- **Resume:** `--resume`, `--resume-id`, ACP `session/load`, per-cwd session store at `~/.kiro/sessions/cli/` — but headless chat never prints its own session ID; ACP returns it explicitly from `session/new` (which also takes `cwd`).
- Doc ends with a gaps table vs Claude Code's stream-json contract and provider-interface recommendations (event-stream abstraction + capability flags).
