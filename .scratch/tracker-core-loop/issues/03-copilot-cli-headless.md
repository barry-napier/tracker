# Research: Copilot CLI headless interface

Type: research
Status: resolved

## Question

How does GitHub Copilot CLI run headless as a subprocess for the provider abstraction? Pin down, from primary sources (official GitHub docs, `copilot --help`): non-interactive/programmatic invocation, output formats, prompt + working-directory passing, completion/failure signaling, session resume, unattended-permission/approval behavior, and auth requirements. Note any gaps versus the Claude Code contract — those gaps shape the provider interface (issue 09).

## Answer

Full findings: `docs/research/copilot-cli-headless.md` on branch `research/copilot-cli-headless` (commit 91a07a0). Verified against `copilot --help` v0.0.384 locally, docs.github.com programmatic reference, github.blog changelog, and live test runs.

- **Headless invocation:** `copilot -p "<prompt>" --allow-all-tools` (allow-all-tools is required for non-interactive mode). cwd = working dir (no flag); file access scoped to cwd + temp — a worktree's `.git` indirection needs `--add-dir`/`--allow-all-paths`.
- **Output is plain text only** — no JSON/stream-json flag. Response on stdout, errors + human-readable stats footer on stderr. Undocumented but observed: every run journals NDJSON events to `~/.copilot/session-state/<uuid>/events.jsonl` — tailable but fragile.
- **Exit codes undocumented:** observed 0 success / 1 failure (after ~90s of silent model-call retries). No structured result record; session id never printed in `-p` mode.
- **Resume:** `--continue` / `--resume [sessionId]` exist, but non-interactive resume is undocumented — verify per version. No permission modes or mid-run approval — only static allow/deny lists at spawn.
- **Auth:** Copilot subscription device-flow cache or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` (fine-grained PAT with "Copilot Requests").
- **Key recommendation:** the official Copilot SDK (Node/TS) — not the CLI — is Copilot's real equivalent of Claude Code's stream-json + permission-callback contract, and likely the better integration path for the Electron app. Feed this option into the provider abstraction (issue 09).
