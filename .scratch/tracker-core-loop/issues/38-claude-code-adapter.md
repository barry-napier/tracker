# 38 — Claude Code adapter, provider config, contract-test harness

**What to build:** The first real Provider adapter: spawn Claude Code headless (`-p`, stream-json output) in the phase's worktree, parse NDJSON tolerantly (unknown event types ignored, never thrown), map to the block-level event union, detect success per the research (exit 0 + result line + success subtype), SIGTERM cancellation, native budget cap as defense-in-depth. Plus the two things every later adapter reuses: app-level provider config (binary path, pinned model, extra env — surfaced minimally in the UI) and the adapter contract-test harness (run a scripted prompt in a scratch dir; assert normalized event sequence shape and RunResult; skippable where the CLI is absent). Capability flags: `costReporting` yes, `streamsPartialText` no, `emitsThinking` yes.

**Blocked by:** 26 — FakeProvider runs one phase.

**Status:** ready-for-agent

- [ ] A real Claude Code session runs a phase in a worktree; the drawer shows the full live conversation
- [ ] Tolerant parser: unknown NDJSON types/fields ignored; malformed line doesn't kill the run
- [ ] Success/failure/cancellation mapped per [the research](01-claude-code-headless.md); full-trust permission flag posture
- [ ] Provider config persisted app-level; promotion uses it; no per-ticket model knob
- [ ] Contract-test harness green for FakeProvider and Claude Code
