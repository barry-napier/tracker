import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { lintRecap } from "../src/server/gates.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";
import {
  bootWorkspace,
  pendingAcIdsFromPrompt,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  writePlanChecks,
  writeRecap,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

function gateStatuses(run: any): Record<string, string> {
  return Object.fromEntries(
    run.gateResults
      .filter((result: any) => result.acId === null)
      .map((result: any) => [result.gate, result.status]),
  );
}

describe("the gate battery at Verifying", () => {
  test("a fully evidenced run passes every gate and lands in Human Review", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, { onPhase: pushesToGitHub(github) });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(gateStatuses(runs[0])).toEqual({
      artifact: "pass",
      "artifact-lint": "pass",
      // The dogfood phase greened its one scenario (ticket 37).
      "dogfood-green": "pass",
      "branch-recorded": "pass",
      suite: "pass",
      "pr-fresh": "pass",
      // No preview configured → no demo owed. Skip, distinct from pass.
      "demo-fresh": "skip",
    });
    const suite = runs[0].gateResults.find((r: any) => r.gate === "suite");
    expect(suite.detail).toMatchObject({ command: "true", exitCode: 0 });

    // The orchestrator ran the agent-authored check; exit 0 verified the AC
    // with machine provenance — nothing here was self-reported.
    const acId = ticket.acceptanceCriteria[0].id;
    const acCheck = runs[0].gateResults.find((r: any) => r.acId === acId);
    expect(acCheck).toMatchObject({
      gate: "ac-check",
      status: "pass",
      detail: { scriptPath: `checks/ac-${acId}.sh`, exitCode: 0 },
    });
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria[0]).toMatchObject({
      status: "verified",
      provenance: "machine",
    });

    const passedAudit = await waitForAudit(server, ticket.id, "gates.passed");
    expect(passedAudit.detail).toMatchObject({ runId: runs[0].id });

    // Every result streamed over SSE as it landed.
    const streamed = await client.waitFor("gate.result", 8);
    expect(streamed.map((m) => m.data.gate)).toEqual([
      "artifact",
      "artifact-lint",
      "dogfood-green",
      "branch-recorded",
      "suite",
      "pr-fresh",
      "demo-fresh",
      "ac-check",
    ]);
    expect(streamed.every((m) => m.data.ticketId === ticket.id)).toBe(true);
  }, 20_000);

  test("the battery is diagnostic: everything runs even after failures, and the batch is one event", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      // The agent's check doesn't hold up: non-zero exit fails the AC.
      planChecks: (ctx) => writePlanChecks(ctx.cwd, ctx.prompt, () => "#!/bin/sh\nexit 3\n"),
      onPhase: (ctx) => {
        if (ctx.phase !== "document") return;
        writeRecap(ctx.cwd, '<script src="https://cdn.example.com/x.js"></script><h1>Recap</h1>');
      },
    });
    // No GitHubPort backing (nothing pushed), no test command (suite skips),
    // a preview configured (a demo IS owed — and none exists). Nothing here
    // ever converges, so the ticket bounces its way to the park-by-cap
    // terminal state; this test reads the FIRST run's diagnostic batch.
    const { server, ticket } = await bootWorkspace(provider, {
      repo: { previewCommand: "npm start", previewKind: "ui" },
    });

    await waitForTicketState(server, ticket.id, "human_review", 30_000);
    const failedAudit = await waitForAudit(server, ticket.id, "gates.failed");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const firstRun = runs.at(-1);
    expect(gateStatuses(firstRun)).toEqual({
      artifact: "pass",
      "artifact-lint": "fail",
      // The default dogfood fixture greens its scenario — the recap is what fails here.
      "dogfood-green": "pass",
      "branch-recorded": "fail",
      suite: "skip",
      "pr-fresh": "fail",
      "demo-fresh": "fail",
    });
    const lint = firstRun.gateResults.find((r: any) => r.gate === "artifact-lint");
    expect(lint.detail.problems).toEqual([
      "recap references external resources — it must be fully self-contained",
      'recap has no "What to review" section',
    ]);
    const suite = firstRun.gateResults.find((r: any) => r.gate === "suite");
    expect(suite.detail).toEqual({ reason: "no test command configured" });

    const acId = ticket.acceptanceCriteria[0].id;
    const acCheck = firstRun.gateResults.find((r: any) => r.acId === acId);
    expect(acCheck).toMatchObject({ status: "fail", detail: { exitCode: 3 } });
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria[0]).toMatchObject({
      status: "failed",
      provenance: "machine",
    });

    // One diagnostic batch: every failure named in run 1's single event.
    expect(failedAudit.detail).toMatchObject({ runId: firstRun.id });
    expect(failedAudit.detail.failed).toEqual([
      "artifact-lint",
      "branch-recorded",
      "pr-fresh",
      "demo-fresh",
      `ac-check:AC-${acId}`,
    ]);
  }, 40_000);

  test("a waived AC keeps its waive and its check is skipped, never run", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, { onPhase: pushesToGitHub(github) });
    const dataDir = undefined;
    const server = await bootServer(dataDir, {
      workers: 3,
      providers: { "claude-code": provider },
      github,
    });
    const { project, repo } = await seedWorkspace(server, { testCommand: "true" });
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Ship the widget",
        acceptanceCriteria: ["Widget renders", "Widget wins design awards"],
      })
    ).json;

    // Waiving is legal in any state — retire the aspirational AC in Backlog,
    // before it can burn a bounce cycle.
    const aspirational = ticket.acceptanceCriteria[1];
    const waived = await api(server, "POST", `/api/acs/${aspirational.id}/waive`, {
      reason: "awards are not a launch criterion",
    });
    expect(waived.status).toBe(200);
    expect(waived.json).toMatchObject({
      status: "waived",
      provenance: "human",
      waiveReason: "awards are not a launch criterion",
    });

    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const checkResults = runs[0].gateResults.filter((r: any) => r.gate === "ac-check");
    expect(checkResults).toHaveLength(2);
    expect(checkResults.find((r: any) => r.acId === ticket.acceptanceCriteria[0].id)).toMatchObject(
      { status: "pass" },
    );
    expect(checkResults.find((r: any) => r.acId === aspirational.id)).toMatchObject({
      status: "skip",
      detail: { reason: "waived" },
    });

    // The waive survived the battery untouched, and the audit trail knows
    // a human did it.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria[1]).toMatchObject({
      status: "waived",
      waiveReason: "awards are not a launch criterion",
    });
    const waivedAudit = await waitForAudit(server, ticket.id, "ac.waived");
    expect(waivedAudit).toMatchObject({
      actor: "human",
      detail: { acId: aspirational.id, reason: "awards are not a launch criterion" },
    });
  }, 20_000);

  test("a human-routed check is n/a for the battery — it belongs to the walkthrough", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      planChecks: (ctx) => {
        mkdirSync(path.join(ctx.cwd, "checks"), { recursive: true });
        const acIds = pendingAcIdsFromPrompt(ctx.prompt);
        writeFileSync(
          path.join(ctx.cwd, "checks", "manifest.json"),
          JSON.stringify(Object.fromEntries(acIds.map((id) => [id, { human: "needs eyes" }]))),
        );
      },
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const acId = ticket.acceptanceCriteria[0].id;
    expect(runs[0].gateResults.find((r: any) => r.acId === acId)).toMatchObject({
      status: "skip",
      detail: { reason: "routed to human: needs eyes" },
    });
    // Unrun means unsettled: the criterion is still pending for the wizard.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria[0]).toMatchObject({ status: "pending", provenance: null });
  }, 20_000);

  test("waiving demands a reason and a real criterion", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "T",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const noReason = await api(server, "POST", `/api/acs/${ticket.acceptanceCriteria[0].id}/waive`, {
      reason: "  ",
    });
    expect(noReason.status).toBe(400);
    const missing = await api(server, "POST", "/api/acs/999/waive", { reason: "why not" });
    expect(missing.status).toBe(404);
  });
});

describe("lintRecap", () => {
  test("a self-contained recap with review notes passes", () => {
    expect(lintRecap("<style>body{}</style><h2>What to review</h2>")).toEqual([]);
  });

  test("external resources hard-fail, wherever they hide", () => {
    for (const html of [
      '<script src="https://cdn.example.com/x.js"></script><p>What to review</p>',
      '<img src="//example.com/pic.png"><p>What to review</p>',
      '<link rel="stylesheet" href="https://example.com/a.css"><p>What to review</p>',
      "<style>body { background: url('https://example.com/bg.png') }</style><p>What to review</p>",
      "<style>@import url(theme.css)</style><p>What to review</p>",
    ]) {
      expect(lintRecap(html)).toEqual([
        "recap references external resources — it must be fully self-contained",
      ]);
    }
  });

  test("inline scripts and local data URIs are fine", () => {
    expect(
      lintRecap('<script>render()</script><img src="data:image/png;base64,AA"><p>What to review</p>'),
    ).toEqual([]);
  });

  test("a recap without review notes hard-fails", () => {
    expect(lintRecap("<h1>Recap</h1>")).toEqual(['recap has no "What to review" section']);
  });
});
