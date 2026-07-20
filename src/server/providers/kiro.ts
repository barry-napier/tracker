import { spawn } from "node:child_process";
import type {
  AgentEvent,
  PhaseHandle,
  Provider,
  ProviderCapabilities,
  RunPhaseOpts,
  RunResult,
} from "../provider.ts";

/**
 * The Kiro adapter (ticket 39): `kiro-cli acp`, JSON-RPC 2.0 newline-delimited
 * over stdio, per the research in issue 02. ACP and never headless chat — the
 * chat surface is ANSI-laden plain text with no session id and exit codes
 * that lie (verified: exit 0 with the only tool call denied). Success is
 * judged structurally: the session/prompt response's `stopReason`.
 *
 * Same split as the Claude adapter and for the same reason: AcpMapper is pure
 * (an update payload in, block events out), so the streaming and tolerance
 * rules are provable without a subprocess; KiroProvider stays transport.
 */

/** App-level Kiro config. No budget field — Kiro has no native cap to set. */
export interface KiroConfig {
  /** Absolute path to `kiro-cli`; undefined = resolve on PATH. */
  binaryPath?: string;
  /** Pinned model — off Kiro's `auto` router, so runs stay comparable. */
  model?: string;
  /** Extra environment for the child, merged over the parent's. */
  env?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * ACP `session/update` payloads → the block-level event union. Kiro streams:
 * message and thought chunks arrive word-by-word, so this mapper keeps one
 * streaming block open and feeds it deltas (capabilities.streamsPartialText)
 * — the drawer renders live typing. Tool calls land whole, interrupting any
 * open stream. Unknown update kinds (`plan`, `_kiro.dev/*` extensions, and
 * whatever ships next release) are dropped, never thrown on.
 */
export class AcpMapper {
  #blocks = 0;
  /** The open streaming block, if any — text or thinking, fed by deltas. */
  #stream: { id: string; kind: "text" | "thinking" } | undefined;
  /** Tool titles by call id, so results carry the tool's name, not an id. */
  #toolTitles = new Map<string, string>();
  /** Calls whose terminal result already landed — later updates are echoes. */
  #landed = new Set<string>();

  update(payload: unknown): AgentEvent[] {
    if (!isRecord(payload)) return [];
    switch (payload.sessionUpdate) {
      case "agent_message_chunk":
        return this.#chunk("text", payload);
      case "agent_thought_chunk":
        return this.#chunk("thinking", payload);
      case "tool_call":
        return this.#toolCall(payload);
      case "tool_call_update":
        return this.#toolUpdate(payload);
      default:
        return [];
    }
  }

  /** Close any open streaming block — the turn is over. */
  finish(): AgentEvent[] {
    return this.#closeStream();
  }

  #chunk(kind: "text" | "thinking", payload: Record<string, unknown>): AgentEvent[] {
    const content = payload.content;
    if (!isRecord(content) || typeof content.text !== "string") return [];
    const events: AgentEvent[] = [];
    if (this.#stream?.kind !== kind) {
      events.push(...this.#closeStream());
      const id = this.#nextId();
      this.#stream = { id, kind };
      // Opened empty: the chunk itself rides as a delta, so the drawer's
      // append path is the only path and the first word streams like the rest.
      events.push({ type: "block.open", blockId: id, block: { kind, text: "" } });
    }
    events.push({ type: "block.delta", blockId: this.#stream!.id, textDelta: content.text });
    return events;
  }

  #toolCall(payload: Record<string, unknown>): AgentEvent[] {
    const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const title =
      typeof payload.title === "string" && payload.title !== ""
        ? payload.title
        : typeof payload.kind === "string"
          ? payload.kind
          : (callId ?? "tool");
    if (callId !== undefined) this.#toolTitles.set(callId, title);
    const id = this.#nextId();
    return [
      ...this.#closeStream(),
      {
        type: "block.open",
        blockId: id,
        block: { kind: "tool_call", tool: title, input: JSON.stringify(payload.rawInput ?? {}) },
      },
      { type: "block.close", blockId: id },
    ];
  }

  #toolUpdate(payload: Record<string, unknown>): AgentEvent[] {
    // Only terminal statuses land as results; in_progress updates are
    // bookkeeping. A duplicate terminal update is an echo, not a new result.
    const status = payload.status;
    if (status !== "completed" && status !== "failed") return [];
    const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : "tool";
    if (this.#landed.has(callId)) return [];
    this.#landed.add(callId);
    const id = this.#nextId();
    return [
      ...this.#closeStream(),
      {
        type: "block.open",
        blockId: id,
        block: {
          kind: "tool_result",
          tool: this.#toolTitles.get(callId) ?? callId,
          output: flattenToolContent(payload.content),
          isError: status === "failed",
        },
      },
      { type: "block.close", blockId: id },
    ];
  }

  #closeStream(): AgentEvent[] {
    if (this.#stream === undefined) return [];
    const { id } = this.#stream;
    this.#stream = undefined;
    return [{ type: "block.close", blockId: id }];
  }

  #nextId(): string {
    return `kiro-${++this.#blocks}`;
  }
}

/**
 * ACP tool content is an array of typed parts: text rides inside a nested
 * `content` block, diffs carry paths. Anything unrecognized flattens to
 * nothing rather than noise.
 */
function flattenToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "content" && isRecord(part.content) && typeof part.content.text === "string") {
        return part.content.text;
      }
      if (part.type === "diff" && typeof part.path === "string") return `diff ${part.path}`;
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * The session/prompt response → outcome. Kiro's exit codes lie (issue 02:
 * exit 0 with the only tool call denied), so the stop reason is the whole
 * verdict: `end_turn` and nothing else is success.
 */
export function promptOutcome(response: unknown): Pick<RunResult, "outcome" | "failureReason"> {
  const stopReason = isRecord(response) ? response.stopReason : undefined;
  if (stopReason === "end_turn") return { outcome: "completed" };
  if (stopReason === "cancelled") return { outcome: "cancelled" };
  return {
    outcome: "failed",
    failureReason: `kiro ended with stop reason ${
      typeof stopReason === "string" ? stopReason : JSON.stringify(response)
    }`,
  };
}

export const KIRO_CAPABILITIES: ProviderCapabilities = {
  // No cost in the prompt response — only human text on stderr (issue 02).
  costReporting: false,
  streamsPartialText: true,
  emitsThinking: true,
};

/** How long a graceful ACP cancel gets before SIGTERM finishes the job. */
const CANCEL_GRACE_MS = 2_000;

export class KiroProvider implements Provider {
  readonly capabilities = KIRO_CAPABILITIES;

  /** Config resolved per phase, same contract as the Claude adapter. */
  constructor(private readonly config: () => KiroConfig) {}

  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle {
    const config = this.config();
    const mapper = new AcpMapper();
    const queue: AgentEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;

    let resolveDone!: (result: RunResult) => void;
    const done = new Promise<RunResult>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
    let sessionId: string | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      finished = true;
      resolveDone(result);
      notify?.();
    };
    const emit = (events: AgentEvent[]): void => {
      if (events.length === 0) return;
      queue.push(...events);
      notify?.();
    };

    emit([
      { type: "block.open", blockId: "prompt", block: { kind: "prompt", text: prompt } },
      { type: "block.close", blockId: "prompt" },
    ]);

    const args = ["acp", "--trust-all-tools"];
    // Pinned off the `auto` router (ticket 39): comparable runs need one model.
    if (config.model !== undefined) args.push("--model", config.model);
    const child = spawn(config.binaryPath ?? "kiro-cli", args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // --- JSON-RPC plumbing: requests out, responses correlated by id. ---
    let nextRpcId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const send = (message: Record<string, unknown>): void => {
      if (!child.stdin.writable) return;
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      } catch {
        // A torn pipe surfaces via the close handler; writing louder here
        // would just race it.
      }
    };
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++nextRpcId;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });

    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      killTimer = undefined;
      child.kill("SIGTERM");
    };
    const cancel = (): void => {
      cancelled = true;
      // Graceful-then-kill (ticket 39): the ACP cancel lets the agent stop
      // tool calls cleanly; the timer guarantees the phase actually ends even
      // when the agent ignores it.
      if (sessionId !== undefined) send({ method: "session/cancel", params: { sessionId } });
      killTimer = setTimeout(kill, CANCEL_GRACE_MS);
    };
    if (opts?.signal?.aborted) cancel();
    else opts?.signal?.addEventListener("abort", cancel, { once: true });

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return; // Interleaved noise is not the phase's failure.
      }
      if (!isRecord(message)) return;

      // Agent-to-client request. With --trust-all-tools Kiro should never ask
      // for permission, but a full-trust posture answers rather than hangs if
      // it does; anything else is politely refused so the turn can proceed.
      if (message.id !== undefined && typeof message.method === "string") {
        if (message.method === "session/request_permission") {
          const options = isRecord(message.params) ? message.params.options : undefined;
          const allow = (Array.isArray(options) ? options : []).find(
            (option): option is Record<string, unknown> =>
              isRecord(option) && typeof option.kind === "string" && option.kind.startsWith("allow"),
          );
          send({
            id: message.id,
            result: {
              outcome: allow
                ? { outcome: "selected", optionId: allow.optionId }
                : { outcome: "cancelled" },
            },
          });
        } else {
          send({ id: message.id, error: { code: -32601, message: "method not supported" } });
        }
        return;
      }

      // Response to one of ours.
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const waiter = pending.get(message.id);
        if (waiter === undefined) return;
        pending.delete(message.id);
        if ("error" in message) {
          waiter.reject(new Error(`kiro rpc error: ${JSON.stringify(message.error)}`));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }

      // Notification.
      if (message.method === "session/update" && isRecord(message.params)) {
        emit(mapper.update(message.params.update));
      }
    };

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr = (stderr + data).slice(-4000);
    });

    child.on("error", (error) => {
      emit(mapper.finish());
      finish({ outcome: cancelled ? "cancelled" : "crashed", failureReason: error.message });
    });
    child.on("close", (code) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (stdout.trim() !== "") handleLine(stdout);
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`kiro exited (${code ?? "signal"}) mid-request`));
      }
      pending.clear();
      emit(mapper.finish());
      if (settled) return;
      finish(
        cancelled
          ? { outcome: "cancelled", providerSessionId: sessionId }
          : {
              outcome: "crashed",
              failureReason: `kiro exited ${code ?? "on a signal"} before the turn ended${
                stderr.trim() === "" ? "" : ` — stderr: ${stderr.trim().slice(-1000)}`
              }`,
              providerSessionId: sessionId,
            },
      );
    });

    // The RPC conversation, driven eagerly so `done` settles unconsumed.
    void (async () => {
      try {
        await request("initialize", {
          protocolVersion: 1,
          // No client-side fs or terminal: the agent works its own worktree.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        const session = await request("session/new", { cwd, mcpServers: [] });
        sessionId = isRecord(session) && typeof session.sessionId === "string"
          ? session.sessionId
          : undefined;
        // Abort raced session setup: cancel() couldn't send session/cancel
        // without an id, so re-run it now that one exists.
        if (cancelled) {
          cancel();
          return;
        }
        const response = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        emit(mapper.finish());
        const outcome = promptOutcome(response);
        // Our own abort wins over whatever the response said — and the ACP
        // process is long-lived, so ending the phase means killing it.
        kill();
        finish(
          cancelled
            ? { outcome: "cancelled", providerSessionId: sessionId }
            : { ...outcome, providerSessionId: sessionId },
        );
      } catch (error) {
        emit(mapper.finish());
        kill();
        finish({
          outcome: cancelled ? "cancelled" : "crashed",
          failureReason: error instanceof Error ? error.message : String(error),
          providerSessionId: sessionId,
        });
      }
    })();

    async function* events(): AsyncGenerator<AgentEvent> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    }

    return { events: events(), done };
  }
}
