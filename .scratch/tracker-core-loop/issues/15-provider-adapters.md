# Implement the provider adapters

Type: task
Status: closed (superseded)

## Question

Build the `Provider` TS interface and three adapters per [Provider abstraction interface](09-provider-abstraction.md): Claude Code (`claude -p --output-format stream-json`, tolerant NDJSON parser), Kiro (`kiro-cli acp`, ACP JSON-RPC client over stdio), Copilot (official SDK inside a Tracker-owned wrapper subprocess emitting normalized NDJSON). Includes the block-level event union with delta updates, thin RunResult mapping, full-trust spawn flags, SIGTERM cancellation (ACP `session/cancel` first for Kiro), wall-clock timeout hook, and the three capability flags. Done when each adapter runs a scripted prompt in a scratch dir and yields the same normalized event sequence shape and RunResult.

## Superseded (2026-07-18)

Superseded by vertical slices: interface + FakeProvider → [26](26-fakeprovider-one-phase.md); Claude Code → [38](38-claude-code-adapter.md); Kiro → [39](39-kiro-adapter.md); Copilot → [40](40-copilot-adapter.md).
