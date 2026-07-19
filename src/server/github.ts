import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The GitHubPort seam (spec 21, Testing Decisions): everything the gate
 * battery and the merge path ask GitHub, behind one interface. Production
 * backs it with `gh` (GhGitHub below); tests back it with a local "remote"
 * plus in-memory PR state.
 */

export interface PullRequestRef {
  number: number;
  url: string;
  /** The SHA the PR currently points at; pr-fresh compares it to the branch tip. */
  headSha: string;
}

/** GitHub computes mergeability async, so "unknown" is a real answer, not an error. */
export type Mergeability = "mergeable" | "conflicting" | "unknown";

export interface GitHubPort {
  /** Is the branch recorded on the remote? (`branch-recorded`, ticket 06.) */
  branchExists(remote: string, branch: string): Promise<boolean>;
  /** The open PR for the branch, if any (`pr-fresh`). */
  findPr(remote: string, branch: string): Promise<PullRequestRef | null>;
  /** Open a PR for an already-pushed branch (the agent's job in production). */
  createPr(
    remote: string,
    input: { branch: string; targetBranch: string; title: string; body: string },
  ): Promise<PullRequestRef>;
  /** Can the PR merge cleanly right now? (Final Verdict freshness, ticket 06 §7.) */
  mergeability(remote: string, prNumber: number): Promise<Mergeability>;
  /** Merge the PR; throws when GitHub refuses (conflicts, already merged). */
  mergePr(remote: string, prNumber: number): Promise<void>;
}

/**
 * The honest zero backing for servers with no GitHub configured: gates fail
 * rather than pretend (a skip would claim "not applicable", a pass would
 * claim evidence that doesn't exist), and the merge path refuses loudly.
 */
export class NullGitHub implements GitHubPort {
  async branchExists(): Promise<boolean> {
    return false;
  }

  async findPr(): Promise<PullRequestRef | null> {
    return null;
  }

  async createPr(): Promise<PullRequestRef> {
    throw new Error("no GitHub backing configured");
  }

  async mergeability(): Promise<Mergeability> {
    return "unknown";
  }

  async mergePr(): Promise<void> {
    throw new Error("no GitHub backing configured");
  }
}

/**
 * The `owner/repo` slug `gh -R` wants, derived from however the Repo row
 * spells its remote (SSH, HTTPS, or already a slug). Loud on anything else —
 * a silently-wrong slug would point every gate at the wrong repository.
 */
export function repoSlug(remote: string): string {
  const url = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (url) return url[1]!;
  if (/^[\w.-]+\/[\w.-]+$/.test(remote)) return remote.replace(/\.git$/, "");
  throw new Error(`cannot derive owner/repo from remote "${remote}"`);
}

/**
 * The production backing (ticket 31): every port question answered by the
 * `gh` CLI, which brings its own auth. One ticket = one PR = one squash
 * merge, so the branch's whole story lands as a single commit on the target.
 */
export class GhGitHub implements GitHubPort {
  async branchExists(remote: string, branch: string): Promise<boolean> {
    try {
      await gh("api", `repos/${repoSlug(remote)}/branches/${branch}`, "--silent");
      return true;
    } catch (error) {
      if (isHttp404(error)) return false;
      throw error;
    }
  }

  async findPr(remote: string, branch: string): Promise<PullRequestRef | null> {
    const stdout = await gh(
      "pr", "list",
      "--repo", repoSlug(remote),
      "--head", branch,
      "--state", "open",
      "--limit", "1",
      "--json", "number,url,headRefOid",
    );
    const prs = JSON.parse(stdout) as Array<{ number: number; url: string; headRefOid: string }>;
    const pr = prs[0];
    return pr === undefined ? null : { number: pr.number, url: pr.url, headSha: pr.headRefOid };
  }

  async createPr(
    remote: string,
    input: { branch: string; targetBranch: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const url = (
      await gh(
        "pr", "create",
        "--repo", repoSlug(remote),
        "--head", input.branch,
        "--base", input.targetBranch,
        "--title", input.title,
        "--body", input.body,
      )
    ).trim();
    const stdout = await gh("pr", "view", url, "--json", "number,url,headRefOid");
    const pr = JSON.parse(stdout) as { number: number; url: string; headRefOid: string };
    return { number: pr.number, url: pr.url, headSha: pr.headRefOid };
  }

  async mergeability(remote: string, prNumber: number): Promise<Mergeability> {
    const stdout = await gh(
      "pr", "view", String(prNumber),
      "--repo", repoSlug(remote),
      "--json", "mergeable",
    );
    const { mergeable } = JSON.parse(stdout) as { mergeable: string };
    if (mergeable === "MERGEABLE") return "mergeable";
    if (mergeable === "CONFLICTING") return "conflicting";
    return "unknown";
  }

  async mergePr(remote: string, prNumber: number): Promise<void> {
    await gh("pr", "merge", String(prNumber), "--repo", repoSlug(remote), "--squash");
  }
}

async function gh(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args);
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${failure.stderr?.trim() || failure.message}`, {
      cause: error,
    });
  }
}

function isHttp404(error: unknown): boolean {
  return error instanceof Error && error.message.includes("HTTP 404");
}
