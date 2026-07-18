// PROTOTYPE — throwaway (wayfinder ticket 12). Fake SSE feed: emits RunLogEvents
// for the in-progress runs and periodic phase changes, so live agent logs and
// state transitions are judgeable in every variant.
import { useSyncExternalStore } from "react";
import type { LogBlock, Phase, RunLogEvent } from "./events";
import { PHASES, runs, tickets } from "./fixtures";

export interface OpenBlock {
  blockId: string;
  phase: Phase;
  block: LogBlock;
  open: boolean;
}

interface FactoryState {
  logs: Record<string, OpenBlock[]>; // runId -> blocks
  phases: Record<string, Phase>; // runId -> current phase
  tick: number;
}

const script: { runId: string; ev: RunLogEvent }[] = [];
function s(runId: string, ev: RunLogEvent) {
  script.push({ runId, ev });
}

// A looping conversation for run-25a (implement phase, Claude Code)
s("run-25a", { type: "block.open", blockId: "b1", phase: "implement", block: { kind: "prompt", text: "Implement actor filtering per kb/plan.md. Write kb/implement.md before finishing." } });
s("run-25a", { type: "block.open", blockId: "b2", phase: "implement", block: { kind: "thinking", text: "" } });
s("run-25a", { type: "block.delta", blockId: "b2", textDelta: "The plan calls for a multi-select on actor. " });
s("run-25a", { type: "block.delta", blockId: "b2", textDelta: "Filter state should serialize into the query string so reload survives it." });
s("run-25a", { type: "block.close", blockId: "b2" });
s("run-25a", { type: "block.open", blockId: "b3", phase: "implement", block: { kind: "tool_call", tool: "Read", input: "src/components/AuditLog.tsx" } });
s("run-25a", { type: "block.open", blockId: "b4", phase: "implement", block: { kind: "tool_result", tool: "Read", output: "182 lines — table + existing date filter", isError: false } });
s("run-25a", { type: "block.open", blockId: "b5", phase: "implement", block: { kind: "text", text: "" } });
s("run-25a", { type: "block.delta", blockId: "b5", textDelta: "Adding an ActorFilter component next to the date filter, " });
s("run-25a", { type: "block.delta", blockId: "b5", textDelta: "backed by a useQueryState hook." });
s("run-25a", { type: "block.close", blockId: "b5" });
s("run-25a", { type: "block.open", blockId: "b6", phase: "implement", block: { kind: "tool_call", tool: "Edit", input: "src/components/AuditLog.tsx" } });
s("run-25a", { type: "block.open", blockId: "b7", phase: "implement", block: { kind: "tool_result", tool: "Edit", output: "ok", isError: false } });
s("run-25a", { type: "block.open", blockId: "b8", phase: "implement", block: { kind: "tool_call", tool: "Bash", input: "npm test -- AuditLog" } });
s("run-25a", { type: "block.open", blockId: "b9", phase: "implement", block: { kind: "tool_result", tool: "Bash", output: "FAIL: expected 2 filters, found 3 (snapshot stale)", isError: true } });
s("run-25a", { type: "block.open", blockId: "b10", phase: "implement", block: { kind: "text", text: "Snapshot is stale, updating it." } });

// run-26a (research phase, Copilot)
s("run-26a", { type: "block.open", blockId: "c1", phase: "research", block: { kind: "prompt", text: "Research retry behavior for S3 uploads in this repo. Write kb/research.md." } });
s("run-26a", { type: "block.open", blockId: "c2", phase: "research", block: { kind: "tool_call", tool: "Grep", input: "s3.upload" } });
s("run-26a", { type: "block.open", blockId: "c3", phase: "research", block: { kind: "tool_result", tool: "Grep", output: "4 call sites in src/storage/", isError: false } });
s("run-26a", { type: "block.open", blockId: "c4", phase: "research", block: { kind: "text", text: "" } });
s("run-26a", { type: "block.delta", blockId: "c4", textDelta: "No existing retry wrapper. The SDK's built-in maxAttempts is left at default. " });
s("run-26a", { type: "block.delta", blockId: "c4", textDelta: "Candidate: wrap uploads in exponential backoff with jitter." });
s("run-26a", { type: "block.close", blockId: "c4" });

let state: FactoryState = {
  logs: { "run-25a": [], "run-26a": [] },
  phases: { "run-25a": "implement", "run-26a": "research" },
  tick: 0,
};
let cursor = 0;
const listeners = new Set<() => void>();

function apply(runId: string, ev: RunLogEvent) {
  const blocks = [...(state.logs[runId] ?? [])];
  if (ev.type === "block.open") {
    blocks.push({ blockId: ev.blockId, phase: ev.phase, block: { ...ev.block }, open: true });
  } else if (ev.type === "block.delta") {
    const i = blocks.findIndex((b) => b.blockId === ev.blockId);
    if (i >= 0) {
      const b = blocks[i];
      blocks[i] = { ...b, block: { ...b.block, text: (b.block as any).text + ev.textDelta } as LogBlock };
    }
  } else {
    const i = blocks.findIndex((b) => b.blockId === ev.blockId);
    if (i >= 0) blocks[i] = { ...blocks[i], open: false };
  }
  state = { ...state, logs: { ...state.logs, [runId]: blocks }, tick: state.tick + 1 };
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    const { runId, ev } = script[cursor];
    cursor = (cursor + 1) % script.length;
    if (cursor === 0) {
      // loop: reset logs, advance run-26a's phase for a visible state change
      const next = PHASES[(PHASES.indexOf(state.phases["run-26a"]) + 1) % PHASES.length];
      state = { logs: { "run-25a": [], "run-26a": [] }, phases: { ...state.phases, "run-26a": next }, tick: state.tick + 1 };
    } else {
      apply(runId, ev);
    }
    listeners.forEach((l) => l());
  }, 900);
}

export function useFactory(): FactoryState {
  start();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export { runs, tickets };
