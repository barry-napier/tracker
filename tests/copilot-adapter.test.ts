import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/server/provider.ts";
import {
  COPILOT_CAPABILITIES,
  CopilotProvider,
  WrapperMapper,
} from "../src/server/providers/copilot.ts";
import { CONTRACT_PROMPT, collectEvents } from "./provider-contract.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// No chmod ritual like the CLI fixtures: the wrapper is spawned as a node
// argument, never executed directly, so the exec bit is irrelevant.
const FAKE_WRAPPER = path.join(here, "fixtures", "fake-copilot-wrapper.mjs");

/** The adapter pointed at the scripted wrapper rather than the real one. */
function stubbedCopilot(mode: string, model?: string): CopilotProvider {
  return new CopilotProvider(() => ({
    wrapperPath: FAKE_WRAPPER,
    model,
    env: { FAKE_COPILOT_MODE: mode },
  }));
}

// ---------------------------------------------------------------------------
// The pure mapper: one protocol line in, block events out.
// ---------------------------------------------------------------------------

describe("WrapperMapper", () => {
  const feed = (mapper: WrapperMapper, line: Record<string, unknown>): AgentEvent[] =>
    mapper.feed(JSON.stringify(line));

  test("text deltas ride onto one open block; a kind switch closes it", () => {
    const mapper = new WrapperMapper();
    const first = feed(mapper, { type: "delta", kind: "thinking", text: "hm " });
    expect(first).toEqual([
      { type: "block.open", blockId: "copilot-1", block: { kind: "thinking", text: "" } },
      { type: "block.delta", blockId: "copilot-1", textDelta: "hm " },
    ]);
    // Same kind: no new block, just the delta.
    expect(feed(mapper, { type: "delta", kind: "thinking", text: "right." })).toEqual([
      { type: "block.delta", blockId: "copilot-1", textDelta: "right." },
    ]);
    // Kind switch: the thinking block closes, a text block opens.
    expect(feed(mapper, { type: "delta", kind: "text", text: "Done." })).toEqual([
      { type: "block.close", blockId: "copilot-1" },
      { type: "block.open", blockId: "copilot-2", block: { kind: "text", text: "" } },
      { type: "block.delta", blockId: "copilot-2", textDelta: "Done." },
    ]);
  });

  test("a tool call interrupts the stream and lands whole", () => {
    const mapper = new WrapperMapper();
    feed(mapper, { type: "delta", kind: "text", text: "writing " });
    const events = feed(mapper, {
      type: "tool_call",
      callId: "c1",
      tool: "write",
      input: '{"path":"kb/x.md"}',
    });
    expect(events).toEqual([
      { type: "block.close", blockId: "copilot-1" },
      {
        type: "block.open",
        blockId: "copilot-2",
        block: { kind: "tool_call", tool: "write", input: '{"path":"kb/x.md"}' },
      },
      { type: "block.close", blockId: "copilot-2" },
    ]);
  });

  test("a tool result lands whole and a duplicate callId is an echo", () => {
    const mapper = new WrapperMapper();
    const line = {
      type: "tool_result",
      callId: "c1",
      tool: "write",
      output: "wrote it",
      isError: false,
    };
    expect(feed(mapper, line)).toEqual([
      {
        type: "block.open",
        blockId: "copilot-1",
        block: { kind: "tool_result", tool: "write", output: "wrote it", isError: false },
      },
      { type: "block.close", blockId: "copilot-1" },
    ]);
    expect(feed(mapper, line)).toEqual([]);
  });

  test("the session and result lines are bookkeeping, never rendered", () => {
    const mapper = new WrapperMapper();
    expect(feed(mapper, { type: "session", sessionId: "s-1" })).toEqual([]);
    expect(mapper.sessionId).toBe("s-1");
    expect(
      feed(mapper, {
        type: "result",
        outcome: "failed",
        failureReason: "quota",
        usage: { premiumRequests: 2 },
      }),
    ).toEqual([]);
    expect(mapper.result).toEqual({
      outcome: "failed",
      failureReason: "quota",
      usage: { premiumRequests: 2 },
    });
  });

  test("garbage and unknown line types are dropped, never thrown on", () => {
    const mapper = new WrapperMapper();
    expect(mapper.feed("not json {{{")).toEqual([]);
    expect(mapper.feed("")).toEqual([]);
    expect(feed(mapper, { type: "next-release-novelty", data: 1 })).toEqual([]);
    // A malformed result must not poison the real one that follows.
    expect(feed(mapper, { type: "result", outcome: "nonsense" })).toEqual([]);
    expect(mapper.result).toBeUndefined();
    feed(mapper, { type: "result", outcome: "completed" });
    expect(mapper.result).toEqual({ outcome: "completed", failureReason: undefined, usage: undefined });
  });

  test("finish closes an open stream so no block is left dangling", () => {
    const mapper = new WrapperMapper();
    feed(mapper, { type: "delta", kind: "text", text: "tail" });
    expect(mapper.finish()).toEqual([{ type: "block.close", blockId: "copilot-1" }]);
    expect(mapper.finish()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Endings the shared contract does not cover, against the scripted wrapper.
// ---------------------------------------------------------------------------

describe("CopilotProvider endings", () => {
  async function runCopilot(provider: CopilotProvider, opts?: { signal?: AbortSignal }) {
    const cwd = mkdtempSync(path.join(tmpdir(), "copilot-adapter-"));
    try {
      const handle = provider.runPhase(CONTRACT_PROMPT, cwd, opts);
      const events = await collectEvents(handle);
      const result = await handle.done;
      return { result, events, wroteContract: existsSync(path.join(cwd, "kb", "contract.md")) };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  test("declares ticket 40's capabilities — deltas and thinking yes, USD no", () => {
    expect(COPILOT_CAPABILITIES).toEqual({
      costReporting: false,
      streamsPartialText: true,
      emitsThinking: true,
    });
    expect(stubbedCopilot("success").capabilities).toBe(COPILOT_CAPABILITIES);
  });

  test("success carries the session id and premium-request usage", async () => {
    const { result, events } = await runCopilot(stubbedCopilot("success"));
    expect(result.outcome).toBe("completed");
    expect(result.providerSessionId).toBe("fake-copilot-session-1");
    // Partial cost reporting: premium-request counts ride in usage; no USD.
    expect(result.usage).toMatchObject({ premiumRequests: 2 });
    expect(result.costUsd).toBeUndefined();
    const deltas = events.filter((e) => e.type === "block.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(4);
    const kinds = events
      .filter((e) => e.type === "block.open")
      .map((e) => (e.type === "block.open" ? e.block.kind : ""));
    expect(kinds).toEqual(
      expect.arrayContaining(["prompt", "thinking", "text", "tool_call", "tool_result"]),
    );
  });

  test("the configured model reaches the wrapper over stdin", async () => {
    const { events } = await runCopilot(stubbedCopilot("success", "gpt-5"));
    const text = events
      .filter((e) => e.type === "block.delta")
      .map((e) => (e.type === "block.delta" ? e.textDelta : ""))
      .join("");
    expect(text).toContain("model=gpt-5");
  });

  test("a failed result line is provider-reported failure, not a crash", async () => {
    const { result } = await runCopilot(stubbedCopilot("failed"));
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("quota: out of premium requests");
  });

  test("the wrapper dying without a result line is a crash, not a hang", async () => {
    const { result } = await runCopilot(stubbedCopilot("crash-mid"));
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toMatch(/before reporting a result/);
    // The wrapper's last words on stderr are the diagnosis.
    expect(result.failureReason).toContain("fake wrapper told to crash");
  });

  test("a missing wrapper crashes with a legible reason", async () => {
    const provider = new CopilotProvider(() => ({
      wrapperPath: path.join(here, "fixtures", "definitely-not-here.mjs"),
    }));
    const { result } = await runCopilot(provider);
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toMatch(/Cannot find module|ENOENT/);
  });

  test("SIGTERM cancels a compliant wrapper well inside the kill grace", async () => {
    const controller = new AbortController();
    const cwd = mkdtempSync(path.join(tmpdir(), "copilot-adapter-"));
    try {
      const handle = stubbedCopilot("hang").runPhase(CONTRACT_PROMPT, cwd, {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = Date.now();
      controller.abort();
      const result = await handle.done;
      expect(result.outcome).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a wrapper lingering after its result line is axed, not waited on", async () => {
    // The verdict arrived; the wrapper's SDK cleanup then wedged. The phase
    // must still end — completed, since the result line is the verdict.
    const { result, wroteContract } = await runCopilot(stubbedCopilot("linger"));
    expect(result.outcome).toBe("completed");
    expect(wroteContract).toBe(true);
  }, 15_000);

  test("a wrapper that ignores SIGTERM meets SIGKILL, so the phase still ends", async () => {
    const controller = new AbortController();
    const cwd = mkdtempSync(path.join(tmpdir(), "copilot-adapter-"));
    try {
      const handle = stubbedCopilot("ignore-term").runPhase(CONTRACT_PROMPT, cwd, {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort();
      const result = await handle.done;
      expect(result.outcome).toBe("cancelled");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
