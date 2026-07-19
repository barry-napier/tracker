import { createServer, type Server } from "node:net";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import { PreviewManager, type PreviewView } from "../src/server/previews.ts";
import { StateError, Store } from "../src/server/store.ts";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, cleanups, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/**
 * A preview app fixture: an http server that binds $PORT and answers with
 * its cwd, port, and a per-boot nonce — enough to prove the worktree spawn,
 * the injected port, and that a restart really is a fresh process.
 */
const PREVIEW_SERVER = `
import { createServer } from "node:http";
const bootId = Math.random().toString(36).slice(2);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ cwd: process.cwd(), port: process.env.PORT, bootId }));
}).listen(process.env.PORT, "127.0.0.1");
`;

/** Binds immediately but answers /healthz with the given status. */
const HEALTHZ_SERVER = (status: number) => `
import { createServer } from "node:http";
createServer((req, res) => {
  res.statusCode = req.url === "/healthz" ? ${status} : 404;
  res.end();
}).listen(process.env.PORT, "127.0.0.1");
`;

/**
 * The store rows a preview needs, forged directly (no server, no git): a
 * promoted+claimed ticket whose run points at a scratch "worktree" holding
 * the preview app. Returns everything a PreviewManager call needs.
 */
function forgeWorkspace(repoConfig: Record<string, unknown>, serverScript = PREVIEW_SERVER) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "tracker-preview-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = openDatabase(dataDir);
  const store = new Store(db, new EventBus());
  const project = store.createProject({ name: "Preview Fixture" });
  const repo = store.createRepo({
    projectId: project.id,
    path: "/nowhere/checkout",
    githubRemote: "git@github.com:barry/preview-fixture.git",
    ...(repoConfig as object),
  });
  const ticket = store.createTicket({
    projectId: project.id,
    title: "Previewable work",
    acceptanceCriteria: ["It runs"],
  });
  store.promoteTicket(ticket.id, { repoId: repo.id, provider: "claude-code" });
  const claim = store.claimNextTicket()!;
  const worktree = mkdtempSync(path.join(tmpdir(), "tracker-preview-wt-"));
  cleanups.push(() => rm(worktree, { recursive: true, force: true }));
  writeFileSync(path.join(worktree, "preview-server.mjs"), serverScript);
  store.recordWorktree(claim.run.id, { worktreePath: worktree, created: true });

  const previews = new PreviewManager(dataDir, store);
  cleanups.push(async () => {
    await previews.stopAll();
    db.close();
  });
  return { store, previews, ticket: store.getTicket(ticket.id)!, worktree };
}

async function waitForStatus(
  previews: PreviewManager,
  ticketId: number,
  status: string,
  timeoutMs = 10_000,
): Promise<PreviewView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = previews.view(ticketId);
    if (view.record?.status === status) return view;
    if (view.record?.status === "failed" && status !== "failed") {
      throw new Error(`preview failed while waiting for ${status}: ${view.logTail}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for preview ${status}; at ${view.record?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const blocker = createServer();
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve(blocker));
  });
}

describe("PreviewManager (ticket 34)", () => {
  for (const kind of ["ui", "api"] as const) {
    test(`${kind} repo: starts from the worktree with $PORT, serves, restarts fresh, stops cleanly`, async () => {
      const { previews, ticket, worktree } = forgeWorkspace({
        previewCommand: "node preview-server.mjs",
        previewKind: kind,
      });

      const started = await previews.start(ticket.id);
      expect(started.configured).toBe(true);
      expect(started.kind).toBe(kind);
      expect(started.record).toMatchObject({ status: "starting", port: 4000 + ticket.number });

      const ready = await waitForStatus(previews, ticket.id, "ready");
      expect(ready.url).toBe(`http://localhost:${ready.record!.port}`);
      const body: any = await (await fetch(`http://127.0.0.1:${ready.record!.port}`)).json();
      // Spawned from the ticket's worktree with the bound port injected.
      expect(realpathSync(body.cwd)).toBe(realpathSync(worktree));
      expect(Number(body.port)).toBe(ready.record!.port);

      // A restart is a fresh process, not a survivor: the boot nonce changes.
      await previews.restart(ticket.id);
      const restarted = await waitForStatus(previews, ticket.id, "ready");
      const rebooted: any = await (await fetch(`http://127.0.0.1:${restarted.record!.port}`)).json();
      expect(rebooted.bootId).not.toBe(body.bootId);

      await previews.stop(ticket.id);
      expect(previews.view(ticket.id).record).toMatchObject({ status: "stopped" });
      await expect(fetch(`http://127.0.0.1:${restarted.record!.port}`)).rejects.toThrow();
    });
  }

  test("preferred port taken → probes up and stores the actual port", async () => {
    const { previews, ticket } = forgeWorkspace({ previewCommand: "node preview-server.mjs" });
    const preferred = 4000 + ticket.number;
    const blocker = await holdPort(preferred);
    cleanups.push(async () => void blocker.close());

    await previews.start(ticket.id);
    const ready = await waitForStatus(previews, ticket.id, "ready");
    expect(ready.record!.port).toBe(preferred + 1);
    expect((await fetch(`http://127.0.0.1:${preferred + 1}`)).ok).toBe(true);
  });

  test("readiness timeout → failed with the captured output surfaced", async () => {
    const { previews, ticket } = forgeWorkspace({
      previewCommand: `node -e "console.log('booting but never listening'); setInterval(() => {}, 1000)"`,
      previewReadinessTimeoutMs: 400,
    });
    await previews.start(ticket.id);
    const failed = await waitForStatus(previews, ticket.id, "failed");
    expect(failed.logTail).toContain("booting but never listening");
  });

  test("process exit before ready → failed with the captured output surfaced", async () => {
    const { previews, ticket } = forgeWorkspace({
      previewCommand: `node -e "console.error('kaboom'); process.exit(3)"`,
    });
    await previews.start(ticket.id);
    const failed = await waitForStatus(previews, ticket.id, "failed");
    expect(failed.logTail).toContain("kaboom");
  });

  test("HTTP readiness override really checks HTTP, not just the TCP bind", async () => {
    // Red: binds instantly (TCP-open would pass) but /healthz answers 500.
    const red = forgeWorkspace(
      {
        previewCommand: "node preview-server.mjs",
        previewReadinessPath: "/healthz",
        previewReadinessTimeoutMs: 600,
      },
      HEALTHZ_SERVER(500),
    );
    await red.previews.start(red.ticket.id);
    const failed = await waitForStatus(red.previews, red.ticket.id, "failed");
    expect(failed.record!.status).toBe("failed");

    // Green: same shape, /healthz answers 204.
    const green = forgeWorkspace(
      { previewCommand: "node preview-server.mjs", previewReadinessPath: "/healthz" },
      HEALTHZ_SERVER(204),
    );
    await green.previews.start(green.ticket.id);
    await waitForStatus(green.previews, green.ticket.id, "ready");
  });

  test("start is refused without config or worktree; view degrades gracefully", async () => {
    const bare = forgeWorkspace({});
    expect(bare.previews.view(bare.ticket.id).configured).toBe(false);
    await expect(bare.previews.start(bare.ticket.id)).rejects.toThrow(StateError);
  });
});

describe("preview endpoints in the wizard flow (ticket 34)", () => {
  test("start on wizard demand, ready with a link, verdict submit stops it", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        // Committed so the eventual squash merge has content (like verdicts.test).
        if (ctx.phase === "implement" && ctx.attempt === 1) {
          writeFileSync(path.join(ctx.cwd, "preview-server.mjs"), PREVIEW_SERVER);
          git(ctx.cwd, "add", "preview-server.mjs");
          git(ctx.cwd, "commit", "-m", "add preview server");
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: {
        testCommand: "true",
        previewCommand: "node preview-server.mjs",
        previewKind: "ui",
      },
    });
    // A preview-configured repo owes a demo the workflow can't record until
    // slice 35, so demo-fresh fails every cycle and the ticket arrives at
    // Human Review by bounce cap — exactly the state the wizard opens on.
    const arrived = await waitForTicketState(server, ticket.id, "human_review");
    expect(arrived.arrivedByCap).toBe(true);

    // First use creates the record keyed to the ticket.
    const before = await api(server, "GET", `/api/tickets/${ticket.id}/preview`);
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ configured: true, kind: "ui", record: null });

    const started = await api(server, "POST", `/api/tickets/${ticket.id}/preview/start`);
    expect(started.status).toBe(200);
    expect(started.json.record.status).toBe("starting");

    const deadline = Date.now() + 10_000;
    let view: any;
    for (;;) {
      view = (await api(server, "GET", `/api/tickets/${ticket.id}/preview`)).json;
      if (view.record.status === "ready") break;
      if (view.record.status === "failed" || Date.now() > deadline) {
        throw new Error(`preview never became ready: ${JSON.stringify(view)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(view.url).toBe(`http://localhost:${view.record.port}`);
    expect((await fetch(`http://127.0.0.1:${view.record.port}`)).ok).toBe(true);

    // Settle the cap-park's leftover follow-ups so the pass verdict is legal.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    for (const ac of detail.acceptanceCriteria) {
      if (ac.status !== "verified" && ac.status !== "waived") {
        await api(server, "POST", `/api/acs/${ac.id}/waive`, { reason: "demo lands in slice 35" });
      }
    }

    // The pass verdict merges — and takes the preview down with it.
    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    if (verdict.status !== 200) throw new Error(`verdict → ${JSON.stringify(verdict.json)}`);
    const after = (await api(server, "GET", `/api/tickets/${ticket.id}/preview`)).json;
    expect(after.record.status).toBe("stopped");
    await expect(fetch(`http://127.0.0.1:${view.record.port}`)).rejects.toThrow();
  });

  test("repo without preview config → degraded view, start refused", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "P" })).json;
    await api(server, "POST", "/api/repos", {
      projectId: project.id,
      path: "/nowhere",
      githubRemote: "git@github.com:barry/no-preview.git",
    });
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "No preview here",
        acceptanceCriteria: ["Still reviewable"],
      })
    ).json;

    const view = await api(server, "GET", `/api/tickets/${ticket.id}/preview`);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ configured: false, record: null, url: null });

    const start = await api(server, "POST", `/api/tickets/${ticket.id}/preview/start`);
    expect(start.status).toBe(409);
    expect(start.json.error).toContain("preview");

    const missing = await api(server, "GET", "/api/tickets/9999/preview");
    expect(missing.status).toBe(404);
  });
});
