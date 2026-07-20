import { spawn } from "node:child_process";
import type {
  AgentBlock,
  AgentEvent,
  PhaseHandle,
  ProbeResult,
  Provider,
  ProviderCapabilities,
  RunPhaseOpts,
  RunResult,
} from "../provider.ts";

/**
 * The first real adapter (ticket 38): Claude Code headless, per the research
 * in issue 01. `claude -p <prompt> --output-format stream-json --verbose`
 * spawned with `cwd` set to the phase's worktree, its NDJSON mapped to the
 * block-level event union.
 *
 * The parse and the spawn are deliberately separate. StreamJsonMapper is pure
 * — a line in, events out — so the tolerance rules that matter most (a
 * malformed line must never kill a running phase) are provable without a
 * subprocess; ClaudeCodeProvider stays a thin transport around it.
 */

/** App-level provider config (ticket 38); no per-ticket knob by design. */
export interface ClaudeCodeConfig {
  /** Absolute path to the `claude` binary; undefined = resolve on PATH. */
  binaryPath?: string;
  /** Pinned model, app-wide. Undefined = whatever the CLI defaults to. */
  model?: string;
  /** Native budget cap, defense-in-depth over the orchestrator's own limits. */
  maxBudgetUsd?: number;
  /** Extra environment for the child, merged over the parent's. */
  env?: Record<string, string>;
}

/** The terminal `result` line, normalized. */
export interface ClaudeResultLine {
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  usage?: Record<string, unknown>;
  resultText?: string;
  /**
   * Tools the run asked for and was refused. In `-p` mode there is nobody to
   * approve one, so a denial aborts the run — and the result text alone
   * rarely says which tool did it. Worth carrying into the failure reason.
   */
  permissionDenials?: unknown[];
}

/** How the child ended, as toRunResult needs to see it. */
export interface ChildExit {
  /** Exit code, or null when the child died on a signal or never spawned. */
  code: number | null;
  /** Our own SIGTERM — the orchestrator cancelling, never the work failing. */
  cancelled: boolean;
  /** Set when the process could not be spawned at all (missing binary). */
  spawnError?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Claude's stream-json NDJSON → the block-level event union. Every unknown
 * shape is dropped rather than thrown on: the CLI adds event types and block
 * kinds between releases, and a phase that has done real work must not die
 * because one line was unrecognizable.
 */
export class StreamJsonMapper {
  #sessionId: string | undefined;
  #result: ClaudeResultLine | undefined;
  /**
   * Blocks emitted so far. This, not the content index, is what makes a block
   * id unique: the CLI splits one logical message across several NDJSON lines
   * — verified against v2.1.159, where a thinking block and the tool_use that
   * follows it arrive as two `assistant` lines carrying the SAME `message.id`
   * and a single-element `content` array each. Keying on `id`+index therefore
   * collides on `<msg>-0` every time, and the log view would merge two
   * unrelated blocks into one.
   */
  #blocks = 0;

  /** The session id from `system/init` or any later line carrying one. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The terminal result line, once seen. Absent = the stream was truncated. */
  get result(): ClaudeResultLine | undefined {
    return this.#result;
  }

  /** Feed one NDJSON line. Returns the events it maps to — often none. */
  feed(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed line: the CLI interleaved something, or the stream tore.
      // Neither is this phase's failure — the result line still decides.
      return [];
    }
    if (!isRecord(parsed)) return [];

    if (typeof parsed.session_id === "string") this.#sessionId = parsed.session_id;

    switch (parsed.type) {
      case "assistant":
        return this.#fromMessage(parsed, assistantBlock);
      case "user":
        return this.#fromMessage(parsed, toolResultBlock);
      case "result":
        this.#result = {
          subtype: typeof parsed.subtype === "string" ? parsed.subtype : undefined,
          isError: parsed.is_error === true,
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
          usage: isRecord(parsed.usage) ? parsed.usage : undefined,
          resultText: typeof parsed.result === "string" ? parsed.result : undefined,
          permissionDenials: Array.isArray(parsed.permission_denials)
            ? parsed.permission_denials
            : undefined,
        };
        return [];
      default:
        // system/init and every future event type: nothing to render.
        return [];
    }
  }

  /** Walk a message's content array, mapping what the caller recognizes. */
  #fromMessage(
    line: Record<string, unknown>,
    map: (block: Record<string, unknown>) => AgentBlock | undefined,
  ): AgentEvent[] {
    const message = line.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    // `user` lines (tool results) carry no message id at all; the sequence
    // below is what keeps those distinct, so the label can stay a label.
    const messageId = typeof message.id === "string" ? message.id : "anon";
    const events: AgentEvent[] = [];
    for (const raw of message.content) {
      if (!isRecord(raw)) continue;
      const block = map(raw);
      if (block === undefined) continue;
      // Claude lands whole blocks rather than streaming deltas onto them, so
      // each opens and closes in one step (capabilities.streamsPartialText).
      const blockId = `${messageId}-${++this.#blocks}`;
      events.push({ type: "block.open", blockId, block });
      events.push({ type: "block.close", blockId });
    }
    return events;
  }
}

function assistantBlock(block: Record<string, unknown>): AgentBlock | undefined {
  switch (block.type) {
    case "thinking":
      return { kind: "thinking", text: String(block.thinking ?? "") };
    case "text":
      return { kind: "text", text: String(block.text ?? "") };
    case "tool_use":
      return {
        kind: "tool_call",
        tool: String(block.name ?? "tool"),
        input: JSON.stringify(block.input ?? {}),
      };
    default:
      return undefined;
  }
}

function toolResultBlock(block: Record<string, unknown>): AgentBlock | undefined {
  if (block.type !== "tool_result") return undefined;
  return {
    kind: "tool_result",
    // Only the tool_use_id ties a result to its call; the CLI does not repeat
    // the tool's name here, and inventing one would be a lie in the log.
    tool: String(block.tool_use_id ?? "tool"),
    output: flattenContent(block.content),
    isError: block.is_error === true,
  };
}

/** Tool result content is a string or an array of content blocks. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * Decide the RunResult from what the stream said and how the child ended.
 * Success is the narrow case the research pins down: exit 0 AND a terminal
 * result line AND `subtype === "success"` AND `is_error === false`.
 */
export function toRunResult(mapper: StreamJsonMapper, exit: ChildExit): RunResult {
  const providerSessionId = mapper.sessionId;
  // Our own SIGTERM. The orchestrator is quitting; nothing here is a verdict
  // on the work, so this must never read as failure.
  if (exit.cancelled) return { outcome: "cancelled", providerSessionId };
  if (exit.spawnError !== undefined) {
    return { outcome: "crashed", failureReason: exit.spawnError, providerSessionId };
  }

  const result = mapper.result;
  const base = { providerSessionId, costUsd: result?.costUsd, usage: result?.usage };
  // A non-zero exit is checked first and on its own: issue 01 pins "exit 0 =
  // success, 1 = error", so the CLI refusing a flag or failing auth — which
  // exits 1 with no result line at all — is the agent failing, not the stream
  // tearing. Testing for the missing result first would call that crashed and
  // have the crash policy retry an invocation that can never work.
  if (exit.code !== 0) {
    return {
      outcome: "failed",
      failureReason: `claude exit ${exit.code}${result ? detail(result) : ""}`,
      ...base,
    };
  }
  // Exit 0 with no terminal result line: the stream was truncated (a
  // documented CLI bug pre-2.1.208) or the child died mid-sentence. That is a
  // transport blow-up, not wrong work — crashed, so the crash policy retries
  // rather than the bounce machinery blaming the agent for work it may well
  // have done.
  if (result === undefined) {
    return {
      outcome: "crashed",
      failureReason: "claude exited 0 with no result line — stream truncated",
      providerSessionId,
    };
  }

  if (result.isError) {
    return { outcome: "failed", failureReason: `claude reported an error${detail(result)}`, ...base };
  }
  if (result.subtype !== "success") {
    return {
      outcome: "failed",
      failureReason: `claude ended with subtype ${result.subtype ?? "(none)"}${detail(result)}`,
      ...base,
    };
  }
  return { outcome: "completed", ...base };
}

/** The CLI's own last words, when it left any — the most useful diagnosis. */
function detail(result: ClaudeResultLine): string {
  const text = result.resultText?.trim();
  const said = text ? `: ${text.slice(0, 500)}` : "";
  // A denial is the one failure whose cause is never in the result text.
  const denials = result.permissionDenials;
  return denials !== undefined && denials.length > 0
    ? `${said} (denied tools: ${JSON.stringify(denials).slice(0, 300)})`
    : said;
}

/** The argv for one phase. Exported so the posture is assertable, not implied. */
export function buildArgs(prompt: string, config: ClaudeCodeConfig): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // stream-json in print mode requires --verbose; without it the CLI refuses.
    "--verbose",
    // Full-trust posture: in -p mode there is nobody to answer a permission
    // prompt, so an unapproved tool call would abort the run. Isolation is the
    // orchestrator's job — the phase runs in a throwaway git worktree.
    "--permission-mode",
    "bypassPermissions",
  ];
  if (config.model !== undefined) args.push("--model", config.model);
  // Defense-in-depth only: the orchestrator's own limits are the real budget.
  if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));
  return args;
}

/**
 * `claude auth status` stdout → ProbeResult. The CLI prints JSON by default
 * (verified against v2.1.215): loggedIn, authMethod, email,
 * subscriptionType. Zero tokens — it reads the local credential store, no
 * API call. Pure, so the shapes that matter (logged out, non-JSON output
 * from an older CLI) are provable without a subprocess.
 */
export function parseAuthStatus(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // An older CLI without JSON output, or a wrapper printing noise. The
    // binary ran, but nothing here is worth guessing at.
    return { ok: false, error: `claude auth status printed no JSON: ${stdout.trim().slice(0, 200)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: "claude auth status printed non-object JSON" };
  if (parsed.loggedIn !== true) {
    return { ok: false, error: "claude is not logged in — run `claude auth login`" };
  }
  const email = typeof parsed.email === "string" ? parsed.email : undefined;
  const plan = typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined;
  return {
    ok: true,
    account: email === undefined ? plan : plan === undefined ? email : `${email} (${plan})`,
    // No models: the CLI has no zero-token model listing to offer.
  };
}

/** How long the auth-status child gets before the probe calls it hung. */
const PROBE_TIMEOUT_MS = 10_000;

/** Spawn `<binary> auth status`, honoring the same config as a phase. */
export function probeClaudeCode(config: ClaudeCodeConfig): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(config.binaryPath ?? "claude", ["auth", "status"], {
      env: { ...process.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, error: `claude auth status hung past ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);
    child.on("error", (error) => settle({ ok: false, error: error.message }));
    child.on("close", (code) => {
      // Exit 0 is the only contract; a non-zero exit's best diagnosis is
      // whatever the CLI said, stderr first.
      if (code !== 0) {
        const said = (stderr.trim() || stdout.trim()).slice(0, 300);
        settle({ ok: false, error: `claude auth status exited ${code}${said ? `: ${said}` : ""}` });
        return;
      }
      settle(parseAuthStatus(stdout));
    });
  });
}

export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  costReporting: true,
  // Whole blocks, never partial text — see StreamJsonMapper#fromMessage.
  streamsPartialText: false,
  emitsThinking: true,
};

export class ClaudeCodeProvider implements Provider {
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;

  /**
   * Config is resolved per phase, not captured at construction: an operator
   * editing the pinned model in settings must affect the next claim without
   * an app restart.
   */
  constructor(private readonly config: () => ClaudeCodeConfig) {}

  probe(): Promise<ProbeResult> {
    return probeClaudeCode(this.config());
  }

  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle {
    const config = this.config();
    const mapper = new StreamJsonMapper();
    const queue: AgentEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;

    let resolveDone!: (result: RunResult) => void;
    const done = new Promise<RunResult>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
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

    // The prompt is the first thing the drawer should show, and Claude never
    // echoes it back — so the adapter opens the conversation with it.
    emit([
      { type: "block.open", blockId: "prompt", block: { kind: "prompt", text: prompt } },
      { type: "block.close", blockId: "prompt" },
    ]);

    const child = spawn(config.binaryPath ?? "claude", buildArgs(prompt, config), {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      // Uniform cancellation (ticket 09): SIGTERM the child and let the exit
      // handler settle. 143 arriving is expected, not an error.
      child.kill("SIGTERM");
    };
    if (opts?.signal?.aborted) cancel();
    else opts?.signal?.addEventListener("abort", cancel, { once: true });

    // NDJSON arrives in arbitrary chunks; hold the partial tail between them.
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) emit(mapper.feed(line));
    });

    // stderr is diagnosis for a crash, never conversation — the CLI puts the
    // agent's own words on stdout.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", (error) => {
      finish(toRunResult(mapper, { code: null, cancelled, spawnError: error.message }));
    });
    child.on("close", (code) => {
      // Whatever sat in the buffer without a trailing newline is still a line.
      if (stdout.trim() !== "") emit(mapper.feed(stdout));
      const result = toRunResult(mapper, { code, cancelled });
      // Give a crash the child's last words; the mapper never sees stderr.
      if (result.outcome === "crashed" && stderr.trim() !== "") {
        result.failureReason = `${result.failureReason} — stderr: ${stderr.trim().slice(-1000)}`;
      }
      finish(result);
    });

    /**
     * Single-consumer queue: the child fills it from its stdout handler
     * whether or not anyone is reading, so a slow consumer can never exert
     * backpressure on the subprocess (and the engine's `done` still settles
     * for a caller that ignores `events` entirely).
     *
     * Draining before testing `finished` is what makes that safe: `finish()`
     * sets `finished` and calls `notify` in that order, so a consumer parked
     * on the promise always wakes, then empties the queue, and only then sees
     * the flag. Testing `finished` first would drop whatever the child wrote
     * between the last yield and its exit.
     */
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
