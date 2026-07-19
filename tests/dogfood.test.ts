import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DOGFOOD_GUIDE,
  GOVERNOR_FIXES_PER_RUN,
  GOVERNOR_FIXES_PER_SCENARIO,
  MATRIX_SCHEMA,
} from "../src/server/dogfood.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  writeDogfood,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** A preview app that answers a marker — proof the dogfood agent's handed URL
 * points at a live server booted from the ticket's worktree. */
const PREVIEW_SERVER = `
import { createServer } from "node:http";
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ marker: "dogfood-live", port: process.env.PORT }));
}).listen(process.env.PORT, "127.0.0.1");
`;

/** Pull the base URL the engine handed the dogfood agent out of its prompt. */
function previewBaseUrl(prompt: string): string | null {
  const match = /available at: (\S+)/.exec(prompt);
  return match ? match[1]! : null;
}

describe("the dogfood phase (ticket 36)", () => {
  test("boots the preview and hands the live URL + vendored playbook + persona to the agent", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    let servedFromPreview: unknown;
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") {
          writeFileSync(path.join(ctx.cwd, "preview-server.mjs"), PREVIEW_SERVER);
          writeFileSync(path.join(ctx.cwd, "persona.md"), "# The impatient user\nI never read twice.");
          // An api demo so the run passes cleanly in one cycle (no playwright).
          mkdirSync(path.join(ctx.cwd, "demo"), { recursive: true });
          writeFileSync(path.join(ctx.cwd, "demo", "demo.sh"), '#!/bin/sh\ncurl -sS "$BASE_URL/"\n', {
            mode: 0o755,
          });
        }
        // The dogfood agent fetches the URL it was handed — proof the phase
        // booted a live preview and injected its address (AC1).
        if (ctx.phase === "dogfood") {
          const url = previewBaseUrl(ctx.prompt);
          if (url?.startsWith("http")) servedFromPreview = await (await fetch(url)).json();
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: {
        testCommand: "true",
        previewCommand: "node preview-server.mjs",
        previewKind: "api",
        personaPath: "persona.md",
      },
    });

    // Gates all green — the ticket arrives at Human Review on merit.
    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.arrivedByCap).toBe(false);
    const dogfood = calls.find((c) => c.phase === "dogfood")!;

    // The live preview really answered the URL the agent was handed (AC1).
    expect(servedFromPreview).toMatchObject({ marker: "dogfood-live" });
    expect(previewBaseUrl(dogfood.prompt)).toMatch(/^http:\/\/localhost:\d+$/);

    // The vendored playbook, results schema, and persona all rode in through
    // the standard template variable set (AC1, AC4).
    expect(dogfood.prompt).toContain(DOGFOOD_GUIDE.slice(0, 60));
    expect(dogfood.prompt).toContain("Dogfood verification results");
    expect(dogfood.prompt).toContain("The impatient user");

    // The governor caps are prompt-enforced (AC3).
    expect(dogfood.prompt).toContain(`${GOVERNOR_FIXES_PER_SCENARIO} fix attempts per scenario`);
    expect(dogfood.prompt).toContain(`${GOVERNOR_FIXES_PER_RUN} fix commits per run`);

    // The preview it booted is taken back down once the phase ends.
    const view = (await api(server, "GET", `/api/tickets/${ticket.id}/preview`)).json;
    expect(view.record.status).toBe("stopped");
  }, 30_000);

  test("report and results land as Run artifacts, results conforming to the schema (AC2)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, { onPhase: pushesToGitHub(github) });
    const { server, ticket } = await bootWorkspace(provider, { github, repo: { testCommand: "true" } });

    await waitForTicketState(server, ticket.id, "human_review", 30_000);
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];

    const report = run.artifacts.find((a: any) => a.name === "dogfood-report.md");
    const resultsArtifact = run.artifacts.find((a: any) => a.name === "dogfood-results.json");
    expect(report).toBeDefined();
    expect(resultsArtifact).toBeDefined();

    const results: any = await (
      await fetch(`${server.url}/api/artifacts/${resultsArtifact.id}/content`)
    ).json();
    // Conforms to the vendored matrix schema: required top-level keys, and at
    // least one scenario carrying the required scenario keys.
    for (const key of MATRIX_SCHEMA.required) expect(results).toHaveProperty(key);
    expect(results.scenarios.length).toBeGreaterThanOrEqual(1);
    for (const key of MATRIX_SCHEMA.properties.scenarios.items.required) {
      expect(results.scenarios[0]).toHaveProperty(key);
    }
    expect(results.scenarios[0].id).toMatch(/^S[0-9]+$/);
  }, 30_000);

  test("no persona configured → the prompt tells the agent to skip the experiential judge (AC4)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, { onPhase: pushesToGitHub(github) });
    // Default repo: no personaPath, no preview command.
    const { server, ticket } = await bootWorkspace(provider, { github, repo: { testCommand: "true" } });

    await waitForTicketState(server, ticket.id, "human_review", 30_000);
    const dogfood = calls.find((c) => c.phase === "dogfood")!;
    expect(dogfood.prompt).toContain("No persona configured for this repo");
    // No preview configured is stated honestly too, never faked.
    expect(dogfood.prompt).toContain("available at: unavailable");
    expect(dogfood.prompt).toContain("no preview configured for this repo");
  }, 30_000);

  test("an honest red dogfood report still completes the phase and persists both artifacts (AC5)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    // The agent walks a scenario that fails and parks it. No dogfood-green gate
    // exists yet (slice 37), so the run proceeds; the point is that a red
    // report is not a hollow phase — the contract + both artifacts exist.
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "dogfood") writeDogfood(ctx.cwd, { status: "fail" });
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, { github, repo: { testCommand: "true" } });

    await waitForTicketState(server, ticket.id, "human_review", 30_000);
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    const dogfoodPhase = run.phases.find((p: any) => p.phase === "dogfood");
    expect(dogfoodPhase.state).toBe("completed");

    const resultsArtifact = run.artifacts.find((a: any) => a.name === "dogfood-results.json");
    const results: any = await (
      await fetch(`${server.url}/api/artifacts/${resultsArtifact.id}/content`)
    ).json();
    expect(results.scenarios[0].status).toBe("fail");
    expect(run.artifacts.some((a: any) => a.name === "dogfood-report.md")).toBe(true);
  }, 30_000);
});
