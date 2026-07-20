import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import type { GitHubPort } from "../src/server/github.ts";
import { PreviewManager } from "../src/server/previews.ts";
import { Store } from "../src/server/store.ts";
import { DoneSweeper } from "../src/server/sweep.ts";
import { WorktreeManager } from "../src/server/worktrees.ts";
import { git, initScratchRepo } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { startServer } from "../src/server/index.ts";
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
  pushesToGitHub,
  scriptedProvider,
  waitForSettledRuns,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

// The Done-column sweep (ticket 42): disk hygiene without evidence loss.
// Done does not auto-destroy — reaping is deliberate, predicate-guarded
// (merged AND persisted), and everything skipped says why.

afterEach(runCleanups);

describe("the sweep predicate, against a real worktree", () => {
  /**
   * A Done ticket built by hand at the store seam: claimed, worktree cut by
   * the real manager, evidence persisted, verified, PR recorded, merged.
   * Full control of the predicate's inputs, no pipeline in the way.
   */
  async function doneWorkspace() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-sweep-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const db = openDatabase(dataDir);
    cleanups.push(async () => db.close());
    const store = new Store(db, new EventBus());
    const source = initScratchRepo("sweep-app");
    cleanups.push(() => rm(path.dirname(source), { recursive: true, force: true }));

    const project = store.createProject({ name: "Sweep" });
    const repo = store.createRepo({
      projectId: project.id,
      path: source,
      githubRemote: "git@github.com:x/sweep.git",
    });
    const worktrees = new WorktreeManager(dataDir);
    const artifacts = new ArtifactStore(dataDir, store);
    const previews = new PreviewManager(dataDir, store, previewPortBase());

    const finishTicket = async (title: string, pr: number | null) => {
      const created = store.createTicket({ projectId: project.id, title, acceptanceCriteria: [] });
      store.promoteTicket(created.id, { repoId: repo.id, provider: "claude-code" });
      const claim = store.claimNextTicket()!;
      const cut = await worktrees.ensureWorktree(repo, claim.ticket.displayKey, claim.ticket.branch!);
      store.recordWorktree(claim.run.id, cut);
      mkdirSync(path.join(cut.worktreePath, "kb"), { recursive: true });
      writeFileSync(path.join(cut.worktreePath, "kb", "research.md"), "# research\n");
      await artifacts.persistRun(claim.run.id, cut.worktreePath);
      store.finishRun(claim.run.id, "completed");
      store.concludeVerification(claim.run.id, { passed: true, failed: [] });
      if (pr !== null) store.recordPr(created.id, { number: pr, url: `https://github.test/pr/${pr}` });
      store.mergeTicket(created.id);
      return { ticket: store.getTicket(created.id)!, worktreePath: cut.worktreePath };
    };

    return { dataDir, store, project, worktrees, previews, artifacts, finishTicket };
  }

  test("skips say why — unmerged PR, missing PR, unpersisted evidence — then the reap lands", async () => {
    const { dataDir, store, project, worktrees, previews, artifacts, finishTicket } =
      await doneWorkspace();
    let merged = false;
    const github = { prMerged: async () => merged } as unknown as GitHubPort;
    const sweeper = new DoneSweeper(store, worktrees, previews, artifacts, github);
    const { ticket, worktreePath } = await finishTicket("Ship the widget", 7);

    // A preview record with a captured log, as a wizard walkthrough leaves it.
    const logPath = path.join("previews", `ticket-${ticket.id}.log`);
    mkdirSync(path.join(dataDir, "previews"), { recursive: true });
    writeFileSync(path.join(dataDir, logPath), "preview said hello\n");
    store.upsertPreview(ticket.id, { status: "stopped", logPath });

    // Not merged on the remote → skipped, worktree untouched.
    let result = await sweeper.sweep(project.id);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([
      {
        ticketId: ticket.id,
        displayKey: ticket.displayKey,
        reason: "PR #7 is not verifiably merged on the remote",
      },
    ]);
    expect(existsSync(worktreePath)).toBe(true);

    // Merged, but the worktree holds kb evidence no artifact row vouches for.
    merged = true;
    writeFileSync(path.join(worktreePath, "kb", "stray.md"), "never persisted\n");
    result = await sweeper.sweep(project.id);
    expect(result.reaped).toEqual([]);
    expect(result.skipped[0]!.reason).toBe("unpersisted evidence: kb/stray.md");
    expect(existsSync(worktreePath)).toBe(true);

    // Evidence accounted for → the reap: worktree gone, preview record and
    // log gone, one audit event, ticket still Done.
    await rm(path.join(worktreePath, "kb", "stray.md"));
    result = await sweeper.sweep(project.id);
    expect(result.reaped).toEqual([
      { ticketId: ticket.id, displayKey: ticket.displayKey, worktreePath, previewRemoved: true },
    ]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(store.getPreview(ticket.id)).toBeUndefined();
    expect(existsSync(path.join(dataDir, logPath))).toBe(false);
    expect(store.getTicket(ticket.id)!.state).toBe("done");
    const reapedEvents = store
      .listAuditEvents(ticket.id)
      .filter((event) => event.type === "worktree.reaped");
    expect(reapedEvents).toHaveLength(1);
    expect(reapedEvents[0]!.detail).toMatchObject({
      worktreePath,
      previewRemoved: true,
      prNumber: 7,
    });

    // Nothing left to reap → not a candidate anymore; the sweep goes quiet.
    result = await sweeper.sweep(project.id);
    expect(result).toEqual({ reaped: [], skipped: [] });

    // A Done ticket that somehow never recorded its PR is skipped, not reaped.
    const noPr = await finishTicket("chore: tidy", null);
    result = await sweeper.sweep(project.id);
    expect(result.skipped).toEqual([
      { ticketId: noPr.ticket.id, displayKey: noPr.ticket.displayKey, reason: "no PR recorded on the ticket" },
    ]);
    expect(existsSync(noPr.worktreePath)).toBe(true);
  });
});

describe("the sweep through the API, against the real pipeline", () => {
  test("a merged ticket's worktree is reaped through the Done column's route", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement" && ctx.attempt === 1) {
          writeFileSync(path.join(ctx.cwd, "widget.txt"), "the widget\n");
          git(ctx.cwd, "add", "widget.txt");
          git(ctx.cwd, "commit", "-m", "add widget");
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });
    await waitForTicketState(server, ticket.id, "human_review");
    const pass = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, { outcome: "pass" });
    expect(pass.status).toBe(200);
    const done = await waitForTicketState(server, ticket.id, "done");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const worktreePath = runs[0].worktreePath;
    expect(existsSync(worktreePath)).toBe(true);

    const sweep = await api(server, "POST", `/api/projects/${ticket.projectId}/sweep`, {});
    expect(sweep.status).toBe(200);
    expect(sweep.json.reaped).toMatchObject([
      { ticketId: ticket.id, displayKey: done.displayKey, worktreePath },
    ]);
    expect(sweep.json.skipped).toEqual([]);
    expect(existsSync(worktreePath)).toBe(false);

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(audit.some((event: any) => event.type === "worktree.reaped")).toBe(true);

    // Idempotent: a second sweep finds nothing to say.
    const again = await api(server, "POST", `/api/projects/${ticket.projectId}/sweep`, {});
    expect(again.json).toEqual({ reaped: [], skipped: [] });
  }, 30_000);

  test("a parked ticket is no candidate, and startup removes only true orphan dirs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-sweep-orphan-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    // Research dies every attempt: 3 crashed runs park the ticket, its
    // worktree left in place for inspection. The first server is closed by
    // hand mid-test, so it can't ride the auto-cleanup.
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      sabotage: (phase) => {
        if (phase === "research") throw new Error("dies for the cap");
      },
    });
    const server = await startServer({
      dataDir,
      port: 0,
      workers: 3,
      providers: { "claude-code": provider },
      github: new FakeGitHub(),
      previewPortBase: previewPortBase(),
    });
    cleanups.push(async () => server.close().catch(() => {}));
    const { project, repo } = await seedWorkspace(server);
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Ship the widget",
        description: "The widget must ship.",
        acceptanceCriteria: ["Widget renders"],
      })
    ).json;
    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    await waitForSettledRuns(server, ticket.id, 3);
    const parked = await waitForTicketState(server, ticket.id, "human_review");
    expect(parked.arrivedByCap).toBe(true);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const worktreePath = runs[0].worktreePath;
    expect(existsSync(worktreePath)).toBe(true);

    // Parked tickets keep their worktrees indefinitely — not even a skip row.
    const sweep = await api(server, "POST", `/api/projects/${ticket.projectId}/sweep`, {});
    expect(sweep.json).toEqual({ reaped: [], skipped: [] });
    expect(existsSync(worktreePath)).toBe(true);

    // Kill the app, plant strays, relaunch: reconciliation removes only the
    // directories no ticket accounts for.
    await server.close();
    const worktreesDir = path.dirname(worktreePath);
    const stray = path.join(worktreesDir, "fixture-app--trk-99");
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, "leftover.txt"), "from a wiped DB\n");

    const second = await bootServer(dataDir, { workers: 0 });
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
    // The parked ticket is untouched by the relaunch.
    const after = (await api(second, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(after.state).toBe("human_review");
  }, 40_000);
});
