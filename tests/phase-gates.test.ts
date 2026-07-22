import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForSettledRuns,
  waitForTicketState,
  writeRecap,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** A recap missing its review notes: the one-line sabotage every test reuses. */
const BROKEN_RECAP = "<h1>Recap</h1>";

/** The engine's in-phase rows for one phase, oldest first. */
function phaseGateRows(run: any, gate: string, phase: string): any[] {
  return run.gateResults.filter(
    (r: any) => r.gate === `phase-gate:${gate}` && r.detail.phase === phase,
  );
}

describe("in-phase verification (TRK-1)", () => {
  test("a gate failure re-prompts the same live session with the findings; the fixed exit converges without a bounce", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        // First document exit ships a recap without review notes; the
        // re-prompted session (same fake, next invocation) leaves the
        // default clean recap in place.
        if (ctx.phase === "document" && ctx.attempt === 1) {
          writeRecap(ctx.cwd, BROKEN_RECAP);
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    // Merit arrival: the lint defect cost one in-phase retry, never a bounce.
    const arrived = await waitForTicketState(server, ticket.id, "human_review");
    expect(arrived).toMatchObject({ bounceCount: 0, arrivedByCap: false });

    // AC-31: the retry rode the SAME provider session, findings in the prompt.
    const documentCalls = calls.filter((call) => call.phase === "document");
    expect(documentCalls).toHaveLength(2);
    expect(documentCalls[0]!.resumeSessionId).toBeUndefined();
    expect(documentCalls[1]!.resumeSessionId).toBe("sess-document-1");
    expect(documentCalls[1]!.prompt).toContain("Phase gates failed");
    expect(documentCalls[1]!.prompt).toContain('recap has no "What to review" section');

    // AC-30 + AC-33: both exits' gate rows sit on the Run — fail then pass.
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    const lints = phaseGateRows(run, "artifact-lint", "document");
    expect(lints.map((r: any) => [r.detail.attempt, r.status])).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    const suites = phaseGateRows(run, "suite", "document");
    expect(suites.every((r: any) => r.status === "pass")).toBe(true);
    // One phase execution despite two invocations: the retry stayed in-phase.
    expect(run.phases.filter((p: any) => p.phase === "document")).toHaveLength(1);
    expect(run.phases.find((p: any) => p.phase === "document").state).toBe("completed");

    // AC-33: the audit trail carries each in-phase result distinctly.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const phaseGateEvents = audit.filter(
      (event: any) => event.type === "gate.result" && String(event.detail.gate).startsWith("phase-gate:"),
    );
    expect(phaseGateEvents.length).toBeGreaterThanOrEqual(12);

    // AC-34: the full battery still ran at Verifying, unchanged.
    const batteryGates = run.gateResults
      .filter((r: any) => r.acId === null && !r.gate.startsWith("phase-gate:"))
      .map((r: any) => r.gate);
    expect(batteryGates).toEqual([
      "artifact",
      "artifact-lint",
      "dogfood-green",
      "branch-recorded",
      "suite",
      "pr-fresh",
      "demo-fresh",
    ]);
  }, 20_000);

  test("a provider without resume gets a standalone re-brief instead of a session id", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "document" && ctx.attempt === 1) {
          writeRecap(ctx.cwd, BROKEN_RECAP);
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    // The copilot posture: findings still feed back inside the same Run,
    // but as a fresh session carrying the original brief.
    provider.capabilities.supportsResume = false;
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    await waitForTicketState(server, ticket.id, "human_review");
    const documentCalls = calls.filter((call) => call.phase === "document");
    expect(documentCalls).toHaveLength(2);
    expect(documentCalls[1]!.resumeSessionId).toBeUndefined();
    expect(documentCalls[1]!.prompt).toContain("Phase gates failed");
    expect(documentCalls[1]!.prompt).toContain("Original phase brief");
    // The re-brief embeds the phase's real template render, context and all.
    expect(documentCalls[1]!.prompt).toContain(documentCalls[0]!.prompt);
  }, 20_000);

  test("a red suite is caught at the phase that broke it and fixed in-session", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        // Implement's first exit breaks the build; the re-prompted session
        // (same fake, next invocation) repairs its own damage.
        if (ctx.phase === "implement" && ctx.attempt === 1) {
          writeFileSync(path.join(ctx.cwd, "red.txt"), "broken\n");
        }
        if (ctx.phase === "implement" && ctx.attempt === 2) {
          rmSync(path.join(ctx.cwd, "red.txt"));
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      // Green until implement plants red.txt: earlier phases' exits stay
      // green, so the failure lands exactly at the phase that broke it.
      repo: { testCommand: "test ! -f red.txt" },
    });

    await waitForTicketState(server, ticket.id, "human_review");

    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    const suites = phaseGateRows(run, "suite", "implement");
    expect(suites.map((r: any) => [r.detail.attempt, r.status])).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    const implementCalls = calls.filter((call) => call.phase === "implement");
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[1]!.resumeSessionId).toBe("sess-implement-1");
    expect(implementCalls[1]!.prompt).toContain("phase-gate:suite");
  }, 20_000);

  test("exhausting the gate retries is a phase death that rides the existing crash policy to the cap (AC-32)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        // Every document exit ships the same broken recap: the findings
        // never get fixed, so the phase dies gate-exhausted every attempt.
        if (ctx.phase === "document") writeRecap(ctx.cwd, BROKEN_RECAP);
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    // Crash semantics, not bounce: 3 crashed runs park the ticket at the cap.
    const runs = await waitForSettledRuns(server, ticket.id, 3, 30_000);
    expect(runs.every((run: any) => run.state === "crashed")).toBe(true);
    const parked = await waitForTicketState(server, ticket.id, "human_review");
    expect(parked).toMatchObject({ arrivedByCap: true, bounceCount: 0 });

    // 1 + 2 capped retries per phase attempt, × the crash policy's one
    // retry: six document invocations per run.
    expect(calls.filter((call) => call.phase === "document")).toHaveLength(18);

    // The death is audited distinctly, wearing the new mode.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const deaths = audit.filter(
      (event: any) => event.type === "phase.crashed" && event.detail.deathMode === "gate-exhausted",
    );
    expect(deaths.length).toBeGreaterThanOrEqual(2);
    expect(deaths[0].detail.reason).toContain("phase-gate:artifact-lint");
  }, 40_000);
});
