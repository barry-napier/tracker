import { describe, expect, test, afterEach } from "vitest";
import { repoSlug } from "../src/server/github.ts";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, runCleanups, FIXTURE_REMOTE } from "./server-helpers.ts";
import {
  bootWorkspace,
  pendingAcIdsFromPrompt,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

afterEach(runCleanups);

describe("repoSlug", () => {
  test("derives owner/repo from every remote spelling the repos table sees", () => {
    expect(repoSlug("git@github.com:barry/fixture-app.git")).toBe("barry/fixture-app");
    expect(repoSlug("https://github.com/barry/fixture-app.git")).toBe("barry/fixture-app");
    expect(repoSlug("https://github.com/barry/fixture-app")).toBe("barry/fixture-app");
    expect(repoSlug("barry/fixture-app")).toBe("barry/fixture-app");
  });

  test("refuses a remote it cannot place, loudly", () => {
    expect(() => repoSlug("git@gitlab.com:barry/app.git")).toThrow(/cannot derive/);
    expect(() => repoSlug("not a remote")).toThrow(/cannot derive/);
  });
});

describe("GitHub for real (ticket 31)", () => {
  test("a run's PR lands on the Ticket, and a pass verdict merges it for real", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") {
          writeFileSync(path.join(ctx.cwd, "widget.txt"), "the widget\n");
          git(ctx.cwd, "add", "widget.txt");
          git(ctx.cwd, "commit", "-m", "add widget");
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket, repo } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    await waitForTicketState(server, ticket.id, "human_review");

    // The orchestrator observed the PR on the remote and recorded it on the
    // Ticket — number and URL, never self-reported by the agent.
    const reviewed = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(reviewed.prNumber).toBe(1);
    expect(reviewed.prUrl).toBe("https://github.test/pr/1");
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const recorded = audit.filter((event: any) => event.type === "pr.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].detail).toMatchObject({
      prNumber: 1,
      prUrl: "https://github.test/pr/1",
      branch: reviewed.branch,
    });

    // Only pass exists until the review wizard lands; anything else is refused.
    const failVerdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
    });
    expect(failVerdict.status).toBe(400);

    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(verdict.status).toBe(200);
    expect(verdict.json).toMatchObject({ state: "done", prNumber: 1 });

    // Done went through the port: the remote's target branch really moved,
    // squash-shaped — one single-parent commit, gh's default subject.
    expect(git(repo.path, "show", "main:widget.txt")).toBe("the widget");
    expect(git(repo.path, "log", "-1", "--format=%s", "main")).toBe(
      `Ship it: ${reviewed.branch} (#1)`,
    );
    expect(git(repo.path, "log", "-1", "--format=%P", "main")).not.toContain(" ");
    expect(await github.findPr(FIXTURE_REMOTE, reviewed.branch)).toBeNull();

    // Verdict and merge are both on the audit trail, actor human.
    const after = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(after.find((event: any) => event.type === "verdict.recorded")).toMatchObject({
      actor: "human",
      detail: { outcome: "pass", prNumber: 1 },
    });
    expect(after.find((event: any) => event.type === "ticket.merged")).toMatchObject({
      actor: "human",
      detail: { prNumber: 1, prUrl: "https://github.test/pr/1", branch: reviewed.branch },
    });

    // A merged ticket is done with verdicts: the second pass has no PR to
    // merge and no Human Review state to leave.
    const again = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(again.status).toBe(409);
  }, 20_000);

  test("merge is guarded: unsettled ACs block, conflicts block, a waive unblocks", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      // Every AC routed to a human: the battery skips them, so the ticket
      // reaches Human Review with its criterion still pending.
      planChecks: (ctx) => {
        mkdirSync(path.join(ctx.cwd, "checks"), { recursive: true });
        const acIds = pendingAcIdsFromPrompt(ctx.prompt);
        writeFileSync(
          path.join(ctx.cwd, "checks", "manifest.json"),
          JSON.stringify(Object.fromEntries(acIds.map((id) => [id, { human: "needs eyes" }]))),
        );
      },
      onPhase: async (ctx) => {
        // Real work on the branch — GitHub refuses a PR with no commits.
        if (ctx.phase === "implement") {
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
    const acId = ticket.acceptanceCriteria[0].id;

    // Done requires every AC verified or waived — a pending one blocks.
    const blocked = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain(`AC-${acId} (pending)`);

    await api(server, "POST", `/api/acs/${acId}/waive`, { reason: "verified by hand off-line" });

    // Conflicts block the merge before the port is asked to perform it.
    const { prNumber } = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    github.setMergeability(prNumber, "conflicting");
    const conflicted = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(conflicted.status).toBe(409);
    expect(conflicted.json.error).toContain("conflicts");

    github.setMergeability(prNumber, "mergeable");
    const merged = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(merged.status).toBe(200);
    expect(merged.json.state).toBe("done");
  }, 20_000);

  test("the verdict action refuses tickets that never reached Human Review", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Still in backlog",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const wrongState = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(wrongState.status).toBe(409);
    expect(wrongState.json.error).toContain("backlog");

    const missing = await api(server, "POST", "/api/tickets/999/verdict", { outcome: "pass" });
    expect(missing.status).toBe(404);

    const badOutcome = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {});
    expect(badOutcome.status).toBe(400);
  });
});
