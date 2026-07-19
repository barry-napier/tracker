import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { repoSlug, type AffiliatedRepo, type GitHubPort } from "./github.ts";
import { StateError, ValidationError, type Store } from "./store.ts";
import type { Project, Repo } from "./types.ts";

/** An affiliated repo as Home's clone pane lists it: flagged when tracked. */
export interface HomeRepo extends AffiliatedRepo {
  /** The Project already holding this remote, if any — one remote, one Project. */
  trackedProjectId: number | null;
}

/** GitHub couldn't answer (gh missing, unauthenticated, clone refused) — 502, not 4xx. */
export class GitHubUnavailableError extends Error {}

export type CloneOutcome =
  | { alreadyTracked: true; project: Project }
  | { alreadyTracked: false; project: Project; repo: Repo };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Home's GitHub-facing half (ticket A): list the repos a Project could start
 * from, and turn a pick into a clone plus Project + Repo rows. Everything
 * derivable is derived (name, target branch, remote); run config stays empty
 * until a human fills it in on the board. Domain errors are the store's own
 * classes — app.onError does the status mapping.
 */
export class Home {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubPort,
  ) {}

  async listGitHubRepos(): Promise<HomeRepo[]> {
    const affiliated = await this.github.listAffiliatedRepos();
    return affiliated.map((repo) => ({
      ...repo,
      trackedProjectId: this.trackedProjectId(repo.nameWithOwner),
    }));
  }

  async clone(input: { nameWithOwner?: unknown; parentDir?: unknown }): Promise<CloneOutcome> {
    const { nameWithOwner, parentDir } = input;
    if (!isNonEmptyString(nameWithOwner)) throw new ValidationError("nameWithOwner is required");
    if (!isNonEmptyString(parentDir)) throw new ValidationError("parentDir is required");
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
      throw new ValidationError(`parent directory does not exist: ${parentDir}`);
    }

    const trackedId = this.trackedProjectId(nameWithOwner);
    if (trackedId !== null) {
      const project = this.store.getProject(trackedId);
      if (project) return { alreadyTracked: true, project };
    }

    const listed = (await this.github.listAffiliatedRepos()).find(
      (repo) => repo.nameWithOwner === nameWithOwner,
    );
    if (!listed) throw new ValidationError(`not an affiliated repo: ${nameWithOwner}`);
    const name = nameWithOwner.split("/")[1]!;
    const destination = path.join(parentDir, name);
    if (existsSync(destination)) {
      throw new StateError(`directory already exists: ${destination}`);
    }

    try {
      await this.github.clone(listed.sshUrl, destination);
    } catch (error) {
      throw new GitHubUnavailableError(
        `clone failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Rows only after the clone landed: a failed clone leaves no ghost Project.
    const project = this.store.createProject({ name, ticketPrefix: derivePrefix(name) });
    const repo = this.store.createRepo({
      projectId: project.id,
      path: destination,
      githubRemote: listed.sshUrl,
      targetBranch: listed.defaultBranch,
    });
    return { alreadyTracked: false, project, repo };
  }

  /**
   * One remote = one Project: match however the Repo row spells its remote.
   * GitHub slugs are case-insensitive, so the compare is too.
   */
  private trackedProjectId(nameWithOwner: string): number | null {
    for (const repo of this.store.listRepos()) {
      try {
        if (repoSlug(repo.githubRemote).toLowerCase() === nameWithOwner.toLowerCase()) {
          return repo.projectId;
        }
      } catch {
        // A remote that repoSlug can't parse can't be the one we're looking for.
      }
    }
    return null;
  }
}

/** "widget-press" → "WID": a readable per-project ticket key, not uniqueness. */
function derivePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.slice(0, 3) || "TRK";
}
