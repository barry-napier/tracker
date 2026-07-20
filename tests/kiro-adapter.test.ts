import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/server/provider.ts";
import { AcpMapper, probeFromSessionNew, promptOutcome } from "../src/server/providers/kiro.ts";

/** Feed a sequence of session/update payloads and collect every event. */
function feedAll(mapper: AcpMapper, updates: unknown[]): AgentEvent[] {
  const events = updates.flatMap((update) => mapper.update(update));
  return [...events, ...mapper.finish()];
}

const chunk = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string) => ({
  sessionUpdate: kind,
  content: { type: "text", text },
});

describe("AcpMapper", () => {
  test("message chunks stream as one text block with deltas — live typing", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      chunk("agent_message_chunk", "Working "),
      chunk("agent_message_chunk", "through "),
      chunk("agent_message_chunk", "it."),
    ]);
    // One block opened empty, each chunk a delta onto it, closed at finish —
    // this is what streamsPartialText: true promises the drawer.
    expect(events).toEqual([
      { type: "block.open", blockId: "kiro-1", block: { kind: "text", text: "" } },
      { type: "block.delta", blockId: "kiro-1", textDelta: "Working " },
      { type: "block.delta", blockId: "kiro-1", textDelta: "through " },
      { type: "block.delta", blockId: "kiro-1", textDelta: "it." },
      { type: "block.close", blockId: "kiro-1" },
    ]);
  });

  test("thought chunks stream as a thinking block, closed when prose starts", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      chunk("agent_thought_chunk", "Hmm, "),
      chunk("agent_thought_chunk", "the contract file."),
      chunk("agent_message_chunk", "Writing it now."),
    ]);
    const kinds = events.map((e) => e.type);
    // The thinking block must close before the text block opens.
    expect(kinds).toEqual([
      "block.open",
      "block.delta",
      "block.delta",
      "block.close",
      "block.open",
      "block.delta",
      "block.close",
    ]);
    const opens = events.filter((e) => e.type === "block.open");
    expect(opens.map((e) => (e.type === "block.open" ? e.block.kind : ""))).toEqual([
      "thinking",
      "text",
    ]);
  });

  test("a tool call interrupts an open text block and lands whole", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      chunk("agent_message_chunk", "Let me write it."),
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Write kb/contract.md",
        kind: "edit",
        status: "pending",
        rawInput: { path: "kb/contract.md" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "wrote 2 lines" } }],
      },
    ]);
    const opens = events.filter((e) => e.type === "block.open");
    expect(opens.map((e) => (e.type === "block.open" ? e.block : null))).toEqual([
      { kind: "text", text: "" },
      { kind: "tool_call", tool: "Write kb/contract.md", input: JSON.stringify({ path: "kb/contract.md" }) },
      { kind: "tool_result", tool: "Write kb/contract.md", output: "wrote 2 lines", isError: false },
    ]);
    // Every open block is closed by the end.
    const openIds = new Set<string>();
    for (const event of events) {
      if (event.type === "block.open") openIds.add(event.blockId);
      if (event.type === "block.close") openIds.delete(event.blockId);
    }
    expect([...openIds]).toEqual([]);
  });

  test("a failed tool lands as an error result", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run tests", kind: "execute" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
      },
    ]);
    const result = events.find(
      (e) => e.type === "block.open" && e.block.kind === "tool_result",
    ) as Extract<AgentEvent, { type: "block.open" }>;
    expect(result.block).toMatchObject({ kind: "tool_result", output: "exit 1", isError: true });
  });

  test("in-progress tool updates emit nothing — only terminal statuses land", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Search", kind: "search" },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
    ]);
    const results = events.filter((e) => e.type === "block.open" && e.block.kind === "tool_result");
    expect(results).toHaveLength(1);
  });

  test("unknown update kinds and malformed payloads are ignored, never thrown", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "_kiro.dev/metadata", whatever: true },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      null,
      42,
      "nonsense",
      {},
      { sessionUpdate: "agent_message_chunk" }, // chunk with no content
      chunk("agent_message_chunk", "still here"),
    ]);
    const opens = events.filter((e) => e.type === "block.open");
    expect(opens).toHaveLength(1);
    expect(events.some((e) => e.type === "block.delta" && e.textDelta === "still here")).toBe(true);
  });

  test("block ids are unique across the whole session", () => {
    const mapper = new AcpMapper();
    const events = feedAll(mapper, [
      chunk("agent_message_chunk", "one"),
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "T", kind: "edit" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      chunk("agent_message_chunk", "two"),
    ]);
    const ids = events.filter((e) => e.type === "block.open").map((e) => e.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("promptOutcome", () => {
  test("end_turn is the only success", () => {
    expect(promptOutcome({ stopReason: "end_turn" })).toEqual({ outcome: "completed" });
  });

  test("cancelled maps to cancelled", () => {
    expect(promptOutcome({ stopReason: "cancelled" })).toEqual({ outcome: "cancelled" });
  });

  test("any other stop reason is provider-reported failure", () => {
    expect(promptOutcome({ stopReason: "refusal" })).toMatchObject({
      outcome: "failed",
      failureReason: expect.stringContaining("refusal"),
    });
    expect(promptOutcome({ stopReason: "max_tokens" })).toMatchObject({ outcome: "failed" });
  });

  test("a malformed response is failure with the payload in the reason", () => {
    expect(promptOutcome({})).toMatchObject({ outcome: "failed" });
    expect(promptOutcome(null)).toMatchObject({ outcome: "failed" });
  });
});

describe("probeFromSessionNew", () => {
  test("a session with a model catalog: ok with the ids", () => {
    const result = probeFromSessionNew({
      sessionId: "s-1",
      models: {
        currentModelId: "auto",
        availableModels: [{ modelId: "auto" }, { modelId: "claude-sonnet-4.5" }, { junk: true }],
      },
    });
    expect(result).toEqual({ ok: true, models: ["auto", "claude-sonnet-4.5"] });
  });

  test("no sessionId: not ok — the response is quoted, not guessed at", () => {
    const result = probeFromSessionNew({ unexpected: "shape" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no sessionId");
  });
});
