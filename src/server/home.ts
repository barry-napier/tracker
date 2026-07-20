import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { repoSlug } from "./github.ts";
import { StateError, ValidationError, type Store } from "./store.ts";
import { git } from "./worktrees.ts";
import type { Project, Repo } from "./types.ts";

export type AddLocalOutcome =
  | { alreadyTracked: true; project: Project }
  | { alreadyTracked: false; project: Project; repo: Repo };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Home's add-project half: the user picks a repo they already have on disk,
 * and Tracker registers it as a Project + Repo. Everything derivable is
 * derived (name from the folder, remote and target branch from git); run
 * config stays empty until a human fills it in on the board. Domain errors
 * are the store's own classes — app.onError does the status mapping.
 */
export class Home {
  constructor(private readonly store: Store) {}

  async addLocal(input: { path?: unknown }): Promise<AddLocalOutcome> {
    if (!isNonEmptyString(input.path)) throw new ValidationError("path is required");
    const picked = path.resolve(input.path);
    if (!existsSync(picked) || !statSync(picked).isDirectory()) {
      throw new ValidationError(`directory does not exist: ${picked}`);
    }

    // Normalize to the checkout root, so picking a subfolder still lands on
    // the repo — and anything git won't own is refused up front.
    let repoPath: string;
    try {
      repoPath = await git(picked, "rev-parse", "--show-toplevel");
    } catch {
      throw new ValidationError(`not a git repository: ${picked}`);
    }

    const tracked =
      this.trackedByPath(repoPath) ?? (await this.trackedByRemote(repoPath));
    if (tracked !== null) {
      let project = this.store.getProject(tracked);
      if (project) {
        // Re-adding the checkout is the recovery path for both archive
        // (ticket 50) and soft delete: resurrect instead of ghosting or
        // duplicating.
        if (project.deletedAt !== null) project = this.store.undeleteProject(project.id);
        if (project.hiddenAt !== null) project = this.store.unhideProject(project.id);
        return { alreadyTracked: true, project };
      }
    }

    // No origin remote → a local-only Project (docs/tickets/local-only-
    // projects.md): gates skip their PR half and Done merges into the local
    // target branch. The null remote IS the mode.
    let remote: string | null;
    try {
      remote = await git(repoPath, "remote", "get-url", "origin");
    } catch {
      remote = null;
    }

    const name = path.basename(repoPath);
    const project = this.store.createProject({ name, ticketPrefix: derivePrefix(name) });
    const repo = this.store.createRepo({
      projectId: project.id,
      path: repoPath,
      githubRemote: remote,
      targetBranch: await defaultBranch(repoPath),
    });
    return { alreadyTracked: false, project, repo };
  }

  /**
   * The exact checkout is already a Repo row — reopen its Project. Compared
   * by realpath: `--show-toplevel` answers physically, rows may be symlinked.
   */
  private trackedByPath(repoPath: string): number | null {
    for (const repo of this.store.listRepos()) {
      try {
        if (realpathSync(repo.path) === repoPath) return repo.projectId;
      } catch {
        // A row whose checkout vanished from disk can't be the picked one.
      }
    }
    return null;
  }

  /**
   * One remote = one Project: a second checkout of an already-tracked remote
   * reopens the existing Project rather than forking its board. Slugs are
   * GitHub's, so the compare is case-insensitive.
   */
  private async trackedByRemote(repoPath: string): Promise<number | null> {
    let slug: string;
    try {
      slug = repoSlug(await git(repoPath, "remote", "get-url", "origin")).toLowerCase();
    } catch {
      return null; // No/unparseable remote — dedupe by path already ran.
    }
    for (const repo of this.store.listRepos()) {
      if (repo.githubRemote === null) continue; // local-only rows dedupe by path alone
      try {
        if (repoSlug(repo.githubRemote).toLowerCase() === slug) return repo.projectId;
      } catch {
        // A remote that repoSlug can't parse can't be the one we're looking for.
      }
    }
    return null;
  }
}

/**
 * Native folder chooser for renderers without the Electron preload (vite dev
 * in a browser). The server runs on the user's machine, so it can own the
 * dialog itself: AppleScript's `choose folder` needs no permissions. Null
 * means the user cancelled — the only "error" a chooser should surface.
 */
export async function pickFolderNative(): Promise<string | null> {
  try {
    // No `tell me to activate`: activating a windowless process costs ~2s of
    // macOS activation dance, and the panel floats at modal level (above all
    // normal windows) without it — it just doesn't take keyboard focus until
    // first clicked.
    const { stdout } = await promisify(execFile)("osascript", [
      "-e", 'POSIX path of (choose folder with prompt "Open a repository")',
    ]);
    return stdout.trim().replace(/\/$/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateError("no native folder picker available on this host");
    }
    return null; // dismissed, killed, escaped — all read as "user cancelled"
  }
}

/**
 * Open a project's checkout in the OS file manager (ticket 50). Server-side
 * for the same reason as the folder picker: the server runs on the user's
 * machine, and the browser-dev renderer has no shell access. macOS `open`,
 * matching pickFolderNative's platform posture.
 */
export async function revealInFinder(repoPath: string): Promise<void> {
  try {
    await promisify(execFile)("open", [repoPath]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateError("no file manager available on this host");
    }
    throw error;
  }
}

/**
 * The branch PRs should land on: origin's HEAD when the clone recorded it,
 * else whatever is checked out — a human can correct it on the board.
 */
async function defaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await git(repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return ref.replace(/^origin\//, "");
  } catch {
    return git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  }
}

/** "widget-press" → "WID": a readable per-project ticket key, not uniqueness. */
function derivePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.slice(0, 3) || "TRK";
}
