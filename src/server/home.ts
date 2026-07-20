import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
    // the repo. A folder git doesn't own is NOT refused: it registers as-is
    // (realpath'd, matching --show-toplevel's physical answer) and the board
    // offers to `git init` it — the gitMissing flag on the repo row is derived
    // at read time, so it clears itself once init runs.
    let repoPath: string;
    let gitOwned = true;
    try {
      repoPath = await git(picked, "rev-parse", "--show-toplevel");
    } catch {
      repoPath = realpathSync(picked);
      gitOwned = false;
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
    // target branch. The null remote IS the mode. A not-yet-initted folder is
    // the extreme case: no git to ask at all, so both answers are the local-
    // only defaults ("main" matches what the board's init will create).
    let remote: string | null = null;
    if (gitOwned) {
      try {
        remote = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        remote = null;
      }
    }

    // All git questions answered before the first store write: a git failure
    // here must not leave a ghost Project with no Repo row behind.
    const targetBranch = gitOwned ? await defaultBranch(repoPath) : "main";

    const name = path.basename(repoPath);
    const project = this.store.createProject({ name, ticketPrefix: derivePrefix(name) });
    const repo = this.store.createRepo({
      projectId: project.id,
      path: repoPath,
      githubRemote: remote,
      targetBranch,
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

export type LocalServer = { port: number; command: string };

/**
 * Parse `lsof -F cn` output into localhost-reachable listeners. Field lines:
 * `c<command>` names the owning process, `n<addr>` names the socket. Only
 * loopback or wildcard binds count — a listener bound to a LAN address isn't
 * openable via localhost.
 */
export function parseLsofListeners(stdout: string): LocalServer[] {
  const byPort = new Map<number, string>();
  let command = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("c")) command = line.slice(1);
    if (!line.startsWith("n")) continue;
    const match = /^(\*|localhost|127\.0\.0\.1|\[::1?\]):(\d+)$/.exec(line.slice(1).trim());
    if (!match) continue;
    const port = Number(match[2]);
    if (!byPort.has(port)) byPort.set(port, command);
  }
  return [...byPort.entries()]
    .map(([port, cmd]) => ({ port, command: cmd }))
    .sort((a, b) => a.port - b.port);
}

/**
 * Listening TCP servers on this machine, for the right panel's Browser
 * surface. Same platform posture as the pickers above: the server runs on
 * the user's Mac, so it can ask `lsof` directly.
 */
export async function listLocalServers(): Promise<LocalServer[]> {
  try {
    const { stdout } = await promisify(execFile)("lsof", [
      "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn",
    ]);
    return parseLsofListeners(stdout);
  } catch (error) {
    // lsof exits 1 when nothing matches; missing binary reads the same way —
    // an empty list, not an error the panel can act on.
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" ? parseLsofListeners(stdout) : [];
  }
}

/**
 * The Files surface's tree: tracked plus untracked-but-not-ignored paths,
 * exactly what a developer thinks of as "the repo's files". Git owns the
 * ignore rules so we don't reimplement them.
 */
export async function listRepoFiles(repoPath: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["-C", repoPath, "ls-files", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout.split("\n").filter(Boolean).sort();
}

const FILE_READ_LIMIT = 512 * 1024;

/**
 * Read one repo file for the Files surface. The rel path is resolved and
 * prefix-checked against the checkout so `..` (or an absolute path) can't
 * escape it; oversized and binary files are refused rather than truncated.
 */
export async function readRepoFile(
  repoPath: string,
  relPath: string,
): Promise<{ content: string } | { error: string }> {
  const root = realpathSync(repoPath);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ValidationError("path escapes the repository");
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new ValidationError(`no such file: ${relPath}`);
  }
  if (statSync(resolved).size > FILE_READ_LIMIT) {
    return { error: "file is too large to display" };
  }
  const buffer = readFileSync(resolved);
  if (buffer.includes(0)) return { error: "binary file" };
  return { content: buffer.toString("utf8") };
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
    // symbolic-ref, not rev-parse: it answers on an unborn branch too (a
    // freshly-initted repo with no commits), where HEAD is not a revision.
    return git(repoPath, "symbolic-ref", "--short", "HEAD");
  }
}

/** "widget-press" → "WID": a readable per-project ticket key, not uniqueness. */
function derivePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.slice(0, 3) || "TRK";
}
