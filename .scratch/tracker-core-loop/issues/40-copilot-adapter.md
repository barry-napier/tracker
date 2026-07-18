# 40 — Copilot adapter

**What to build:** The Copilot adapter via the official SDK wrapped in a Tracker-owned Node subprocess that emits normalized events as NDJSON on stdout — keeping kill/crash semantics uniform (every provider is a child process the orchestrator can SIGTERM). Full-tool-allowance posture; success on SDK completion; capability flags: `costReporting` partial (premium-request counts, not USD), `streamsPartialText` yes, `emitsThinking` yes. Never the plain-text CLI or undocumented session-state files (per [the research](03-copilot-cli-headless.md)).

**Blocked by:** 38 — Claude Code adapter (reuses the contract-test harness and provider config).

**Status:** ready-for-agent

- [ ] Wrapper subprocess translates SDK callbacks → normalized NDJSON → block union
- [ ] SIGTERM on the wrapper cancels cleanly; crash of the wrapper is a phase failure, not a hang
- [ ] Contract-test harness green for Copilot (skippable where the SDK/auth is absent)
