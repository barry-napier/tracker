/**
 * The provider seam (ticket 09): a TypeScript interface in the main process,
 * one adapter per provider. The native transports (NDJSON, ACP JSON-RPC, SDK
 * callbacks) are irreconcilable as a wire format; the TS interface is the
 * honest contract. Adapters normalize their streams to the block-level event
 * union below — the same shape the per-run SSE log stream serves.
 */

import type { ProviderName } from "./types.ts";

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
}

export interface Provider {
  /** Each call is a fresh provider session (Phase Contract). */
  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle;
}

/** Adapters registered per provider name; a missing entry crashes the claim. */
export type ProviderRegistry = Partial<Record<ProviderName, Provider>>;
