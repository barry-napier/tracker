import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
 * fetch source — no refs are written to it, no worktrees hang off it.
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
    const previous = this.#locks.get(repoName(repo)) ?? Promise.resolve();
    const task = previous.then(() => this.#ensureWorktree(repo, ticketKey, branch));
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
