import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startServer, type TrackerServer } from "../src/server/index.ts";
import { FakeProvider, phaseFromPrompt } from "../src/server/providers/fake.ts";
import { FakeGitHub } from "./github-fake.ts";
import {
  api,
  bootServer,
  cleanups,
  previewPortBase,
  runCleanups,
  seedWorkspace,
} from "./server-helpers.ts";
import {
  bootWorkspace,
  conversation,
  pushesToGitHub,
  scriptedProvider,
  waitForSettledRuns,
  waitForTicketState,
  writeContract,
  type PhaseCall,
} from "./workflow-helpers.ts";

// The crash policy (ticket 41): crash = work didn't happen → Todo; bounce =
// work was wrong → In Progress. A phase death retries once; a second death
// crashes the Run; three crashed Runs park the Ticket in Human Review.

afterEach(runCleanups);

async function auditOf(server: TrackerServer, ticketId: number): Promise<any[]> {
  return (await api(server, "GET", `/api/tickets/${ticketId}/audit`)).json;
}

describe("phase death and the retry", () => {
  test("a dying phase is retried once and the run recovers", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      sabotage: (phase, attempt) => {
        if (phase === "research" && attempt === 1) throw new Error("provider fell over");
      },
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, { github });
    await waitForTicketState(server, ticket.id, "human_review");

    // One run: the death stayed inside it. Two research executions — the
    // crashed attempt on record, the retry carrying the phase.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("completed");
    expect(runs[0].phases.map((p: any) => [p.phase, p.state])).toEqual([
      ["research", "crashed"],
      ["research", "completed"],
      ["plan", "completed"],
      ["implement", "completed"],
      ["dogfood", "completed"],
      ["document", "completed"],
    ]);

    // The death was audited distinctly, mode and all.
    const crashed = (await auditOf(server, ticket.id)).find(
      (event: any) => event.type === "phase.crashed",
    );
    expect(crashed.detail).toMatchObject({ phase: "research", deathMode: "crash" });
    expect(crashed.detail.reason).toContain("provider fell over");
  }, 20_000);

  test("a second death crashes the run: Todo, no new criteria, worktree reused", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      sabotage: (phase, attempt) => {
        if (phase === "implement" && attempt <= 2) throw new Error("provider fell over");
      },
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, { github });
    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[1].state).toBe("crashed");
    expect(runs[1].crashReason).toContain("provider fell over");
    expect(runs[1].phases.filter((p: any) => p.phase === "implement").map((p: any) => p.state))
      .toEqual(["crashed", "crashed"]);
    expect(runs[0].state).toBe("completed");

    // Crash adds no follow-up criteria — that's the bounce's move, not ours.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria).toHaveLength(1);
    expect(detail.acceptanceCriteria[0].origin).toBe("original");

    // The re-claim reused the worktree, and the crash event recorded the
    // tree-state summary the next run inherits.
    expect(runs[0].worktreePath).toBe(runs[1].worktreePath);
    const crashedRun = (await auditOf(server, ticket.id)).find(
      (event: any) => event.type === "run.crashed",
    );
    expect(crashedRun.detail.treeState).toMatchObject({ branch: ticket.branch ?? expect.any(String) });
    expect(typeof crashedRun.detail.treeState.dirtyCount).toBe("number");

    // What the crashed run did produce was persisted (evidence survives).
    expect(runs[1].artifacts.map((a: any) => a.name).sort()).toEqual(["plan.md", "research.md"]);
  }, 25_000);

  test("a hollow clean exit is a death of its own mode", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      sabotage: (phase, attempt) => (phase === "implement" && attempt <= 2 ? false : undefined),
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, { github });
    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[1].state).toBe("crashed");
    expect(runs[1].crashReason).toContain("kb/implement.md");
    const deaths = (await auditOf(server, ticket.id)).filter(
      (event: any) => event.type === "phase.crashed",
    );
    expect(deaths).toHaveLength(2);
    expect(deaths.every((event: any) => event.detail.deathMode === "hollow-exit")).toBe(true);
  }, 25_000);
});

describe("the crash cap", () => {
  test("3 crashed runs park the ticket in Human Review with the cap flag", async () => {
    // A provider whose research always reports failure (the non-zero-exit
    // death for a real CLI): every run dies twice and crashes; the third
    // crashed run parks the ticket instead of looping forever.
    const attempts = new Map<string, number>();
    const provider = new FakeProvider(async function* (ctx) {
      const phase = phaseFromPrompt(ctx.prompt);
      const attempt = (attempts.get(phase) ?? 0) + 1;
      attempts.set(phase, attempt);
      yield* conversation(phase, ctx.prompt);
      if (phase === "research") {
        return { outcome: "failed" as const, failureReason: "claude exit 2" };
      }
      writeContract(ctx.cwd, phase);
      return { outcome: "completed" as const };
    });
    const { server, ticket } = await bootWorkspace(provider);
    const runs = await waitForSettledRuns(server, ticket.id, 3);
    const parked = await waitForTicketState(server, ticket.id, "human_review");

    expect(runs.every((run: any) => run.state === "crashed")).toBe(true);
    expect(runs[0].crashReason).toContain("claude exit 2");
    expect(parked.arrivedByCap).toBe(true);

    const audit = await auditOf(server, ticket.id);
    const parkEvent = audit.find((event: any) => event.type === "ticket.parked");
    expect(parkEvent.detail).toMatchObject({ reason: "crash-cap", crashCount: 3 });
    // The non-zero exit was audited as its own death mode.
    const deaths = audit.filter((event: any) => event.type === "phase.crashed");
    expect(deaths.every((event: any) => event.detail.deathMode === "non-zero-exit")).toBe(true);
    expect(deaths).toHaveLength(6);
  }, 30_000);
});

describe("the watchdogs", () => {
  test("15 minutes of silence kills the phase — a death like any other", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      sabotage: (phase, attempt) => (phase === "implement" && attempt <= 2 ? "hang" : undefined),
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      phaseTimeouts: { silenceMs: 250, wallClockMs: 60_000 },
    });
    await waitForTicketState(server, ticket.id, "human_review", 25_000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[1].state).toBe("crashed");
    const deaths = (await auditOf(server, ticket.id)).filter(
      (event: any) => event.type === "phase.crashed",
    );
    expect(deaths.every((event: any) => event.detail.deathMode === "silence")).toBe(true);
    expect(deaths).toHaveLength(2);
  }, 30_000);

  test("the wall-clock timeout SIGTERMs a provider the silence watchdog can't catch", async () => {
    // Hung with silence effectively disabled: only the per-phase wall clock
    // can end this one.
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      sabotage: (phase, attempt) => (phase === "implement" && attempt <= 2 ? "hang" : undefined),
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      phaseTimeouts: { silenceMs: 60_000, wallClockMs: 350 },
    });
    await waitForTicketState(server, ticket.id, "human_review", 25_000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[1].state).toBe("crashed");
    const deaths = (await auditOf(server, ticket.id)).filter(
      (event: any) => event.type === "phase.crashed",
    );
    expect(deaths.every((event: any) => event.detail.deathMode === "timeout")).toBe(true);
  }, 30_000);
});

describe("the startup orphan sweep", () => {
  test("kill-the-app mid-phase → relaunch marks the orphan crashed and recovers", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-orphan-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const github = new FakeGitHub();

    // First life: the agent hangs at implement, and the app dies under it.
    const calls: PhaseCall[] = [];
    const hanging = scriptedProvider(calls, {
      sabotage: (phase) => (phase === "implement" ? "hang" : undefined),
    });
    const first = await startServer({
      dataDir,
      port: 0,
      workers: 3,
      providers: { "claude-code": hanging },
      github,
      previewPortBase: previewPortBase(),
    });
    // Belt-and-braces: if the test dies before the deliberate close below,
    // don't leak the first server (the double-close rejection is expected).
    cleanups.push(async () => first.close().catch(() => {}));
    const { project, repo } = await seedWorkspace(first);
    const ticket = (
      await api(first, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Ship the widget",
        description: "The widget must ship.",
        acceptanceCriteria: ["Widget renders"],
      })
    ).json;
    await api(first, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    const deadline = Date.now() + 15_000;
    while (!calls.some((call) => call.phase === "implement")) {
      if (Date.now() > deadline) throw new Error("implement never started");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A quit mid-phase records nothing: the run is still "running" on disk.
    await first.close();

    // Second life: the sweep marks the orphan crashed, the policy returns the
    // ticket to Todo, and a behaved provider carries it home.
    const behaved = scriptedProvider([], { onPhase: pushesToGitHub(github) });
    const second = await bootServer(dataDir, {
      workers: 3,
      providers: { "claude-code": behaved },
      github,
    });
    await waitForTicketState(second, ticket.id, "human_review", 20_000);

    const runs = (await api(second, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    const orphan = runs[1];
    expect(orphan.state).toBe("crashed");
    expect(orphan.crashReason).toContain("orphan");
    // The mid-flight phase was reaped with its own mode…
    const implement = orphan.phases.find((p: any) => p.phase === "implement");
    expect(implement.state).toBe("crashed");
    // …and the kb evidence the orphan left in its worktree was persisted,
    // closing slice 27's "every Run end persists evidence" gap.
    expect(orphan.artifacts.map((a: any) => a.name).sort()).toEqual(["plan.md", "research.md"]);
    const audit = await auditOf(second, ticket.id);
    const orphanDeath = audit.find(
      (event: any) => event.type === "phase.crashed" && event.detail.deathMode === "orphan",
    );
    expect(orphanDeath.detail.phase).toBe("implement");
  }, 40_000);
});
