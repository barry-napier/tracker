import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pendingAcIdsFromPrompt,
  pushesToGitHub,
  scriptedProvider,
  waitForSettledRuns,
  waitForTicketState,
  writePlanChecks,
  type PhaseCall,
} from "./workflow-helpers.ts";

// These tests once waited for "verifying" or "todo" — both transient in
// their fixtures. A NullGitHub workspace's battery is doomed (pr-fresh,
// branch-recorded), so "verifying" lasts only until the bounce; a
// plan-failing ticket's "todo" lasts only until the next claim. The
// assertions raced the worker pool and happened to win on one machine's
// timing — CI's first Linux run lost. Green paths now push to a FakeGitHub
// so the battery passes and "human_review" is stable; failure paths wait for
// the pool to stop claiming (MAX_FAILURES settled runs).

afterEach(runCleanups);

describe("the plan phase's extended contract", () => {
  test("plan registers a check per AC — scripts against rows, human routings flagged", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    // Route the first AC to a script and the second to a human.
    const provider = scriptedProvider(calls, {
      planChecks: ({ cwd, prompt }) => {
        const [scripted, humanRouted] = pendingAcIdsFromPrompt(prompt);
        writePlanChecks(cwd, `- [pending] AC-${scripted}: only this one`);
        const manifest = {
          [String(scripted)]: `checks/ac-${scripted}.sh`,
          [String(humanRouted)]: { human: "needs visual judgment" },
        };
        writeFileSync(path.join(cwd, "checks", "manifest.json"), JSON.stringify(manifest));
      },
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, {
      acceptanceCriteria: ["Widget renders", "Widget feels right"],
      github,
    });
    // The human-routed AC skips its gate rather than failing it, so the
    // battery lands all-green and the ticket parks stably in Human Review.
    await waitForTicketState(server, ticket.id, "human_review");

    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    const [first, second] = detail.acceptanceCriteria;
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(first.check).toMatchObject({
      acId: first.id,
      runId: runs[0].id,
      kind: "script",
      scriptPath: `checks/ac-${first.id}.sh`,
      reason: null,
    });
    expect(second.check).toMatchObject({
      acId: second.id,
      kind: "human",
      scriptPath: null,
      reason: "needs visual judgment",
    });

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const registered = audit.find((event: any) => event.type === "checks.registered");
    expect(registered).toMatchObject({
      actor: "agent",
      detail: { runId: runs[0].id, scripts: 1, human: 1 },
    });
  }, 20_000);

  test("a plan that skips the manifest fails the phase, not the contract file", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, { planChecks: () => {} });
    const { server, ticket } = await bootWorkspace(provider);
    // The plan fails identically every cycle; wait for the pool to give up.
    const runs = await waitForSettledRuns(server, ticket.id, 3);

    const latest = runs[0];
    expect(latest.state).toBe("failed");
    const plan = latest.phases.find((p: any) => p.phase === "plan");
    expect(plan.state).toBe("failed");
    expect(plan.failureReason).toContain("checks/manifest.json");

    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria[0].check).toBeNull();
  }, 30_000);

  test("a manifest that misses a pending AC fails the plan phase naming it", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      planChecks: ({ cwd, prompt }) => {
        // Cover only the first AC; leave the second uncovered.
        const [first] = pendingAcIdsFromPrompt(prompt);
        writePlanChecks(cwd, `- [pending] AC-${first}: first only`);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      acceptanceCriteria: ["Widget renders", "Widget persists"],
    });
    // Same doomed plan every cycle; assert once the pool stops claiming.
    const runs = await waitForSettledRuns(server, ticket.id, 3);
    const plan = runs[0].phases.find((p: any) => p.phase === "plan");
    const uncoveredId = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json
      .acceptanceCriteria[1].id;
    expect(plan.state).toBe("failed");
    expect(plan.failureReason).toContain(`AC-${uncoveredId}`);
  }, 30_000);

  test("checks persist in the worktree and re-registration is idempotent", async () => {
    const calls: PhaseCall[] = [];
    const checksSeenAtPlanStart: boolean[] = [];
    const github = new FakeGitHub();
    const provider = scriptedProvider(calls, {
      // First attempt goes hollow at implement so the run fails after plan
      // registered its checks; the re-claim runs the full workflow again.
      sabotage: (phase, attempt) => (phase === "implement" && attempt === 1 ? false : undefined),
      planChecks: (ctx) => {
        checksSeenAtPlanStart.push(existsSync(path.join(ctx.cwd, "checks", "manifest.json")));
        writePlanChecks(ctx.cwd, ctx.prompt);
      },
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, { github });
    await waitForTicketState(server, ticket.id, "human_review", 20_000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0].state).toBe("completed");

    // Attempt 1's checks were still in the worktree when attempt 2 planned.
    expect(checksSeenAtPlanStart).toEqual([false, true]);

    // One registration per AC, updated in place to the winning run.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail.acceptanceCriteria).toHaveLength(1);
    expect(detail.acceptanceCriteria[0].check).toMatchObject({
      kind: "script",
      runId: runs[0].id,
    });
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const registrations = audit.filter((event: any) => event.type === "checks.registered");
    expect(registrations).toHaveLength(2);
  }, 30_000);
});
