import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../src/server/provider.ts";
import {
  StreamJsonMapper,
  buildArgs,
  parseAuthStatus,
  toRunResult,
} from "../src/server/providers/claude-code.ts";

/** The open block a given event id belongs to, for asserting block shape. */
function opened(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "block.open" }>> {
  return events.filter((e) => e.type === "block.open");
}

/** Feed a whole transcript and collect every event it maps to. */
function feedAll(mapper: StreamJsonMapper, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((line) =>
    mapper.feed(typeof line === "string" ? line : JSON.stringify(line)),
  );
}

const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/tmp/wt",
  tools: ["Read", "Write"],
  model: "claude-opus-4-8",
  session_id: "sess-1",
};

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 0.0412,
  usage: { input_tokens: 120, output_tokens: 44 },
  session_id: "sess-1",
};

describe("StreamJsonMapper", () => {
  test("maps assistant content blocks to open/close pairs", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      INIT,
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reading the ticket." },
            { type: "text", text: "I'll write the contract file." },
            { type: "tool_use", id: "toolu_1", name: "Write", input: { path: "kb/plan.md" } },
          ],
        },
      },
    ]);

    expect(opened(events).map((e) => e.block)).toEqual([
      { kind: "thinking", text: "Reading the ticket." },
      { kind: "text", text: "I'll write the contract file." },
      { kind: "tool_call", tool: "Write", input: JSON.stringify({ path: "kb/plan.md" }) },
    ]);
    // Claude lands whole blocks: every open is followed by its own close, and
    // no deltas — streamsPartialText is false for this provider.
    expect(events.map((e) => e.type)).toEqual([
      "block.open",
      "block.close",
      "block.open",
      "block.close",
      "block.open",
      "block.close",
    ]);
  });

  test("maps tool results, string or block-array content, carrying is_error", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "wrote 2 lines", is_error: false },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [{ type: "text", text: "ENOENT" }],
              is_error: true,
            },
          ],
        },
      },
    ]);

    expect(opened(events).map((e) => e.block)).toEqual([
      { kind: "tool_result", tool: "toolu_1", output: "wrote 2 lines", isError: false },
      { kind: "tool_result", tool: "toolu_2", output: "ENOENT", isError: true },
    ]);
  });

  test("one message split across lines does not collide — real v2.1.159 shape", () => {
    // Captured from a live run: the CLI emits a thinking block and the
    // tool_use that follows it as two separate `assistant` lines sharing one
    // message.id, each with a single-element content array. Keying block ids
    // on id+index made both `<msg>-0`, merging them in the log view.
    const mapper = new StreamJsonMapper();
    const id = "msg_011CdD1EYAppMpDmAhUtJJjd";
    const events = feedAll(mapper, [
      { type: "assistant", message: { id, role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
      {
        type: "assistant",
        message: {
          id,
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_01AU", name: "Bash", input: { command: "ls" } }],
        },
      },
    ]);
    const ids = opened(events).map((e) => e.blockId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(opened(events).map((e) => e.block.kind)).toEqual(["thinking", "tool_call"]);
  });

  test("tool results on id-less user lines stay distinct", () => {
    // `user` lines carry no message.id, so the sequence is the only thing
    // keeping two tool results apart.
    const mapper = new StreamJsonMapper();
    const toolResult = (toolUseId: string) => ({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
      },
    });
    const events = feedAll(mapper, [toolResult("toolu_1"), toolResult("toolu_2")]);
    const ids = opened(events).map((e) => e.blockId);
    expect(new Set(ids).size).toBe(2);
  });

  test("block ids are unique across a transcript", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      {
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      },
      { type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "three" }] } },
    ]);
    const ids = opened(events).map((e) => e.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("tolerates malformed lines, unknown types, and unknown block kinds", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      "",
      "   ",
      "not json at all",
      '{"unterminated": ',
      JSON.stringify({ type: "some_future_event", payload: { nested: true } }),
      JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "future_block" }] } }),
      // A line whose shape is right but whose message is missing entirely.
      JSON.stringify({ type: "assistant" }),
      // A bare JSON scalar — valid JSON, not an object.
      "42",
      JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "survived" }] } }),
    ]);

    // Nothing threw, and the one legible block still came through.
    expect(opened(events).map((e) => e.block)).toEqual([{ kind: "text", text: "survived" }]);
  });

  test("captures session id, cost and usage from the result line", () => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT, SUCCESS_RESULT]);
    expect(mapper.sessionId).toBe("sess-1");
    expect(mapper.result).toEqual({
      subtype: "success",
      isError: false,
      costUsd: 0.0412,
      usage: { input_tokens: 120, output_tokens: 44 },
      resultText: "done",
    });
  });

  test("learns the session id from init even when the run dies before the result", () => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT]);
    expect(mapper.sessionId).toBe("sess-1");
    expect(mapper.result).toBeUndefined();
  });
});

describe("toRunResult", () => {
  const withResult = (patch: Record<string, unknown> = {}) => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT, { ...SUCCESS_RESULT, ...patch }]);
    return mapper;
  };

  test("exit 0 + success subtype + not is_error is the only success", () => {
    const result = toRunResult(withResult(), { code: 0, cancelled: false });
    expect(result).toEqual({
      outcome: "completed",
      providerSessionId: "sess-1",
      costUsd: 0.0412,
      usage: { input_tokens: 120, output_tokens: 44 },
    });
  });

  test("is_error on the result line is provider-reported failure, not a crash", () => {
    const result = toRunResult(withResult({ is_error: true, result: "budget exceeded" }), {
      code: 0,
      cancelled: false,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("budget exceeded");
    // Session id survives a failure so the phase execution records it.
    expect(result.providerSessionId).toBe("sess-1");
  });

  test("a non-success subtype fails even with exit 0 and is_error false", () => {
    const result = toRunResult(withResult({ subtype: "error_max_turns" }), {
      code: 0,
      cancelled: false,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("error_max_turns");
  });

  test("a non-zero exit fails even when the result line looked fine", () => {
    const result = toRunResult(withResult(), { code: 1, cancelled: false });
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("exit 1");
  });

  test("exit 0 with no result line is a truncated stream — crashed, not failed", () => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT]);
    const result = toRunResult(mapper, { code: 0, cancelled: false });
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toMatch(/no result line/i);
    expect(result.providerSessionId).toBe("sess-1");
  });

  test("a non-zero exit with no result line is failure, not a crash", () => {
    // The ordinary hard-error case: a refused flag or failed auth exits 1
    // having written nothing. Reading that as crashed would have the crash
    // policy retry an invocation that cannot ever work.
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT]);
    const result = toRunResult(mapper, { code: 1, cancelled: false });
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("exit 1");
  });

  test("permission denials reach the failure reason — the result text never names them", () => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [
      INIT,
      {
        ...SUCCESS_RESULT,
        subtype: "error_during_execution",
        is_error: true,
        result: "tool use aborted",
        permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf /" } }],
      },
    ]);
    const result = toRunResult(mapper, { code: 1, cancelled: false });
    expect(result.outcome).toBe("failed");
    expect(result.failureReason).toContain("Bash");
  });

  test("cancellation wins over whatever the exit looked like", () => {
    const mapper = new StreamJsonMapper();
    feedAll(mapper, [INIT]);
    // 143 is SIGTERM — what our own cancellation produces.
    expect(toRunResult(mapper, { code: 143, cancelled: true }).outcome).toBe("cancelled");
  });

  test("a spawn failure is a crash", () => {
    const mapper = new StreamJsonMapper();
    const result = toRunResult(mapper, {
      code: null,
      cancelled: false,
      spawnError: "spawn claude ENOENT",
    });
    expect(result.outcome).toBe("crashed");
    expect(result.failureReason).toContain("ENOENT");
  });
});

describe("StreamJsonMapper stream events (--include-partial-messages)", () => {
  const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event });

  test("streams thinking and text as open/delta/close; assistant line dedups", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      INIT,
      streamEvent({ type: "message_start" }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reading " } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the ticket." } }),
      // The signature delta carries no text and must not become a delta event.
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Plan:" } }),
      streamEvent({ type: "content_block_stop", index: 1 }),
      // The whole assistant line repeats both blocks (thinking redacted) plus
      // the tool_use that never streams: only the tool_use may land.
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Plan:" },
            { type: "tool_use", id: "toolu_1", name: "Write", input: {} },
          ],
        },
      },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      "block.open", // thinking
      "block.delta",
      "block.delta",
      "block.close",
      "block.open", // text
      "block.delta",
      "block.close",
      "block.open", // tool_use from the assistant line
      "block.close",
    ]);
    const deltas = events.filter((e) => e.type === "block.delta");
    expect(deltas.map((d) => (d as { textDelta: string }).textDelta)).toEqual([
      "Reading ",
      "the ticket.",
      "Plan:",
    ]);
    expect(opened(events).at(-1)?.block.kind).toBe("tool_call");
  });

  test("without stream events, whole assistant blocks land as before", () => {
    const mapper = new StreamJsonMapper();
    const events = feedAll(mapper, [
      INIT,
      {
        type: "assistant",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(opened(events)).toHaveLength(1);
  });
});

describe("buildArgs", () => {
  test("carries print mode, stream-json, and the full-trust posture", () => {
    const args = buildArgs("do the thing", {});
    expect(args).toContain("-p");
    expect(args).toContain("do the thing");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    // --verbose is required for stream-json in print mode.
    expect(args).toContain("--verbose");
    // In -p mode an unapproved tool call aborts the run — the orchestrator
    // owns isolation via the worktree, so the session runs full-trust.
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    // Verified to break OAuth/keychain auth for subscription users.
    expect(args).not.toContain("--bare");
    // Thinking text only exists in stream events; whole lines redact it.
    expect(args).toContain("--include-partial-messages");
  });

  test("pins the configured model and budget cap when set, omits them when not", () => {
    expect(buildArgs("x", { model: "claude-opus-4-8", maxBudgetUsd: 5 })).toEqual(
      expect.arrayContaining(["--model", "claude-opus-4-8", "--max-budget-usd", "5"]),
    );
    const bare = buildArgs("x", {});
    expect(bare).not.toContain("--model");
    expect(bare).not.toContain("--max-budget-usd");
  });
});

describe("parseAuthStatus", () => {
  test("logged in: ok with email and plan", () => {
    const result = parseAuthStatus(
      JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "max" }),
    );
    expect(result).toEqual({ ok: true, account: "a@b.c (max)" });
  });

  test("logged out: not ok, says how to fix it", () => {
    const result = parseAuthStatus(JSON.stringify({ loggedIn: false }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("claude auth login");
  });

  test("non-JSON output (older CLI): not ok, never throws", () => {
    const result = parseAuthStatus("Logged in as somebody\n");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no JSON");
  });
});
