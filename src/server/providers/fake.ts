import type {
  AgentEvent,
  PhaseContext,
  PhaseHandle,
  Provider,
  RunPhaseOpts,
  RunResult,
} from "../provider.ts";

/**
 * A phase's script: yield conversation events, do real side effects (write
 * files, commit) between yields, return the RunResult. Throwing anywhere is
 * the provider crashing mid-phase.
 */
export type FakeScript = (
  ctx: PhaseContext,
) => AsyncGenerator<AgentEvent, RunResult>;

/**
 * How a scripted provider learns its phase, the way a real agent would: from
 * the seeded templates' contract instruction ("write kb/<phase>.md") — never
 * the first kb mention, which is the {{priorKb}} handoff line. Throws on
 * drift so a template rewording fails loudly instead of hollow-failing.
 */
export function phaseFromPrompt(prompt: string): string {
  const match = /write kb\/([a-z]+)\.md/.exec(prompt);
  if (!match) throw new Error(`prompt names no contract file: ${prompt.slice(0, 80)}…`);
  return match[1]!;
}

/**
 * How a scripted provider learns which ACs its plan-phase manifest must
 * cover, the way a real agent would: from the rendered AC lines
 * (`- [pending] AC-<id>: …`) in the prompt.
 */
export function pendingAcIdsFromPrompt(prompt: string): number[] {
  return [...prompt.matchAll(/^- \[pending\] AC-(\d+):/gm)].map((match) => Number(match[1]));
}

/**
 * The spec's primary test fake: scripted per-test to behave like a real
 * agent — or to misbehave (omit the contract file, crash, hang) for the
 * crash-policy and gate-failure paths. Also stands in for real adapters in
 * the dev app until the adapter slices land.
 */
export class FakeProvider implements Provider {
  constructor(private readonly script: FakeScript) {}

  runPhase(prompt: string, cwd: string, opts?: RunPhaseOpts): PhaseHandle {
    const generator = this.script({ prompt, cwd });
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

    // Uniform cancellation (ticket 09): a real adapter SIGTERMs its child;
    // the fake resolves cancelled and abandons a script that never returns.
    opts?.signal?.addEventListener("abort", () => finish({ outcome: "cancelled" }), {
      once: true,
    });

    // Drive the script eagerly: `done` must settle even if nobody consumes
    // `events`, exactly like a real child process running to completion.
    void (async () => {
      try {
        for (;;) {
          const next = await generator.next();
          // A cancelled phase stops here, like a SIGTERMed child: whatever
          // side effects ran before this yield happened; nothing more does.
          if (settled) return;
          if (next.done) return finish(next.value);
          queue.push(next.value);
          notify?.();
        }
      } catch (error) {
        finish({
          outcome: "crashed",
          failureReason: error instanceof Error ? error.message : String(error),
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
