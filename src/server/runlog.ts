import type { AgentBlock, AgentEvent } from "./provider.ts";

/** A provider AgentEvent as the log stream serves it: opens carry the phase. */
export type RunLogEvent =
  | { type: "block.open"; blockId: string; phase: string; block: AgentBlock }
  | { type: "block.delta"; blockId: string; textDelta: string }
  | { type: "block.close"; blockId: string };

export interface RunLogEntry {
  seq: number;
  event: RunLogEvent;
}

/**
 * One run's conversation log: append-only, replayable from any seq, with
 * live fan-out for connected SSE clients. Kept whole for the process
 * lifetime — runs are short and the drawer needs full replay on open.
 */
export class RunLog {
  #seq = 0;
  #entries: RunLogEntry[] = [];
  #subscribers = new Set<(entry: RunLogEntry) => void>();

  append(event: RunLogEvent): void {
    const entry: RunLogEntry = { seq: ++this.#seq, event };
    this.#entries.push(entry);
    for (const subscriber of this.#subscribers) subscriber(entry);
  }

  entriesSince(seq: number): RunLogEntry[] {
    return this.#entries.filter((entry) => entry.seq > seq);
  }

  subscribe(subscriber: (entry: RunLogEntry) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}

/** In-memory logs keyed by run id; a run that predates this process is empty. */
export class RunLogRegistry {
  #logs = new Map<number, RunLog>();

  for(runId: number): RunLog {
    let log = this.#logs.get(runId);
    if (!log) {
      log = new RunLog();
      this.#logs.set(runId, log);
    }
    return log;
  }

  /** Tag a provider event with the phase that produced it (opens only). */
  static decorate(event: AgentEvent, phase: string): RunLogEvent {
    return event.type === "block.open" ? { ...event, phase } : event;
  }
}
