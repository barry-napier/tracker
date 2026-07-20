import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TreeState } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The slice of a Repo row the worktree manager needs. */
export interface WorktreeRepo {
  path: string;
  targetBranch: string;
}

export interface WorktreeResult {
  worktreePath: string;
  /** False when a re-claim found the tree already waiting. */
  created: boolean;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * The summary a re-claim inherits, captured whenever a worktree outlives its
 * Run — recorded in the bounce event and Bounce Report (ticket 30) and in the
 * crash event (ticket 41), because nothing ever resets the worktree.
 */
export async function readTreeState(
  worktreePath: string,
  targetBranch: string,
): Promise<TreeState> {
  const branch = await git(worktreePath, "branch", "--show-current");
  const aheadBy = Number(
    await git(worktreePath, "rev-list", "--count", `origin/${targetBranch}..HEAD`),
  );
  const status = await git(worktreePath, "status", "--porcelain");
  return { branch, aheadBy, dirtyCount: status === "" ? 0 : status.split("\n").length };
}

/**
 * Owns the Tracker-side git estate (ticket 08): one bare clone per Repo at
 * `<root>/repos/<name>.git`, one worktree per Ticket at
 * `<root>/worktrees/<name>--<trk-id>`. The user's checkout is only ever a
 * fetch source — no refs are written to it, no worktrees hang off it — with
 * one exception: a local-only Repo's Done merge lands on the checkout's
 * target branch, because for those repos the checkout IS the upstream.
 */
export class WorktreeManager {
  /** Per-repo op chains: concurrent claims must not race the bare clone. */
  #locks = new Map<string, Promise<unknown>>();

  constructor(private readonly rootDir: string) {}

  worktreePath(repo: WorktreeRepo, ticketKey: string): string {
    return path.join(this.rootDir, "worktrees", `${repoName(repo)}--${ticketKey.toLowerCase()}`);
  }

  /**
   * Bring a claim's worktree into existence, or fetch-and-reuse it (re-claims
   * leave the tree exactly as the last run left it — no reset, no rebase).
   */
  async ensureWorktree(
    repo: WorktreeRepo,
    ticketKey: string,
    branch: string,
  ): Promise<WorktreeResult> {
    return this.#chainOnRepoLock(repo, () => this.#ensureWorktree(repo, ticketKey, branch));
  }

  /** Serialize an op onto the repo's chain; a failure never wedges the lock. */
  #chainOnRepoLock<T>(repo: WorktreeRepo, op: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(repoName(repo)) ?? Promise.resolve();
    const task = previous.then(op);
    this.#locks.set(
      repoName(repo),
      task.catch(() => {}),
    );
    return task;
  }

  async #ensureWorktree(
    repo: WorktreeRepo,
    ticketKey: string,
    branch: string,
  ): Promise<WorktreeResult> {
    const bare = await this.ensureBareClone(repo);
    await git(bare, "fetch", "origin");

    const worktreePath = this.worktreePath(repo, ticketKey);
    if (existsSync(worktreePath)) {
      return { worktreePath, created: false };
    }

    // The branch normally doesn't exist yet; after a crash between branch
    // and worktree creation it might, so reuse rather than recreate.
    const branchExists =
      (await git(bare, "for-each-ref", `refs/heads/${branch}`)) !== "";
    if (!branchExists) {
      await git(bare, "branch", branch, `refs/remotes/origin/${repo.targetBranch}`);
    }
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    await git(bare, "worktree", "add", worktreePath, branch);
    return { worktreePath, created: true };
  }

  /**
   * The Done sweep's reap (ticket 42): take the ticket's worktree off disk.
   * Chained on the repo lock so a racing claim can't have git mid-operation
   * under the removal. Returns the removed path, or null when there was
   * nothing on disk. The branch stays in the bare clone — merged history is
   * GitHub's; the reap is disk hygiene, never ref surgery.
   */
  async removeWorktree(repo: WorktreeRepo, ticketKey: string): Promise<string | null> {
    return this.#chainOnRepoLock(repo, () => this.#removeWorktree(repo, ticketKey));
  }

  async #removeWorktree(repo: WorktreeRepo, ticketKey: string): Promise<string | null> {
    const worktreePath = this.worktreePath(repo, ticketKey);
    if (!existsSync(worktreePath)) return null;
    const bare = path.join(this.rootDir, "repos", `${repoName(repo)}.git`);
    try {
      // --force: swept worktrees legitimately carry unignored kb/ leftovers.
      await git(bare, "worktree", "remove", "--force", worktreePath);
    } catch {
      // The bare clone may be gone or confused; the directory still goes,
      // and prune reconciles whatever admin records remain.
      rmSync(worktreePath, { recursive: true, force: true });
      if (existsSync(bare)) await git(bare, "worktree", "prune").catch(() => {});
    }
    return worktreePath;
  }

  /**
   * Startup reconciliation (ticket 42): remove worktree directories no
   * ticket accounts for — DB reset, repo removed. `keep` holds every path a
   * ticket could still claim; everything else under worktrees/ goes.
   * Runs before the pool starts claiming, so no lock is needed.
   */
  async removeOrphanDirs(keep: ReadonlySet<string>): Promise<string[]> {
    const worktreesDir = path.join(this.rootDir, "worktrees");
    if (!existsSync(worktreesDir)) return [];
    const removed: string[] = [];
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(worktreesDir, entry.name);
      if (keep.has(full)) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    }
    // Let every bare clone drop its admin records for the vanished trees.
    const reposDir = path.join(this.rootDir, "repos");
    if (removed.length > 0 && existsSync(reposDir)) {
      for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await git(path.join(reposDir, entry.name), "worktree", "prune").catch(() => {});
      }
    }
    return removed;
  }

  /**
   * A ticket branch's tip as the bare clone knows it — the local-only
   * counterpart of GitHubPort.branchTip. Null when the bare clone doesn't
   * exist yet or the branch was never created.
   */
  async localBranchTip(repo: WorktreeRepo, branch: string): Promise<string | null> {
    const bare = path.join(this.rootDir, "repos", `${repoName(repo)}.git`);
    if (!existsSync(bare)) return null;
    try {
      return await git(bare, "rev-parse", "--verify", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  }

  /**
   * The local-only Done merge (docs/tickets/local-only-projects.md): land the
   * ticket branch on the user checkout's target branch. When the target is
   * checked out, a real merge (conflicts abort cleanly and throw); otherwise
   * only a fast-forward ref update is possible — anything else needs the
   * user's working tree and is refused with instructions, never forced.
   * Chained on the repo lock so a racing claim can't fetch mid-merge.
   */
  async mergeIntoLocalTarget(repo: WorktreeRepo, branch: string): Promise<string> {
    return this.#chainOnRepoLock(repo, async () => {
      const bare = path.join(this.rootDir, "repos", `${repoName(repo)}.git`);
      const tip = await git(bare, "rev-parse", "--verify", `refs/heads/${branch}`);
      const checkedOut = await git(repo.path, "rev-parse", "--abbrev-ref", "HEAD");
      if (checkedOut === repo.targetBranch) {
        // Objects live in the bare clone (worktrees commit there); FETCH_HEAD
        // brings them across before the merge.
        await git(repo.path, "fetch", bare, branch);
        try {
          await git(repo.path, "merge", "--no-ff", "-m", `Merge ${branch}`, tip);
        } catch (error) {
          await git(repo.path, "merge", "--abort").catch(() => {});
          throw new Error(
            `branch ${branch} conflicts with ${repo.targetBranch}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        try {
          await git(repo.path, "fetch", bare, `${branch}:${repo.targetBranch}`);
        } catch {
          throw new Error(
            `${repo.targetBranch} is not checked out in ${repo.path} and cannot fast-forward — check it out (or merge ${branch} yourself) and retry`,
          );
        }
      }
      return tip;
    });
  }

  /**
   * The local-only sweep-safety check: is the ticket branch's tip reachable
   * from the checkout's target branch? False on any doubt — an unverifiable
   * merge must read as unsafe.
   */
  async mergedIntoLocalTarget(repo: WorktreeRepo, branch: string): Promise<boolean> {
    const tip = await this.localBranchTip(repo, branch);
    if (tip === null) return false;
    try {
      await git(repo.path, "merge-base", "--is-ancestor", tip, repo.targetBranch);
      return true;
    } catch {
      return false;
    }
  }

  /** Clone once on first use; every later call is a cheap existence check. */
  private async ensureBareClone(repo: WorktreeRepo): Promise<string> {
    const bare = path.join(this.rootDir, "repos", `${repoName(repo)}.git`);
    if (!existsSync(bare)) {
      mkdirSync(path.dirname(bare), { recursive: true });
      await git(path.dirname(bare), "clone", "--bare", repo.path, bare);
      // A bare clone has no fetch refspec; land upstream tips under
      // refs/remotes/origin/* so fetches never clobber ticket branches.
      await git(bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      excludeWorkflowDirs(bare);
    }
    return bare;
  }
}

function repoName(repo: WorktreeRepo): string {
  return path.basename(repo.path);
}

/**
 * Conventional-commit type + external-ref id (TRK fallback) + title slug,
 * e.g. `feat/gh-231-fix-login-crash`. Tickets carry no type field yet, so
 * every branch is `feat/` for now. Never parsed for identity (ADR-0002).
 */
export function branchNameFor(ticket: {
  displayKey: string;
  externalRef: string | null;
  title: string;
}): string {
  const ref = slugify(ticket.externalRef ?? ticket.displayKey);
  const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, "");
  return `feat/${ref}${slug === "" ? "" : `-${slug}`}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * kb/ and checks/ are workflow-generated and must never reach the PR. The
 * bare repo's info/exclude is shared by every worktree hanging off it, and
 * all of them are ticket worktrees — so one exclusion covers them all.
 */
function excludeWorkflowDirs(bare: string): void {
  const exclude = path.join(bare, "info", "exclude");
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (existing.includes("kb/")) return;
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}kb/\nchecks/\n`);
}
