import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DOGFOOD_GUIDE,
  evaluateDogfoodGreen,
  GOVERNOR_FIXES_PER_RUN,
  GOVERNOR_FIXES_PER_SCENARIO,
  lintDogfoodResults,
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
    // The agent walks a scenario that fails and parks it. The dogfood-green gate
    // (slice 37) now bounces such a run, so the ticket lands at Human Review by
    // bounce cap — but the point stands: a red report is not a hollow phase, the
    // contract + both artifacts exist on every attempt.
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "dogfood") writeDogfood(ctx.cwd, { status: "fail" });
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, { github, repo: { testCommand: "true" } });

    const parked = await waitForTicketState(server, ticket.id, "human_review", 40_000);
    expect(parked.arrivedByCap).toBe(true);
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    const dogfoodPhase = run.phases.find((p: any) => p.phase === "dogfood");
    expect(dogfoodPhase.state).toBe("completed");

    const resultsArtifact = run.artifacts.find((a: any) => a.name === "dogfood-results.json");
    const results: any = await (
      await fetch(`${server.url}/api/artifacts/${resultsArtifact.id}/content`)
    ).json();
    expect(results.scenarios[0].status).toBe("fail");
    expect(run.artifacts.some((a: any) => a.name === "dogfood-report.md")).toBe(true);
  }, 40_000);
});

/** A schema-conforming results object; override to probe a single failure. */
function results(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ticket: "TRK-1",
    frozen_sha: "abc123",
    base: "main",
    scenarios: [{ id: "S1", journey: "Use the widget past its endpoint", kind: "browser", status: "pass" }],
    ...overrides,
  });
}

describe("lintDogfoodResults (ticket 37, AC2)", () => {
  test("a schema-conforming file with one scenario is clean", () => {
    expect(lintDogfoodResults(results())).toEqual([]);
  });

  test("non-JSON fails with the parse reason", () => {
    expect(lintDogfoodResults("{not json")[0]).toMatch(/not valid JSON/);
  });

  test("an empty scenario list fails — at least one is required", () => {
    expect(lintDogfoodResults(results({ scenarios: [] }))).toEqual([
      "results need at least one scenario",
    ]);
  });

  test("missing top-level keys are each named", () => {
    const problems = lintDogfoodResults(JSON.stringify({ scenarios: [] }));
    expect(problems).toContain('results missing required string "ticket"');
    expect(problems).toContain('results missing required string "frozen_sha"');
    expect(problems).toContain('results missing required string "base"');
  });

  test("a malformed scenario (bad id, kind, status) is caught field by field", () => {
    const problems = lintDogfoodResults(
      results({ scenarios: [{ id: "1", journey: "", kind: "cli", status: "green" }] }),
    );
    expect(problems).toEqual([
      'scenario 1 needs an id like "S1"',
      "scenario 1 needs a journey",
      "scenario 1 kind must be one of browser, http",
      "scenario 1 status must be one of pending, pass, fail, fixed, parked, waived",
    ]);
  });

  test("more than 12 scenarios trips the matrix cap", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `S${i + 1}`,
      journey: "j",
      kind: "http",
      status: "pass",
    }));
    expect(lintDogfoodResults(results({ scenarios: many }))).toContain(
      "results carry 13 scenarios — the matrix cap is 12",
    );
  });
});

describe("evaluateDogfoodGreen (ticket 37, AC1)", () => {
  test("all scenarios pass/fixed/waived → green, nothing failing", () => {
    const evaluation = evaluateDogfoodGreen(
      results({
        scenarios: [
          { id: "S1", journey: "a", kind: "browser", status: "pass" },
          { id: "S2", journey: "b", kind: "http", status: "fixed" },
          { id: "S3", journey: "c", kind: "browser", status: "waived" },
        ],
      }),
    );
    expect(evaluation).toMatchObject({ ok: true, failing: [], total: 3 });
  });

  test("pending, fail, and parked rows are each failing, carrying id/status/flow_ref", () => {
    const evaluation = evaluateDogfoodGreen(
      results({
        scenarios: [
          { id: "S1", journey: "happy", kind: "browser", status: "pass" },
          { id: "S2", journey: "broken export", kind: "browser", status: "fail", flow_ref: "AC-2" },
          { id: "S3", journey: "untested", kind: "http", status: "pending" },
          { id: "S4", journey: "parked", kind: "http", status: "parked" },
        ],
      }),
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.total).toBe(4);
    expect(evaluation.failing).toEqual([
      { id: "S2", journey: "broken export", status: "fail", flowRef: "AC-2" },
      { id: "S3", journey: "untested", status: "pending", flowRef: null },
      { id: "S4", journey: "parked", status: "parked", flowRef: null },
    ]);
  });

  test("an unreadable or empty file is an honest fail, never a silent green", () => {
    expect(evaluateDogfoodGreen("{oops").ok).toBe(false);
    expect(evaluateDogfoodGreen(results({ scenarios: [] }))).toMatchObject({
      ok: false,
      error: "results carry no scenarios to green",
    });
  });
});
