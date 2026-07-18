import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorktreeManager } from "../src/server/worktrees.ts";
import { commit, git, initScratchRepo } from "./git-helpers.ts";

const trash: string[] = [];
afterEach(async () => {
  while (trash.length > 0) await rm(trash.pop()!, { recursive: true, force: true });
});

function scratchSetup() {
  const source = initScratchRepo("fixture-app");
  const dataDir = mkdtempSync(path.join(tmpdir(), "tracker-data-"));
  trash.push(path.dirname(source), dataDir);
  const manager = new WorktreeManager(dataDir);
  const repo = { path: source, targetBranch: "main" };
  return { source, dataDir, manager, repo };
}

describe("worktree manager", () => {
  test("first claim clones a bare repo and cuts branch + worktree from the target tip", async () => {
    const { source, dataDir, manager, repo } = scratchSetup();
    const tip = commit(source, "app.ts", "export {}\n", "feat: seed");

    const result = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");

    expect(result.created).toBe(true);
    expect(result.worktreePath).toBe(path.join(dataDir, "worktrees", "fixture-app--trk-1"));
    expect(existsSync(path.join(dataDir, "repos", "fixture-app.git"))).toBe(true);
    expect(git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/trk-1-widget",
    );
    expect(git(result.worktreePath, "rev-parse", "HEAD")).toBe(tip);
  });

  test("kb/ and checks/ are git-excluded in the worktree from creation", async () => {
    const { manager, repo } = scratchSetup();
    const { worktreePath } = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");

    mkdirSync(path.join(worktreePath, "kb"));
    mkdirSync(path.join(worktreePath, "checks"));
    writeFileSync(path.join(worktreePath, "kb", "research.md"), "notes\n");
    writeFileSync(path.join(worktreePath, "checks", "ac-1.sh"), "exit 0\n");
    writeFileSync(path.join(worktreePath, "stray.md"), "visible\n");

    // Nothing workflow-generated reaches the PR; ordinary files still do.
    const status = git(worktreePath, "status", "--porcelain");
    expect(status).toContain("stray.md");
    expect(status).not.toContain("kb/");
    expect(status).not.toContain("checks/");
  });

  test("re-claim reuses the worktree as-is: fetch only, no reset, dirty state survives", async () => {
    const { source, manager, repo } = scratchSetup();
    const first = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");
    const headBefore = git(first.worktreePath, "rev-parse", "HEAD");
    writeFileSync(path.join(first.worktreePath, "wip.ts"), "// half-finished\n");

    // Upstream moves on between claims.
    commit(source, "upstream.ts", "export {}\n", "feat: upstream moved");

    const second = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");
    expect(second.created).toBe(false);
    expect(second.worktreePath).toBe(first.worktreePath);
    // No rebase, no reset: the branch head and uncommitted work are untouched.
    expect(git(second.worktreePath, "rev-parse", "HEAD")).toBe(headBefore);
    expect(existsSync(path.join(second.worktreePath, "wip.ts"))).toBe(true);
  });

  test("a second ticket shares the bare clone but gets its own worktree and branch", async () => {
    const { dataDir, manager, repo } = scratchSetup();
    const first = await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");
    const second = await manager.ensureWorktree(repo, "TRK-2", "fix/trk-2-crash");

    expect(second.created).toBe(true);
    expect(second.worktreePath).toBe(path.join(dataDir, "worktrees", "fixture-app--trk-2"));
    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(git(second.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fix/trk-2-crash");
  });

  test("the user's checkout is never touched: no extra worktrees, no tracker branches", async () => {
    const { source, manager, repo } = scratchSetup();
    await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");
    await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");

    const worktrees = git(source, "worktree", "list", "--porcelain");
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    expect(git(source, "for-each-ref", "refs/heads")).not.toContain("feat/trk-1-widget");
  });

  test("claims pick up commits pushed to the user's checkout after registration", async () => {
    const { source, manager, repo } = scratchSetup();
    await manager.ensureWorktree(repo, "TRK-1", "feat/trk-1-widget");
    const newTip = commit(source, "later.ts", "export {}\n", "feat: after registration");

    // A ticket claimed after the tip moved starts from the fresh tip.
    const second = await manager.ensureWorktree(repo, "TRK-2", "feat/trk-2-later");
    expect(git(second.worktreePath, "rev-parse", "HEAD")).toBe(newTip);
  });
});
