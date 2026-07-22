import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/server/bus.ts";
import { migrate } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { startServer, type TrackerServer } from "../src/server/index.ts";
import { FakeProvider, phaseFromPrompt } from "../src/server/providers/fake.ts";
import { FakeGitHub } from "./github-fake.ts";
import {
  api,
  bootServer,
  cleanups,
  previewPortBase,
  runCleanups,
  seedProviderInstance,
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

describe("phase-level resume credit", () => {
  test("a bounce cycle gets no credit — even from a crashed run before the completed one", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    const store = new Store(db, new EventBus());
    const project = store.createProject({ name: "p", ticketPrefix: "P" });
    const repo = store.createRepo({ projectId: project.id, path: "/tmp/x", githubRemote: null });
    const ticket = store.createTicket({
      projectId: project.id,
      title: "t",
      acceptanceCriteria: ["a"],
    });
    store.promoteTicket(ticket.id, { repoId: repo.id, provider: "claude-code" });

    // Run A crashes with a completed research phase in the worktree.
    const a = store.claimNextTicket()!;
    const worktree = { worktreePath: "/tmp/wt", branch: ticket.displayKey, created: true };
    store.recordWorktree(a.run.id, worktree);
    const graph = store.getWorkflowGraph(a.run.workflowVersionId);
    const research = graph.nodes.find((n) => n.name === "research")!;
    store.endPhase(store.startPhase(a.run.id, research).id, "completed");
    store.finishRun(a.run.id, "crashed", "orphaned: the app quit mid-phase");

    // Run B resumes and completes — its successor is a bounce cycle.
    const b = store.claimNextTicket()!;
    store.recordWorktree(b.run.id, worktree);
    // B's immediate predecessor crashed: credit applies.
    expect(store.priorPhaseCredit(b.run, "/tmp/wt").has(research.id)).toBe(true);
    store.finishRun(b.run.id, "completed");

    // Run C follows the completed B (bounce): no credit, not even from A.
    db.prepare("UPDATE tickets SET state = 'todo' WHERE id = ?").run(ticket.id);
    const c = store.claimNextTicket()!;
    store.recordWorktree(c.run.id, worktree);
    expect(store.priorPhaseCredit(c.run, "/tmp/wt").size).toBe(0);
  });
});

describe("the crash cap", () => {
  test("orphaned crashes are exempt: app restarts never park a healthy ticket", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    const store = new Store(db, new EventBus());
    const project = store.createProject({ name: "p", ticketPrefix: "P" });
    const repo = store.createRepo({ projectId: project.id, path: "/tmp/x", githubRemote: null });
    const ticket = store.createTicket({
      projectId: project.id,
      title: "t",
      acceptanceCriteria: ["a"],
    });
    store.promoteTicket(ticket.id, { repoId: repo.id, provider: "claude-code" });

    // Three orphaned crashes in a row — a dev restarting the app, not the
    // work failing — and the ticket keeps going back to Todo, never parked.
    for (let i = 0; i < 3; i++) {
      const claimed = store.claimNextTicket()!;
      const after = store.finishRun(claimed.run.id, "crashed", "orphaned: the app quit mid-phase");
      expect(after.state).toBe("crashed");
      expect(store.getTicket(ticket.id)!.state).toBe("todo");
    }
    expect(store.getTicket(ticket.id)!.arrivedByCap).toBe(false);

    // Real crashes still count: three of them park the ticket at the cap.
    for (let i = 0; i < 3; i++) {
      const claimed = store.claimNextTicket()!;
      store.finishRun(claimed.run.id, "crashed", "provider fell over");
    }
    const parked = store.getTicket(ticket.id)!;
    expect(parked.state).toBe("human_review");
    expect(parked.arrivedByCap).toBe(true);
  });

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

describe("setup failure", () => {
  test("a deterministic setup error parks the ticket at once, no cap burned", async () => {
    // A target branch the repo doesn't have: worktree setup can never
    // succeed, so retrying is pointless. One run ends "failed" — not three
    // "crashed" — and the ticket parks wearing the reason.
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls);
    const { server, ticket } = await bootWorkspace(provider, {
      repo: { targetBranch: "no-such-branch" },
    });
    const parked = await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(runs[0].crashReason).toContain("setup failed");
    // No provider ever ran, and the park is not the crash cap's doing.
    expect(calls).toHaveLength(0);
    expect(parked.arrivedByCap).toBe(false);
    // The board card wears the reason (steal 1): derived off the latest run.
    expect(parked.lastFailureReason).toContain("setup failed");

    // Retry: a human sends the parked ticket back to Todo; the pool wakes on
    // the emit and attempts again (the repo is still broken, so it parks
    // again — proving the whole loop, not just the state flip).
    const retried = await api(server, "POST", `/api/tickets/${ticket.id}/retry`, {});
    expect(retried.json.state).toBe("todo");
    // Retry is only legal from human_review — an immediate second call 409s.
    const again = await api(server, "POST", `/api/tickets/${ticket.id}/retry`, {});
    expect(again.status).toBe(409);
    await waitForSettledRuns(server, ticket.id, 2);
    await waitForTicketState(server, ticket.id, "human_review");
    const audit = await auditOf(server, ticket.id);
    expect(audit.some((event: any) => event.type === "ticket.retried")).toBe(true);
  }, 25_000);
});

describe("dead graph", () => {
  test("a workflow that runs no phases parks at once as failed — no cap, no battery, no bounce", async () => {
    // A branching trigger published before the trigger-branch validator rule
    // existed (the REV-1 incident): the engine's walk finds no unlabeled
    // edge off the trigger and executes nothing. That must park like a setup
    // failure — one "failed" run wearing the reason — and never reach the
    // gate battery to bounce nonsense follow-up criteria onto the ticket.
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls);
    const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-dead-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const server = await bootServer(dataDir, {
      workers: 3,
      providers: { "claude-code": provider },
    });
    const { project, repo } = await seedWorkspace(server);

    // Seed the broken graph straight into the store — publish rightly
    // refuses it now, but versions like it are already pinned on disk.
    const db = new DatabaseSync(path.join(dataDir, "tracker.db"));
    const workflowId = Number(
      db
        .prepare(
          "INSERT INTO workflows (name, archived, is_default, created_at) VALUES ('dead', 0, 0, '2026-01-01')",
        )
        .run().lastInsertRowid,
    );
    const versionId = Number(
      db
        .prepare(
          "INSERT INTO workflow_versions (workflow_id, version, created_at) VALUES (?, 1, '2026-01-01')",
        )
        .run(workflowId).lastInsertRowid,
    );
    const insertNode = db.prepare(
      "INSERT INTO workflow_nodes (workflow_version_id, type, name, prompt_template) VALUES (?, ?, ?, ?)",
    );
    const triggerId = Number(insertNode.run(versionId, "trigger", "ticket-claimed", null).lastInsertRowid);
    const smallId = Number(insertNode.run(versionId, "agent_phase", "small", "do small").lastInsertRowid);
    const largeId = Number(insertNode.run(versionId, "agent_phase", "large", "do large").lastInsertRowid);
    const insertEdge = db.prepare(
      "INSERT INTO workflow_edges (workflow_version_id, from_node_id, to_node_id, condition_label) VALUES (?, ?, ?, ?)",
    );
    insertEdge.run(versionId, triggerId, smallId, "single feature");
    insertEdge.run(versionId, triggerId, largeId, "large initiative");
    db.close();
    await api(server, "PATCH", `/api/projects/${project.id}`, { workflowId });

    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Ship the widget",
        acceptanceCriteria: ["Widget renders"],
      })
    ).json;
    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    const parked = await waitForTicketState(server, ticket.id, "human_review");

    // One "failed" run, zero phases, the provider never invoked.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(runs[0].crashReason).toContain("ran no agent phases");
    expect(runs[0].phases).toEqual([]);
    expect(calls).toHaveLength(0);
    // Parked wearing the reason, not by the crash cap.
    expect(parked.arrivedByCap).toBe(false);
    expect(parked.lastFailureReason).toContain("ran no agent phases");
    // The battery never judged it: no gate results, no bounce criteria.
    expect(runs[0].gateResults ?? []).toEqual([]);
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria).toHaveLength(1);
    expect(detail.acceptanceCriteria[0].origin).toBe("original");
  }, 25_000);
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
    await seedProviderInstance(first);
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
    const secondCalls: PhaseCall[] = [];
    const behaved = scriptedProvider(secondCalls, { onPhase: pushesToGitHub(github) });
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

    // Phase-level resume: the recovery run credited the orphan's completed
    // prefix (research, plan — contracts still in the reused worktree) and
    // started executing at implement. The provider never re-ran the prefix…
    expect(secondCalls.map((call) => call.phase)).toEqual(["implement", "dogfood", "document"]);
    // …the credited phases are on the recovery run as completed rows…
    const recovery = runs[0];
    expect(recovery.phases.map((p: any) => [p.phase, p.state])).toEqual([
      ["research", "completed"],
      ["plan", "completed"],
      ["implement", "completed"],
      ["dogfood", "completed"],
      ["document", "completed"],
    ]);
    // …and the trail says "resumed", never "completed", for the credit.
    const resumed = audit.filter((event: any) => event.type === "phase.resumed");
    expect(resumed.map((event: any) => event.detail.phase)).toEqual(["research", "plan"]);
    // The app quitting is not the work failing: the orphan didn't burn the
    // crash cap.
    const ticketNow = (await api(second, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(ticketNow.arrivedByCap).toBe(false);
  }, 40_000);
});
