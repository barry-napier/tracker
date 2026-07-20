import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  PhaseHandle,
  ProbeResult,
  Provider,
  ProviderCapabilities,
  RunPhaseOpts,
  RunResult,
} from "../provider.ts";

/**
 * The Copilot adapter (ticket 40): the official Copilot SDK wrapped in a
 * Tracker-owned Node subprocess (`copilot-wrapper.mjs`), per the research in
 * issue 03. The SDK — not the CLI — is Copilot's real headless contract: the
 * CLI's `-p` mode is plain text with no session id and undocumented exit
 * codes, and its session-state journal is an internal format. The wrapper
 * keeps kill/crash semantics uniform anyway: every provider is a child
 * process the orchestrator can SIGTERM.
 *
 * Same split as the Claude and Kiro adapters, same reason: the wrapper emits
 * a Tracker-owned NDJSON protocol, and WrapperMapper is pure — a line in,
 * block events out — so the streaming rules are provable without a
 * subprocess. CopilotProvider stays transport.
 */

/** App-level Copilot config. No budget field — Copilot has no native cap. */
export interface CopilotConfig {
  /**
   * The wrapper script to spawn; undefined = the real one next to this file.
   * Tests point this at a scripted stand-in, the same way the CLI adapters
   * override binaryPath.
   */
  wrapperPath?: string;
  /**
   * A copilot CLI runtime for the SDK to spawn; undefined = the platform
   * binary bundled with the SDK's own `@github/copilot` dependency.
   */
  cliPath?: string;
  /** Pinned model, app-wide; undefined = the SDK's default. */
  model?: string;
  /** Extra environment for the wrapper child, merged over the parent's. */
  env?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The wrapper's terminal verdict, once seen. Absent = the wrapper died. */
export interface WrapperResult {
  outcome: "completed" | "failed";
  failureReason?: string;
  usage?: Record<string, unknown>;
}

/**
 * The wrapper's NDJSON protocol → the block-level event union. Copilot
 * streams: message and reasoning chunks arrive as deltas, so this mapper
 * keeps one streaming block open and feeds it
 * (capabilities.streamsPartialText) — the drawer renders live typing. Tool
 * calls land whole, interrupting any open stream. The wrapper is ours, but
 * the tolerance rules still hold: garbage and unknown line types are
 * dropped, never thrown on — a phase that has done real work must not die
 * because one line was unrecognizable.
 */
export class WrapperMapper {
  #blocks = 0;
  /** The open streaming block, if any — text or thinking, fed by deltas. */
  #stream: { id: string; kind: "text" | "thinking" } | undefined;
  /** Calls whose result already landed — later lines are echoes. */
  #landed = new Set<string>();
  #sessionId: string | undefined;
  #result: WrapperResult | undefined;

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get result(): WrapperResult | undefined {
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
      return []; // Interleaved noise is not the phase's failure.
    }
    if (!isRecord(parsed)) return [];

    switch (parsed.type) {
      case "session":
        if (typeof parsed.sessionId === "string") this.#sessionId = parsed.sessionId;
        return [];
      case "delta":
        return this.#delta(parsed);
      case "tool_call":
        return this.#toolCall(parsed);
      case "tool_result":
        return this.#toolResult(parsed);
      case "result":
        if (parsed.outcome === "completed" || parsed.outcome === "failed") {
          this.#result = {
            outcome: parsed.outcome,
            failureReason:
              typeof parsed.failureReason === "string" ? parsed.failureReason : undefined,
            usage: isRecord(parsed.usage) ? parsed.usage : undefined,
          };
        }
        return [];
      default:
        return [];
    }
  }

  /** Close any open streaming block — the turn is over. */
  finish(): AgentEvent[] {
    return this.#closeStream();
  }

  #delta(line: Record<string, unknown>): AgentEvent[] {
    const kind = line.kind;
    if ((kind !== "text" && kind !== "thinking") || typeof line.text !== "string") return [];
    const events: AgentEvent[] = [];
    if (this.#stream?.kind !== kind) {
      events.push(...this.#closeStream());
      const id = this.#nextId();
      this.#stream = { id, kind };
      // Opened empty: the chunk itself rides as a delta, so the drawer's
      // append path is the only path and the first word streams like the rest.
      events.push({ type: "block.open", blockId: id, block: { kind, text: "" } });
    }
    events.push({ type: "block.delta", blockId: this.#stream!.id, textDelta: line.text });
    return events;
  }

  #toolCall(line: Record<string, unknown>): AgentEvent[] {
    const id = this.#nextId();
    return [
      ...this.#closeStream(),
      {
        type: "block.open",
        blockId: id,
        block: {
          kind: "tool_call",
          tool: typeof line.tool === "string" ? line.tool : "tool",
          input: typeof line.input === "string" ? line.input : "{}",
        },
      },
      { type: "block.close", blockId: id },
    ];
  }

  #toolResult(line: Record<string, unknown>): AgentEvent[] {
    const callId = typeof line.callId === "string" ? line.callId : "tool";
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
          tool: typeof line.tool === "string" ? line.tool : callId,
          output: typeof line.output === "string" ? line.output : "",
          isError: line.isError === true,
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
    return `copilot-${++this.#blocks}`;
  }
}

/**
 * The wrapper's `{type:"probe"}` line → ProbeResult. Pure, same reason as
 * WrapperMapper: the shapes worth testing (missing line, garbage fields)
 * must be provable without an SDK runtime.
 */
export function parseProbeLine(stdout: string): ProbeResult | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "probe") continue;
    return {
      ok: parsed.ok === true,
      account: typeof parsed.account === "string" ? parsed.account : undefined,
      models: Array.isArray(parsed.models)
        ? parsed.models.filter((id): id is string => typeof id === "string")
        : undefined,
      error: parsed.ok === true ? undefined : "copilot is not authenticated — run `copilot` and sign in",
    };
  }
  return undefined;
}

/** SDK start + auth + model listing measured ~2s warm; cold npx-style
 * runtimes are slower, and a wedged one must not hang the settings screen. */
const PROBE_TIMEOUT_MS = 30_000;

/** Spawn the wrapper in probe mode and judge from its one probe line. */
export function probeCopilot(config: CopilotConfig): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [config.wrapperPath ?? REAL_WRAPPER], {
      env: { ...process.env, ...config.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {
      // A torn pipe surfaces via the close handler.
    });
    child.stdin.end(JSON.stringify({ probe: true, cliPath: config.cliPath }));

    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ ok: false, error: `copilot probe hung past ${PROBE_TIMEOUT_MS}ms` }),
      PROBE_TIMEOUT_MS,
    );

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const result = parseProbeLine(stdout);
      if (result !== undefined) settle(result);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => settle({ ok: false, error: error.message }));
    child.on("close", (code) => {
      settle({
        ok: false,
        error: `copilot wrapper exited ${code ?? "on a signal"} before its probe line${
          stderr.trim() === "" ? "" : ` — stderr: ${stderr.trim().slice(-300)}`
        }`,
      });
    });
  });
}

export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  // Partial by the ticket's terms: Copilot meters premium-request counts,
  // not USD, so costUsd would be a lie. The counts ride in RunResult.usage.
  costReporting: false,
  streamsPartialText: true,
  emitsThinking: true,
};

/** How long SIGTERM gets before SIGKILL finishes the job. */
const KILL_GRACE_MS = 2_000;

/** How long the wrapper may linger after its result line before the axe. */
const RESULT_EXIT_GRACE_MS = 5_000;

/** The real wrapper, resolved next to this module (src in dev, build in prod). */
const REAL_WRAPPER = fileURLToPath(new URL("./copilot-wrapper.mjs", import.meta.url));

export class CopilotProvider implements Provider {
  readonly capabilities = COPILOT_CAPABILITIES;

  /** Config resolved per phase, same contract as the other adapters. */
  constructor(private readonly config: () => CopilotConfig) {}

  probe(): Promise<ProbeResult> {
    return probeCopilot(this.config());
  }

  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle {
    const config = this.config();
    const mapper = new WrapperMapper();
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

    emit([
      { type: "block.open", blockId: "prompt", block: { kind: "prompt", text: prompt } },
      { type: "block.close", blockId: "prompt" },
    ]);

    // process.execPath so the wrapper runs under the node that runs us;
    // ELECTRON_RUN_AS_NODE makes that true in the packaged app too, where
    // execPath is the Electron binary.
    const child = spawn(process.execPath, [config.wrapperPath ?? REAL_WRAPPER], {
      cwd,
      env: { ...process.env, ...config.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The phase input rides on stdin, not argv: prompts outgrow argv limits,
    // and a worktree path in `ps` output is nobody's business anyway.
    child.stdin.on("error", () => {
      // A torn pipe surfaces via the close handler; writing louder here
      // would just race it.
    });
    child.stdin.end(
      JSON.stringify({ prompt, model: config.model, cliPath: config.cliPath }),
    );

    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      cancelled = true;
      // Graceful-then-kill: SIGTERM lets the wrapper stop the SDK runtime it
      // spawned; the SIGKILL backstop guarantees the phase actually ends
      // even when the wrapper is stuck in cleanup.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    if (opts?.signal?.aborted) cancel();
    else opts?.signal?.addEventListener("abort", cancel, { once: true });

    let lingerTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) emit(mapper.feed(line));
      // The verdict is in hand once the result line lands; the wrapper's
      // remaining job is SDK cleanup, which can wedge on a stuck runtime. A
      // wrapper that lingers past the grace gets the axe rather than hanging
      // the phase — "crash of the wrapper is a phase failure, not a hang"
      // has to hold on the success path too.
      if (mapper.result !== undefined && lingerTimer === undefined) {
        lingerTimer = setTimeout(() => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        }, RESULT_EXIT_GRACE_MS);
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", (error) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      emit(mapper.finish());
      finish({ outcome: cancelled ? "cancelled" : "crashed", failureReason: error.message });
    });
    child.on("close", (code) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (lingerTimer !== undefined) clearTimeout(lingerTimer);
      if (stdout.trim() !== "") emit(mapper.feed(stdout));
      emit(mapper.finish());
      const providerSessionId = mapper.sessionId;
      // Our own SIGTERM wins over everything: the orchestrator is quitting,
      // and nothing here is a verdict on the work.
      if (cancelled) {
        finish({ outcome: "cancelled", providerSessionId });
        return;
      }
      // The result line is the verdict — we own the wrapper, and it emits one
      // for every agent-judged ending. Anything that dies before reporting
      // one (SDK missing, auth blow-up, runtime crash) is transport, so the
      // crash policy retries rather than the bounce machinery blaming the
      // agent for work it may well have done.
      const result = mapper.result;
      if (result === undefined) {
        finish({
          outcome: "crashed",
          failureReason: `copilot wrapper exited ${code ?? "on a signal"} before reporting a result${
            stderr.trim() === "" ? "" : ` — stderr: ${stderr.trim().slice(-1000)}`
          }`,
          providerSessionId,
        });
        return;
      }
      finish({
        outcome: result.outcome,
        failureReason: result.failureReason,
        usage: result.usage,
        providerSessionId,
      });
    });

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
