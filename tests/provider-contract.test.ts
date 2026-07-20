import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/server/provider.ts";
import {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeProvider,
  type ClaudeCodeConfig,
} from "../src/server/providers/claude-code.ts";
import { FakeProvider, phaseFromPrompt } from "../src/server/providers/fake.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  CONTRACT_PROMPT,
  collectEvents,
  describeProviderContract,
} from "./provider-contract.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, "fixtures", "fake-claude.mjs");
// Committed mode bits survive a clone, but a fresh checkout on a umask that
// strips them would fail confusingly — assert it here instead.
chmodSync(FAKE_CLAUDE, 0o755);

/** The adapter pointed at the scripted stub binary rather than the real CLI. */
function stubbed(mode: string, config: ClaudeCodeConfig = {}): ClaudeCodeProvider {
  return new ClaudeCodeProvider(() => ({
    binaryPath: FAKE_CLAUDE,
    env: { FAKE_CLAUDE_MODE: mode },
    ...config,
  }));
}

// ---------------------------------------------------------------------------
// The contract, run against every adapter.
// ---------------------------------------------------------------------------

describeProviderContract({
  name: "FakeProvider",
  succeeds: () =>
    new FakeProvider(async function* ({ prompt, cwd }) {
      const phase = phaseFromPrompt(prompt);
      yield { type: "block.open", blockId: "p", block: { kind: "prompt", text: prompt } };
      yield { type: "block.close", blockId: "p" };
      mkdirSync(path.join(cwd, "kb"), { recursive: true });
      writeFileSync(path.join(cwd, "kb", `${phase}.md`), `# ${phase}\n`);
      return { outcome: "completed" };
    }),
  hangs: () =>
    new FakeProvider(async function* () {
      yield { type: "block.open", blockId: "p", block: { kind: "text", text: "working" } };
      yield { type: "block.close", blockId: "p" };
      await new Promise(() => {});
      return { outcome: "completed" };
    }),
});

describeProviderContract({
  name: "ClaudeCodeProvider (scripted binary)",
  succeeds: () => stubbed("success"),
  hangs: () => stubbed("hang"),
});

/**
 * The same contract against the real CLI. Skipped when `claude` is not on
 * PATH, per the ticket — and gated behind an opt-in even when it is, because
 * this spends real money and real seconds on every `npm test`. The scripted
 * binary above covers the identical spawn path for free; this run exists to
 * catch the CLI changing its wire format underneath us.
 */
function liveClaudeSkipReason(): string | undefined {
  if (process.env.TRACKER_LIVE_PROVIDER_TESTS !== "1") {
    return "set TRACKER_LIVE_PROVIDER_TESTS=1 to spend real tokens";
  }
  try {
    execFileSync("which", ["claude"], { stdio: "ignore" });
    return undefined;
  } catch {
    return "claude CLI not on PATH";
  }
}

describeProviderContract({
  name: "ClaudeCodeProvider (live CLI)",
  skip: liveClaudeSkipReason(),
  succeeds: () => new ClaudeCodeProvider(() => ({})),
  hangs: () => new ClaudeCodeProvider(() => ({})),
  timeoutMs: 180_000,
});

// ---------------------------------------------------------------------------
// Claude-specific endings the shared contract does not cover.
// ---------------------------------------------------------------------------

test("Claude Code declares the capabilities ticket 38 specifies", () => {
  // Named values, not just booleans: streamsPartialText false is a claim
  // about this wire format (whole blocks, never deltas) that a future
  // refactor toward deltas would have to consciously flip.
  expect(CLAUDE_CODE_CAPABILITIES).toEqual({
    costReporting: true,
    streamsPartialText: false,
    emitsThinking: true,
  });
  expect(stubbed("success").capabilities).toBe(CLAUDE_CODE_CAPABILITIES);
});

describe("ClaudeCodeProvider endings", () => {
  async function run(provider: ClaudeCodeProvider) {
    const cwd = mkdtempSync(path.join(tmpdir(), "claude-adapter-"));
    try {
      const handle = provider.runPhase(CONTRACT_PROMPT, cwd);
      const events = await collectEvents(handle);
      const result = await handle.done;
      // Snapshot before the finally below removes the directory — a lazy
      // existsSync closure would answer about a path that no longer exists.
      return { result, events, wroteContract: existsSync(path.join(cwd, "kb", "contract.md")) };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  test("the prompt opens the conversation — the CLI never echoes it back", async () => {
    const { events } = await run(stubbed("success"));
    const first = events[0];
    expect(first).toMatchObject({ type: "block.open", block: { kind: "prompt", text: CONTRACT_PROMPT } });
  });

  test("reports the session id, cost and usage the result line carried", async () => {
    const { result } = await run(stubbed("success"));
    expect(result.providerSessionId).toBe("fake-session-1");
    expect(result.costUsd).toBe(0.0123);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  test("thinking and tool blocks reach the log", async () => {
    const { events } = await run(stubbed("success"));
    const kinds = events
      .filter((e) => e.type === "block.open")
      .map((e) => (e.type === "block.open" ? e.block.kind : ""));
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
  });

  test("a truncated stream with no result line crashes rather than failing", async () => {
    const { result } = await run(stubbed("truncated"));
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toMatch(/no result line/i);
  });

  test("an error result line is a provider-reported failure", async () => {
    const { result } = await run(stubbed("error"));
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("the fake binary was told to fail");
  });

  test("malformed and unknown lines mid-stream do not kill the phase", async () => {
    const { result, wroteContract } = await run(stubbed("garbage"));
    expect(result.outcome).toBe("completed");
    expect(wroteContract).toBe(true);
  });

  test("a missing binary crashes with a legible reason", async () => {
    const provider = new ClaudeCodeProvider(() => ({
      binaryPath: path.join(here, "fixtures", "definitely-not-here"),
    }));
    const { result } = await run(provider);
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toContain("ENOENT");
  });

  /** What the stub echoed back as its resolved --model, from the log. */
  function echoedModel(events: AgentEvent[]): string | undefined {
    for (const event of events) {
      if (event.type !== "block.open" || event.block.kind !== "text") continue;
      const match = /^model=(.+)$/.exec(event.block.text);
      if (match) return match[1];
    }
    return undefined;
  }

  test("config is resolved per phase, so a settings edit lands on the next run", async () => {
    let model = "first-model";
    const provider = new ClaudeCodeProvider(() => ({
      binaryPath: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "success" },
      model,
    }));
    // The stub echoes whatever --model it was handed. Seeing the second value
    // come back proves the adapter re-read config rather than capturing it at
    // construction — the mechanism behind "a settings edit lands on the next
    // claim without a restart".
    expect(echoedModel((await run(provider)).events)).toBe("first-model");
    model = "second-model";
    expect(echoedModel((await run(provider)).events)).toBe("second-model");
  });
});
