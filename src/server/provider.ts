/**
 * The provider seam (ticket 09): a TypeScript interface in the main process,
 * one adapter per provider. The native transports (NDJSON, ACP JSON-RPC, SDK
 * callbacks) are irreconcilable as a wire format; the TS interface is the
 * honest contract. Adapters normalize their streams to the block-level event
 * union below — the same shape the per-run SSE log stream serves.
 */


/** One entry in the agent's conversation, as the log view renders it. */
export type AgentBlock =
  | { kind: "prompt"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; tool: string; output: string; isError: boolean };

/**
 * Block-level conversation events. Providers that stream partial text emit
 * deltas onto the open block; providers that land whole blocks (Claude) open
 * and close in quick succession.
 */
export type AgentEvent =
  | { type: "block.open"; blockId: string; block: AgentBlock }
  | { type: "block.delta"; blockId: string; textDelta: string }
  | { type: "block.close"; blockId: string };

export type RunOutcome = "completed" | "failed" | "cancelled" | "crashed";

/** Only what every provider can honestly report; richness rides in the log. */
export interface RunResult {
  outcome: RunOutcome;
  failureReason?: string;
  providerSessionId?: string;
  costUsd?: number;
  usage?: Record<string, unknown>;
}

export interface RunPhaseOpts {
  /** Uniform cancellation: adapters SIGTERM their child on abort. */
  signal?: AbortSignal;
  /**
   * Per-call override of the instance's pinned model (the builder chat's
   * model chip). Adapters that can't honor it ignore it — the phase still
   * runs, on the instance's model.
   */
  model?: string;
  /**
   * Continue an earlier invocation's conversation instead of opening a fresh
   * one (TRK-1: a phase-gate failure re-prompts the same live session). The
   * id is a prior RunResult.providerSessionId. The engine only passes this
   * to adapters declaring supportsResume; an adapter that can't honor it
   * runs a fresh session — the prompt must then carry its context standalone.
   */
  resumeSessionId?: string;
}

export interface PhaseHandle {
  events: AsyncIterable<AgentEvent>;
  /** Resolves for every ending — a transport blow-up is outcome "crashed". */
  done: Promise<RunResult>;
}

/** What a phase invocation looks like from the adapter's side. */
export interface PhaseContext {
  prompt: string;
  cwd: string;
  /** The session this invocation resumes, when the caller asked for one. */
  resumeSessionId?: string;
}

/**
 * What a provider can honestly do, declared rather than discovered — the
 * three flags ticket 38 names, so each adapter states them where the next one
 * can be compared against it. Nothing reads these yet: they exist to be
 * declared at the seam rather than rediscovered per surface later, and the
 * first reader will be whichever view stops guessing (a cost column, or a log
 * view deciding whether to expect deltas). Adding a flag no adapter answers
 * honestly is worse than not having it.
 */
export interface ProviderCapabilities {
  /** Reports real spend, so RunResult.costUsd means something. */
  costReporting: boolean;
  /** Streams text deltas onto an open block, rather than landing whole ones. */
  streamsPartialText: boolean;
  /** Surfaces the model's reasoning as `thinking` blocks. */
  emitsThinking: boolean;
  /**
   * Honors RunPhaseOpts.resumeSessionId: a re-prompt continues the prior
   * session's conversation rather than starting cold. Declared, not
   * discovered — the engine's phase-gate retry (TRK-1) reads this to decide
   * whether findings ride a resume or a standalone re-brief.
   */
  supportsResume: boolean;
}

/**
 * What a zero-token health check reports. `ok` answers the one question the
 * board needs before a claim — "would a phase start, or die on auth?" —
 * without spending a model call. Everything else is color the provider's
 * transport volunteered for free; absence means the transport doesn't say,
 * never that the adapter forgot to ask.
 */
export interface ProbeResult {
  ok: boolean;
  /** Who is signed in, as the provider states it (email, login, plan). */
  account?: string;
  /** Model ids the provider offered, where the transport lists them at all. */
  models?: string[];
  /** Why ok is false — binary missing, logged out, probe timed out. */
  error?: string;
}

export interface Provider {
  readonly capabilities: ProviderCapabilities;
  /** Each call is a fresh provider session (Phase Contract). */
  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle;
  /**
   * Zero-token health check. Resolves for every ending — a probe that cannot
   * answer (binary missing, timeout) resolves ok:false with the reason,
   * never rejects and never hangs: each adapter enforces its own deadline,
   * the same way runPhase owns its own kill semantics.
   */
  probe(): Promise<ProbeResult>;
}

/** Adapters keyed by ProviderInstance id; a missing entry crashes the claim. */
export type ProviderRegistry = Partial<Record<string, Provider>>;
