import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import { DemoRecorder, demoExpectation } from "../src/server/demos.ts";
import { GateBattery } from "../src/server/gates.ts";
import { PreviewManager } from "../src/server/previews.ts";
import { Store } from "../src/server/store.ts";
import { commit, git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, cleanups, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  writePlanChecks,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** A preview app that reports a marker — proof the demo hit the live server. */
const PREVIEW_SERVER = `
import { createServer } from "node:http";
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ marker: "demo-fixture", port: process.env.PORT }));
}).listen(process.env.PORT, "127.0.0.1");
`;

/**
 * Stands in for the worktree's own Playwright at the process boundary the
 * recorder really crosses (`npx --no-install playwright test --config=…`):
 * honors the orchestrator-authored config, refuses unless recordVideo was
 * demanded, and "records" whatever the live preview actually serves. CJS on
 * purpose — a bare node_modules/.bin executable loads as CommonJS.
 */
const PLAYWRIGHT_SHIM = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const arg = process.argv.find((a) => a.startsWith("--config="));
  const config = (await import(pathToFileURL(arg.slice("--config=".length)).href)).default;
  if (config.use.video !== "on") throw new Error("recordVideo was not demanded");
  const res = await fetch(config.use.baseURL + "/");
  mkdirSync(path.join(config.outputDir, "demo-run"), { recursive: true });
  writeFileSync(path.join(config.outputDir, "demo-run", "video.webm"), "WEBM:" + (await res.text()));
})().catch((error) => { console.error(error); process.exit(1); });
`;

/** The agent's job for a ui repo: preview app, demo spec, and its Playwright. */
function writeUiDemoAssets(cwd: string): void {
  writeFileSync(path.join(cwd, "preview-server.mjs"), PREVIEW_SERVER);
  mkdirSync(path.join(cwd, "demo"), { recursive: true });
  writeFileSync(path.join(cwd, "demo", "demo.spec.ts"), "// walked by the shim\n");
  mkdirSync(path.join(cwd, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(cwd, "node_modules", ".bin", "playwright"), PLAYWRIGHT_SHIM, {
    mode: 0o755,
  });
}

/** The agent's job for an api repo: preview app plus the curl script. */
function writeApiDemoAssets(cwd: string): void {
  writeFileSync(path.join(cwd, "preview-server.mjs"), PREVIEW_SERVER);
  mkdirSync(path.join(cwd, "demo"), { recursive: true });
  writeFileSync(path.join(cwd, "demo", "demo.sh"), '#!/bin/sh\ncurl -sS "$BASE_URL/"\n', {
    mode: 0o755,
  });
}

describe("the demo phase (ticket 35)", () => {
  test("ui repo: the run records a video against the live preview and demo-fresh passes", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") writeUiDemoAssets(ctx.cwd);
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true", previewCommand: "node preview-server.mjs", previewKind: "ui" },
    });

    // Gates all green — the ticket arrives at Human Review on merit, not cap.
    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.arrivedByCap).toBe(false);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs[0].gateResults.find((r: any) => r.gate === "demo-fresh")).toMatchObject({
      status: "pass",
      detail: { name: "demo.webm" },
    });

    // The artifact row persisted at the worktree HEAD, served as video, and
    // carrying what the preview actually answered — recorded, not asserted.
    const artifact = runs[0].artifacts.find((a: any) => a.kind === "demo");
    expect(artifact).toMatchObject({ name: "demo.webm" });
    const content = await fetch(`${server.url}/api/artifacts/${artifact.id}/content`);
    expect(content.headers.get("content-type")).toBe("video/webm");
    expect(await content.text()).toContain('"marker":"demo-fixture"');

    // The demo boot audits as the orchestrator, and the process is gone —
    // the record parks at stopped until the wizard starts its own.
    const started = await waitForAudit(server, ticket.id, "preview.started");
    expect(started.actor).toBe("agent");
    const view = (await api(server, "GET", `/api/tickets/${ticket.id}/preview`)).json;
    expect(view.record.status).toBe("stopped");
  }, 30_000);

  test("api repo: the curl script's transcript is the demo artifact and demo-fresh passes", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") writeApiDemoAssets(ctx.cwd);
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true", previewCommand: "node preview-server.mjs", previewKind: "api" },
    });

    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.arrivedByCap).toBe(false);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs[0].gateResults.find((r: any) => r.gate === "demo-fresh")).toMatchObject({
      status: "pass",
      detail: { name: "curl-transcript.txt" },
    });
    const artifact = runs[0].artifacts.find((a: any) => a.kind === "demo");
    const content = await (
      await fetch(`${server.url}/api/artifacts/${artifact.id}/content`)
    ).text();
    expect(content).toContain("$ sh demo/demo.sh");
    expect(content).toContain('"marker":"demo-fixture"');
  }, 30_000);

  test("a stale demo — new commits, no new recording — fails demo-fresh by SHA", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      // Cycle 1 fails its AC check (forcing a bounce) but records a good
      // demo; later cycles commit new code and break the demo script, so the
      // only demo evidence stays cycle 1's.
      planChecks: (ctx) =>
        writePlanChecks(ctx.cwd, ctx.prompt, () =>
          ctx.attempt === 1 ? "#!/bin/sh\nexit 3\n" : "#!/bin/sh\nexit 0\n",
        ),
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") {
          if (ctx.attempt === 1) {
            writeApiDemoAssets(ctx.cwd);
            git(ctx.cwd, "add", "preview-server.mjs", "demo");
            git(ctx.cwd, "commit", "-m", "preview + demo assets");
          } else {
            commit(ctx.cwd, `fix-${ctx.attempt}.txt`, "more code\n", "the fix");
            writeFileSync(path.join(ctx.cwd, "demo", "demo.sh"), "#!/bin/sh\nexit 1\n", {
              mode: 0o755,
            });
          }
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true", previewCommand: "node preview-server.mjs", previewKind: "api" },
    });

    // demo-fresh never recovers, so the bounce cap parks the ticket.
    const arrived = await waitForTicketState(server, ticket.id, "human_review", 60_000);
    expect(arrived.arrivedByCap).toBe(true);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const first = runs.at(-1);
    const second = runs.at(-2);

    // Cycle 1: fresh demo, recorded at the tip of the moment — pass.
    expect(first.gateResults.find((r: any) => r.gate === "demo-fresh")).toMatchObject({
      status: "pass",
    });
    const recordedAt = first.artifacts.find((a: any) => a.kind === "demo").worktreeHeadSha;

    // Cycle 2: code moved, recording failed — the surviving demo is stale.
    expect(second.artifacts.filter((a: any) => a.kind === "demo")).toEqual([]);
    const stale = second.gateResults.find((r: any) => r.gate === "demo-fresh");
    expect(stale.status).toBe("fail");
    expect(stale.detail.reason).toContain("demo artifact predates the branch tip");
    expect(stale.detail.recordedAtSha).toBe(recordedAt);
    expect(stale.detail.branchTip).not.toBe(recordedAt);
  }, 60_000);

  test("a failed preview boot fails the demo honestly — reason surfaced, no artifact", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") writeUiDemoAssets(ctx.cwd);
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: {
        testCommand: "true",
        previewCommand: `node -e "console.error('kaboom at boot'); process.exit(3)"`,
        previewKind: "ui",
      },
    });

    // Wait out the cap so no cycle is mid-boot while we read the record.
    const arrived = await waitForTicketState(server, ticket.id, "human_review", 40_000);
    expect(arrived.arrivedByCap).toBe(true);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const demoFresh = runs.at(-1).gateResults.find((r: any) => r.gate === "demo-fresh");
    expect(demoFresh.status).toBe("fail");
    expect(demoFresh.detail.reason).toContain("preview boot failed");
    expect(demoFresh.detail.reason).toContain("kaboom at boot");
    expect(runs.at(-1).artifacts.filter((a: any) => a.kind === "demo")).toEqual([]);

    // The failure is inspectable where the wizard looks: record + log tail.
    const view = (await api(server, "GET", `/api/tickets/${ticket.id}/preview`)).json;
    expect(view.record.status).toBe("failed");
    expect(view.logTail).toContain("kaboom at boot");
  }, 40_000);

  test("a missing demo spec fails the demo fast, before the recorder boots its own preview", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    // A well-behaved agent that authors the preview server (so the dogfood
    // phase boots cleanly) but never a demo spec.
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") writeFileSync(path.join(ctx.cwd, "preview-server.mjs"), PREVIEW_SERVER);
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true", previewCommand: "node preview-server.mjs", previewKind: "ui" },
    });

    // The recorder's asset check precedes its own boot: no demo/demo.spec.ts →
    // it fails fast with that reason and records no demo artifact. (The dogfood
    // phase's preview boot is a separate concern — see the dogfood tests.)
    await waitForAudit(server, ticket.id, "gates.failed", 30_000);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs.at(-1).gateResults.find((r: any) => r.gate === "demo-fresh")).toMatchObject({
      status: "fail",
      detail: { reason: "no agent-authored demo at demo/demo.spec.ts" },
    });
    expect(runs.at(-1).artifacts.filter((a: any) => a.kind === "demo")).toEqual([]);
  }, 30_000);
});

describe("demo expectation — the facts both recorder and gate consult", () => {
  const repo = { previewCommand: "npm start", previewKind: "ui" as const };

  test("a non-user-facing ticket type owes no demo", () => {
    for (const type of ["chore", "refactor", "docs", "test", "ci", "build"]) {
      expect(demoExpectation({ branch: `${type}/tidy-up` }, repo)).toEqual({
        owed: false,
        reason: `ticket type "${type}" is not user-facing`,
      });
    }
  });

  test("no preview command or kind → no demo expected", () => {
    expect(demoExpectation({ branch: "feat/x" }, { previewCommand: null, previewKind: null }).owed).toBe(false);
    expect(
      demoExpectation({ branch: "feat/x" }, { previewCommand: "npm start", previewKind: null }).owed,
    ).toBe(false);
  });

  test("a user-facing ticket on a preview-configured repo owes one, by kind", () => {
    expect(demoExpectation({ branch: "feat/x" }, repo)).toEqual({ owed: true, kind: "ui" });
    expect(demoExpectation({ branch: null }, repo)).toEqual({ owed: true, kind: "ui" });
  });
});

describe("the recorder skips by ticket type without touching the preview", () => {
  test("a chore ticket records nothing and never boots", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "tracker-demo-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const db = openDatabase(dataDir);
    cleanups.push(async () => db.close());
    const store = new Store(db, new EventBus());
    const project = store.createProject({ name: "Demo Fixture" });
    const repo = store.createRepo({
      projectId: project.id,
      path: "/nowhere/checkout",
      githubRemote: "git@github.com:barry/demo-fixture.git",
      previewCommand: "node preview-server.mjs",
      previewKind: "ui",
    });
    const created = store.createTicket({
      projectId: project.id,
      title: "Tidy the build",
      acceptanceCriteria: ["It tidies"],
    });
    store.promoteTicket(created.id, { repoId: repo.id, provider: "claude-code" });
    const claim = store.claimNextTicket()!;
    // v1 always claims feat/ branches; forge the row into the chore type the
    // expectation keys on, since no workflow path can mint one yet.
    db.prepare("UPDATE tickets SET branch = 'chore/tidy-the-build' WHERE id = ?").run(created.id);
    const worktree = mkdtempSync(path.join(tmpdir(), "tracker-demo-wt-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    store.recordWorktree(claim.run.id, { worktreePath: worktree, created: true });

    const previews = new PreviewManager(dataDir, store);
    const recorder = new DemoRecorder(dataDir, store, previews, new ArtifactStore(dataDir, store));
    const outcome = await recorder.record({
      run: store.getRun(claim.run.id)!,
      ticket: store.getTicket(created.id)!,
      repo: store.getRepo(repo.id)!,
      worktreePath: worktree,
    });

    expect(outcome).toEqual({
      status: "skipped",
      reason: 'ticket type "chore" is not user-facing',
    });
    expect(store.getPreview(created.id)).toBeUndefined();
    expect(store.listArtifacts(claim.run.id)).toEqual([]);

    // The gate consults the same facts: skip by type, distinct from pass —
    // even though the repo is preview-configured.
    store.finishRun(claim.run.id, "completed");
    await new GateBattery(store, new FakeGitHub()).run({
      run: store.getRun(claim.run.id)!,
      ticket: store.getTicket(created.id)!,
      repo: store.getRepo(repo.id)!,
      worktreePath: worktree,
      demo: outcome,
    });
    expect(
      store.listGateResults(claim.run.id).find((result) => result.gate === "demo-fresh"),
    ).toMatchObject({
      status: "skip",
      detail: { reason: 'ticket type "chore" is not user-facing' },
    });
  });
});
