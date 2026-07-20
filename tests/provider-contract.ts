import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent, PhaseHandle, Provider } from "../src/server/provider.ts";

/**
 * The adapter contract-test harness (ticket 38): one suite every provider
 * must pass, so a new adapter is judged against the same bar as the ones
 * before it rather than against its own tests.
 *
 * It asserts only what the seam actually promises — block-event well-
 * formedness, the Phase Contract file, cancellation, and `done` settling for
 * a caller who never reads `events`. Anything richer belongs in that
 * adapter's own tests; anything weaker would let a broken adapter through.
 */
export interface ContractSubject {
  name: string;
  /** Non-empty = skip the whole suite, saying why (e.g. the CLI is absent). */
  skip?: string;
  /** A provider that writes the prompted contract file and completes. */
  succeeds: () => Provider;
  /** A provider that runs long enough to be cancelled mid-phase. */
  hangs: () => Provider;
  /** Milliseconds a single phase may take before the test gives up. */
  timeoutMs?: number;
}

/**
 * The prompt every subject is handed. It names the contract file the way the
 * seeded templates do ("write kb/<phase>.md") so a scripted provider can read
 * its phase out of it exactly as it would in a real run.
 */
export const CONTRACT_PROMPT =
  "You are running a test phase. Before finishing, write kb/contract.md with a one-line summary.";

/** Drain an event stream, asserting block well-formedness as it goes. */
export async function collectEvents(handle: PhaseHandle): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const open = new Set<string>();
  const everOpened = new Set<string>();
  for await (const event of handle.events) {
    if (event.type === "block.open") {
      // Ids must be unique across a phase or the log view merges two blocks.
      expect(everOpened.has(event.blockId), `duplicate block id ${event.blockId}`).toBe(false);
      everOpened.add(event.blockId);
      open.add(event.blockId);
    } else {
      // A delta or close for a block nobody opened has nowhere to render.
      expect(open.has(event.blockId), `${event.type} for unopened ${event.blockId}`).toBe(true);
      if (event.type === "block.close") open.delete(event.blockId);
    }
    events.push(event);
  }
  expect([...open], "blocks left open when the stream ended").toEqual([]);
  return events;
}

function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "provider-contract-"));
}

export function describeProviderContract(subject: ContractSubject): void {
  const suite = subject.skip ? describe.skip : describe;
  const timeout = subject.timeoutMs ?? 15_000;

  suite(`provider contract: ${subject.name}${subject.skip ? ` (${subject.skip})` : ""}`, () => {
    test("declares its capabilities", () => {
      const { capabilities } = subject.succeeds();
      expect(typeof capabilities.costReporting).toBe("boolean");
      expect(typeof capabilities.streamsPartialText).toBe("boolean");
      expect(typeof capabilities.emitsThinking).toBe("boolean");
    });

    test(
      "runs a phase in the given cwd: well-formed events, contract file, completed",
      async () => {
        const cwd = scratchDir();
        try {
          const handle = subject.succeeds().runPhase(CONTRACT_PROMPT, cwd);
          const events = await collectEvents(handle);
          const result = await handle.done;

          expect(result.outcome).toBe("completed");
          // The Phase Contract, written into the directory it was handed —
          // proof the adapter actually ran the agent where it was told to.
          expect(existsSync(path.join(cwd, "kb", "contract.md"))).toBe(true);
          // A phase that renders nothing is a phase nobody can review.
          expect(events.some((e) => e.type === "block.open")).toBe(true);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
      timeout,
    );

    test(
      "done settles even when nobody consumes events",
      async () => {
        const cwd = scratchDir();
        try {
          // A caller that never touches `events` must not deadlock the phase:
          // the engine awaits `done` last, and an adapter that only drains on
          // consumption would hang the worker forever.
          const handle = subject.succeeds().runPhase(CONTRACT_PROMPT, cwd);
          expect((await handle.done).outcome).toBe("completed");
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
      timeout,
    );

    test(
      "aborting the signal cancels the phase",
      async () => {
        const cwd = scratchDir();
        const controller = new AbortController();
        try {
          const handle = subject.hangs().runPhase(CONTRACT_PROMPT, cwd, {
            signal: controller.signal,
          });
          // Let the phase get properly under way before pulling the plug, so
          // this exercises mid-flight cancellation and not a pre-start race.
          await new Promise((resolve) => setTimeout(resolve, 200));
          controller.abort();
          const result = await handle.done;
          // Cancellation is the orchestrator's own doing; an adapter that
          // reported "failed" here would have the bounce machinery blame the
          // agent for the app quitting.
          expect(result.outcome).toBe("cancelled");
          // And the stream must end rather than hang the consumer.
          await collectEvents(handle);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
      timeout,
    );
  });
}
