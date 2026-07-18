import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  scriptedProvider,
  waitForTicketState,
  writePlanChecks,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

describe("the plan phase's extended contract", () => {
  test("plan registers a check per AC — scripts against rows, human routings flagged", async () => {
    const calls: PhaseCall[] = [];
    // Route the first AC to a script and the second to a human.
    const provider = scriptedProvider(calls, undefined, ({ cwd, prompt }) => {
      const acIds = [...prompt.matchAll(/\[pending\] AC-(\d+):/g)].map((m) => Number(m[1]));
      const [scripted, humanRouted] = acIds;
      writePlanChecks(cwd, `- [pending] AC-${scripted}: only this one`);
      const manifest = {
        [String(scripted)]: `checks/ac-${scripted}.sh`,
        [String(humanRouted)]: { human: "needs visual judgment" },
      };
      writeFileSync(path.join(cwd, "checks", "manifest.json"), JSON.stringify(manifest));
    });
    const { server, ticket } = await bootWorkspace(provider, {
      acceptanceCriteria: ["Widget renders", "Widget feels right"],
    });
    await waitForTicketState(server, ticket.id, "verifying");

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
    const provider = scriptedProvider(calls, undefined, () => {});
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "todo", 20_000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
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
    const provider = scriptedProvider(calls, undefined, ({ cwd, prompt }) => {
      // Cover only the first AC; leave the second uncovered.
      const acIds = [...prompt.matchAll(/\[pending\] AC-(\d+):/g)].map((m) => Number(m[1]));
      writePlanChecks(cwd, `- [pending] AC-${acIds[0]}: first only`);
    });
    const { server, ticket } = await bootWorkspace(provider, {
      acceptanceCriteria: ["Widget renders", "Widget persists"],
    });
    await waitForTicketState(server, ticket.id, "todo", 20_000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const plan = runs[0].phases.find((p: any) => p.phase === "plan");
    const uncoveredId = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json
      .acceptanceCriteria[1].id;
    expect(plan.state).toBe("failed");
    expect(plan.failureReason).toContain(`AC-${uncoveredId}`);
  }, 30_000);

  test("checks persist in the worktree and re-registration is idempotent", async () => {
    const calls: PhaseCall[] = [];
    const checksSeenAtPlanStart: boolean[] = [];
    const provider = scriptedProvider(
      calls,
      // First attempt goes hollow at implement so the run fails after plan
      // registered its checks; the re-claim runs the full workflow again.
      (phase, attempt) => (phase === "implement" && attempt === 1 ? false : undefined),
      (ctx) => {
        checksSeenAtPlanStart.push(existsSync(path.join(ctx.cwd, "checks", "manifest.json")));
        writePlanChecks(ctx.cwd, ctx.prompt);
      },
    );
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "verifying", 20_000);

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
