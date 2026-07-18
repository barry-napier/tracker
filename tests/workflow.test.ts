import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "./git-helpers.ts";
import { api, runCleanups, cleanups } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";
import {
  bootWorkspace,
  PHASES,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

describe("the full seeded workflow", () => {
  test("five phases run in order with fresh sessions and kb handoff", async () => {
    const calls: PhaseCall[] = [];
    const { dataDir, server, ticket } = await bootWorkspace(scriptedProvider(calls));
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await waitForTicketState(server, ticket.id, "verifying");

    // Every phase ran once, in graph order, in the run's worktree.
    expect(calls.map((c) => c.phase)).toEqual([...PHASES]);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(calls.every((c) => c.cwd === runs[0].worktreePath)).toBe(true);

    // The fixed template variable set is the only context injection.
    const acId = ticket.acceptanceCriteria[0].id;
    const research = calls[0]!.prompt;
    expect(research).toContain("Ship the widget");
    expect(research).toContain(`[pending] AC-${acId}: Widget renders`);
    expect(research).toContain("none yet");
    const implement = calls[2]!.prompt;
    expect(implement).toContain("kb/research.md, kb/plan.md");

    // Phase executions carry outcome and provider session id per node.
    expect(runs[0].phases).toHaveLength(5);
    expect(runs[0].phases.map((p: any) => p.phase)).toEqual([...PHASES]);
    for (const phase of runs[0].phases) {
      expect(phase.state).toBe("completed");
      expect(phase.providerSessionId).toBe(`sess-${phase.phase}-1`);
    }

    // kb/* persisted to app data: kind, content hash, worktree HEAD SHA.
    const headSha = git(runs[0].worktreePath, "rev-parse", "HEAD");
    expect(runs[0].artifacts).toHaveLength(5);
    for (const artifact of runs[0].artifacts) {
      expect(artifact.kind).toBe("kb");
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.worktreeHeadSha).toBe(headSha);
      expect(existsSync(path.join(dataDir, artifact.path))).toBe(true);
    }
    expect(runs[0].artifacts.map((a: any) => a.name).sort()).toEqual(
      [...PHASES].map((p) => `${p}.md`).sort(),
    );

    // The board heard each phase start and finish, and the run end enriched.
    const phaseEvents = client.messages.filter((m) => m.event === "run.phase_changed");
    expect(phaseEvents.map((m) => m.data.phase)).toEqual(
      [...PHASES].flatMap((p) => [p, p]),
    );
    expect(phaseEvents.map((m) => m.data.status)).toEqual(
      [...PHASES].flatMap(() => ["started", "completed"]),
    );
    const runUpdates = client.messages.filter((m) => m.event === "run.updated");
    expect(runUpdates.at(-1)!.data.artifacts).toHaveLength(5);

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: { type: string }) => event.type);
    expect(types.filter((t: string) => t === "phase.started")).toHaveLength(5);
    expect(types).toContain("artifacts.persisted");
  }, 20_000);

  test("a hollow mid-workflow phase fails the run but its evidence survives", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, (phase, attempt) =>
      phase === "implement" && attempt === 1 ? false : undefined,
    );
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "failed" });

    // The hollow attempt stopped at implement; nothing after it ran.
    expect(runs[1].phases.map((p: any) => [p.phase, p.state])).toEqual([
      ["research", "completed"],
      ["plan", "completed"],
      ["implement", "failed"],
    ]);
    expect(runs[1].phases[2].failureReason).toContain("kb/implement.md");

    // Pass, bounce, or crash: what the run did produce is persisted.
    expect(runs[1].artifacts.map((a: any) => a.name).sort()).toEqual(["plan.md", "research.md"]);
  }, 20_000);

  test("a crashing phase crashes the run; the re-claim recovers", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, (phase, attempt) => {
      if (phase === "research" && attempt === 1) throw new Error("provider fell over");
    });
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "crashed" });
    expect(runs[1].crashReason).toContain("provider fell over");
    expect(runs[1].phases[0]).toMatchObject({ phase: "research", state: "crashed" });
    expect(runs[1].artifacts).toHaveLength(0);
  }, 20_000);

  test("the per-run log stream carries every phase's blocks with unique ids", async () => {
    const calls: PhaseCall[] = [];
    const { server, ticket } = await bootWorkspace(scriptedProvider(calls));
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const log = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`);
    cleanups.push(async () => log.close());

    const opens = await log.waitFor("block.open", 25);
    expect(opens.map((m) => m.data.block.kind).slice(0, 5)).toEqual([
      "prompt",
      "thinking",
      "text",
      "tool_call",
      "tool_result",
    ]);
    // Opens are tagged with the phase that produced them, in graph order.
    expect(opens.map((m) => m.data.phase)).toEqual(
      [...PHASES].flatMap((p) => [p, p, p, p, p]),
    );
    const ids = opens.map((m) => m.data.blockId);
    expect(new Set(ids).size).toBe(ids.length);
    await log.waitFor("block.delta", 5);

    // Resume from the middle: Last-Event-ID replays only what follows.
    const resumeFrom = opens[22]!.id;
    const resumed = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`, resumeFrom);
    cleanups.push(async () => resumed.close());
    const resumedOpens = await resumed.waitFor("block.open", 2);
    expect(resumedOpens.map((m) => m.data.block.kind)).toEqual(["tool_call", "tool_result"]);
    expect(resumedOpens.every((m) => m.data.phase === "document")).toBe(true);
  }, 20_000);
});
