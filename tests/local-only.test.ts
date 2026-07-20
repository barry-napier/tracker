import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { NullGitHub } from "../src/server/github.ts";
import { WorktreeManager } from "../src/server/worktrees.ts";
import { commit, git, initScratchRepo } from "./git-helpers.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

const trash: string[] = [];
afterEach(async () => {
  while (trash.length > 0) await rm(trash.pop()!, { recursive: true, force: true });
});

function scratchSetup() {
  const source = initScratchRepo("local-app");
  const dataDir = mkdtempSync(path.join(tmpdir(), "tracker-data-"));
  trash.push(path.dirname(source), dataDir);
  const manager = new WorktreeManager(dataDir);
  const repo = { path: source, targetBranch: "main" };
  return { source, manager, repo };
}

describe("local-only merge mechanics (docs/tickets/local-only-projects.md)", () => {
  test("the Done merge lands the ticket branch on the checked-out target", async () => {
    const { source, manager, repo } = scratchSetup();
    commit(source, "app.ts", "export {}\n", "feat: seed");
    const { worktreePath } = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1");
    const tip = commit(worktreePath, "widget.ts", "export const w = 1\n", "feat: widget");

    expect(await manager.mergedIntoLocalTarget(repo, "feat/trk-1")).toBe(false);
    await manager.mergeIntoLocalTarget(repo, "feat/trk-1");

    // The commit is reachable from the checkout's main, and the safety
    // predicate the sweep uses agrees.
    git(source, "merge-base", "--is-ancestor", tip, "main");
    expect(await manager.mergedIntoLocalTarget(repo, "feat/trk-1")).toBe(true);
  });

  test("a conflict aborts cleanly: no half-merge, target untouched", async () => {
    const { source, manager, repo } = scratchSetup();
    commit(source, "app.ts", "export {}\n", "feat: seed");
    const { worktreePath } = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1");
    commit(worktreePath, "app.ts", "export const branch = 1\n", "feat: branch side");
    const mainTip = commit(source, "app.ts", "export const main = 1\n", "feat: main side");

    await expect(manager.mergeIntoLocalTarget(repo, "feat/trk-1")).rejects.toThrow(/conflict/);
    expect(git(source, "rev-parse", "HEAD")).toBe(mainTip);
    expect(git(source, "status", "--porcelain")).toBe("");
  });

  test("an un-checked-out target fast-forwards, and refuses anything else", async () => {
    const { source, manager, repo } = scratchSetup();
    commit(source, "app.ts", "export {}\n", "feat: seed");
    const { worktreePath } = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1");
    const tip = commit(worktreePath, "widget.ts", "export const w = 1\n", "feat: widget");
    git(source, "checkout", "-b", "elsewhere");

    await manager.mergeIntoLocalTarget(repo, "feat/trk-1");
    expect(git(source, "rev-parse", "main")).toBe(tip);

    // A diverged, un-checked-out target can't be merged for the user.
    const { worktreePath: second } = await manager.ensureWorktree(repo, "TRK-2", "feat/trk-2");
    commit(second, "other.ts", "export const o = 1\n", "feat: other");
    git(source, "checkout", "main");
    commit(source, "main-only.ts", "export {}\n", "feat: diverge main");
    git(source, "checkout", "elsewhere");
    await expect(manager.mergeIntoLocalTarget(repo, "feat/trk-2")).rejects.toThrow(
      /not checked out/,
    );
  });
});

describe("the local-only ticket loop, end to end", () => {
  test("gates skip pr-fresh, pass verdict merges locally, sweep reaps", async () => {
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: (ctx) => {
        if (ctx.phase !== "implement") return;
        commit(ctx.cwd, "widget.ts", "export const w = 1\n", "feat: widget");
      },
    });
    const { server, ticket, repo } = await bootWorkspace(provider, {
      github: new NullGitHub(),
      repo: { githubRemote: null, testCommand: "true" },
    });
    expect(repo.githubRemote).toBeNull();

    await waitForTicketState(server, ticket.id, "human_review");

    // pr-fresh is a fact-driven skip — never a NullGitHub-shaped fail — and
    // branch-recorded answers from the shared local refs.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const statuses = Object.fromEntries(
      runs[0].gateResults
        .filter((r: any) => r.acId === null)
        .map((r: any) => [r.gate, r.status]),
    );
    expect(statuses["pr-fresh"]).toBe("skip");
    expect(statuses["branch-recorded"]).toBe("pass");
    const prFresh = runs[0].gateResults.find((r: any) => r.gate === "pr-fresh");
    expect(prFresh.detail).toMatchObject({ reason: "local-only project" });

    // The review payload carries no PR chrome and a locally-resolved tip.
    const review = (await api(server, "GET", `/api/tickets/${ticket.id}/review`)).json;
    expect(review.pr).toBeNull();
    expect(review.branchTip).not.toBeNull();
    expect(review.freshness).toBe("fresh");

    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(verdict.status).toBe(200);
    expect(verdict.json.state).toBe("done");

    // The work is on the user checkout's target branch.
    const log = git(repo.path, "log", "--oneline", "main");
    expect(log).toContain("feat: widget");

    // And the sweep's safety predicate answers from git, not GitHub.
    const sweep = (await api(server, "POST", `/api/projects/${ticket.projectId}/sweep`)).json;
    expect(sweep.reaped.map((r: any) => r.ticketId)).toContain(ticket.id);
  });
});
