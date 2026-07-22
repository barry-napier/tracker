import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** Overwrite the dogfood results file the phase wrote by default (ticket 37). */
function writeResults(cwd: string, results: Record<string, unknown>): void {
  writeFileSync(path.join(cwd, "kb", "dogfood-results.json"), JSON.stringify(results, null, 2));
}

const BASE = { ticket: "TRK-1", frozen_sha: "HEAD", base: "main" };

/** A run where every gate but dogfood-green is green: pushes a PR, suite true. */
function greenExceptDogfood(github: FakeGitHub, onDogfood: (ctx: PhaseCall) => void) {
  const calls: PhaseCall[] = [];
  const provider = scriptedProvider(calls, {
    onPhase: async (ctx) => {
      if (ctx.phase === "dogfood") onDogfood(ctx);
      await pushesToGitHub(github)(ctx);
    },
  });
  return { calls, provider };
}

describe("dogfood-green gate (ticket 37)", () => {
  test("failing scenarios each become one follow-up AC, all riding one bounce (AC1)", async () => {
    const github = new FakeGitHub();
    const { provider } = greenExceptDogfood(github, (ctx) =>
      writeResults(ctx.cwd, {
        ...BASE,
        scenarios: [
          { id: "S1", journey: "export matches the filter", kind: "browser", status: "fail", flow_ref: "AC-1" },
          { id: "S2", journey: "empty state renders", kind: "browser", status: "pending" },
          { id: "S3", journey: "happy path", kind: "browser", status: "pass" },
        ],
      }),
    );
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    // The first bounce is the diagnostic batch: dogfood-green is the one failed
    // gate, and its two un-green rows each minted a follow-up AC.
    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced", 30_000);
    expect(bounced.detail.failed).toEqual(["dogfood-green"]);
    expect(bounced.detail.followUpAcIds).toHaveLength(2);

    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    const followUps = detail.acceptanceCriteria.filter((ac: any) =>
      bounced.detail.followUpAcIds.includes(ac.id),
    );
    expect(followUps.map((ac: any) => ac.origin)).toEqual(["gate-fail", "gate-fail"]);
    const texts = followUps.map((ac: any) => ac.text).sort();
    expect(texts[0]).toContain("Dogfood scenario S1 reaches pass, fixed, or waived (was fail)");
    expect(texts[0]).toContain("export matches the filter");
    expect(texts[1]).toContain("Dogfood scenario S2 reaches pass, fixed, or waived (was pending)");
  }, 30_000);

  test("schema-invalid or scenario-empty results fail artifact-lint (AC2) — now at the phase boundary", async () => {
    const github = new FakeGitHub();
    // Attempt 1 writes an empty scenario list; the in-phase lint (TRK-1)
    // rejects the exit and re-prompts the same session, whose second attempt
    // leaves the default green results. The format defect never costs a
    // bounce cycle — the battery sees only the fixed file.
    const { calls, provider } = greenExceptDogfood(github, (ctx) => {
      if (ctx.attempt === 1) writeResults(ctx.cwd, { ...BASE, scenarios: [] });
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.bounceCount).toBe(0);
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json.at(-1);
    const phaseLints = run.gateResults.filter(
      (r: any) => r.gate === "phase-gate:artifact-lint" && r.detail.phase === "dogfood",
    );
    expect(phaseLints[0]).toMatchObject({ status: "fail" });
    expect(phaseLints[0].detail.problems).toContain("results need at least one scenario");
    expect(phaseLints.at(-1)).toMatchObject({ status: "pass" });

    // The re-prompt resumed the dogfood phase's own live session.
    const dogfoodCalls = calls.filter((call) => call.phase === "dogfood");
    expect(dogfoodCalls).toHaveLength(2);
    expect(dogfoodCalls[1]!.resumeSessionId).toBe("sess-dogfood-1");
    expect(dogfoodCalls[1]!.prompt).toContain("results need at least one scenario");

    // The battery's own artifact-lint judged the fixed file, unchanged.
    expect(run.gateResults.find((r: any) => r.gate === "artifact-lint").status).toBe("pass");
  }, 30_000);

  test("open Decisions for a human never bounce, and an answer lands in the Audit Trail (AC3)", async () => {
    const github = new FakeGitHub();
    // All scenarios green, but the phase parks an open decision. dogfood-green
    // passes; the ticket reaches Human Review on merit, decision and all.
    const { provider } = greenExceptDogfood(github, (ctx) =>
      writeResults(ctx.cwd, {
        ...BASE,
        scenarios: [{ id: "S1", journey: "happy path", kind: "browser", status: "pass" }],
        decisions: [
          {
            id: "D1",
            observed: "The export button reformats dates to US order without warning.",
            options: [
              { label: "Keep US order", cost: "surprises non-US users" },
              { label: "Match the locale", cost: "one more config read per export" },
            ],
            recommendation: "Match the locale.",
          },
        ],
      }),
    );
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.arrivedByCap).toBe(false);
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    expect(run.gateResults.find((r: any) => r.gate === "dogfood-green").status).toBe("pass");

    // The decision rode into the machine-readable results file the wizard reads.
    const resultsArtifact = run.artifacts.find((a: any) => a.name === "dogfood-results.json");
    const results: any = await (
      await fetch(`${server.url}/api/artifacts/${resultsArtifact.id}/content`)
    ).json();
    expect(results.decisions[0].id).toBe("D1");

    // The reviewer answers it — the answer is recorded, no state change.
    const answer = await api(server, "POST", `/api/tickets/${ticket.id}/dogfood-decisions`, {
      decisionId: "D1",
      question: results.decisions[0].observed,
      answer: "Match the locale — ship it.",
    });
    expect(answer.status).toBe(200);
    const answered = await waitForAudit(server, ticket.id, "dogfood.decision_answered");
    expect(answered).toMatchObject({
      actor: "human",
      detail: { decisionId: "D1", answer: "Match the locale — ship it." },
    });
    // Still in Human Review — the decision never gated.
    expect((await api(server, "GET", `/api/tickets/${ticket.id}`)).json.state).toBe("human_review");
  }, 30_000);

  test("a missing decisionId or empty answer is refused (AC3 guard)", async () => {
    const github = new FakeGitHub();
    const { provider } = greenExceptDogfood(github, () => {});
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });
    await waitForTicketState(server, ticket.id, "human_review", 30_000);

    expect((await api(server, "POST", `/api/tickets/${ticket.id}/dogfood-decisions`, {
      decisionId: "D1",
      answer: "  ",
    })).status).toBe(400);
    expect((await api(server, "POST", `/api/tickets/${ticket.id}/dogfood-decisions`, {
      answer: "an answer",
    })).status).toBe(400);
  }, 30_000);

  test("full loop: a red dogfood bounces, the next Run greens it, then Human Review (AC4)", async () => {
    const github = new FakeGitHub();
    // Attempt 1 parks a scenario (red); every later attempt walks it green. The
    // ticket bounces once, the next Run earns dogfood-green, and it arrives on
    // merit — not by bounce cap.
    const { provider } = greenExceptDogfood(github, (ctx) => {
      if (ctx.attempt === 1) {
        writeResults(ctx.cwd, {
          ...BASE,
          scenarios: [{ id: "S1", journey: "the widget works end to end", kind: "browser", status: "fail" }],
        });
      }
      // attempt ≥ 2 leaves the default green results the phase already wrote.
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    // It bounced at least once before arriving...
    await waitForAudit(server, ticket.id, "ticket.bounced", 30_000);
    const arrived = await waitForTicketState(server, ticket.id, "human_review", 30_000);
    expect(arrived.arrivedByCap).toBe(false);
    expect(arrived.bounceCount).toBe(1);

    // ...and the winning Run's dogfood-green is green.
    const latest = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    expect(latest.gateResults.find((r: any) => r.gate === "dogfood-green").status).toBe("pass");
  }, 40_000);
});
