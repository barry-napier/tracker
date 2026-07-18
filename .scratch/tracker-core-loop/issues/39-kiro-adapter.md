# 39 — Kiro adapter

**What to build:** The Kiro adapter over ACP: spawn `kiro-cli acp`, speak JSON-RPC over stdio (new session with the worktree as cwd, prompt, map the update notification stream to the block union with text deltas), success on end-turn stop reason, cancellation via ACP cancel then SIGTERM, trust flags at launch, model pinned off Kiro's `auto` router via provider config. Capability flags: `costReporting` no, `streamsPartialText` yes, `emitsThinking` yes. Never the plain-text no-interactive chat mode (per [the research](02-kiro-cli-headless.md)).

**Blocked by:** 38 — Claude Code adapter (reuses the contract-test harness and provider config).

**Status:** ready-for-agent

- [ ] A real Kiro session runs a phase; deltas stream into the drawer as live-typing text
- [ ] ACP session lifecycle owned by the adapter; cancellation graceful-then-kill
- [ ] Contract-test harness green for Kiro (skippable where the CLI is absent)
