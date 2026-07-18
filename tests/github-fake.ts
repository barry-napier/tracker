import type { GitHubPort, PullRequestRef } from "../src/server/github.ts";

/**
 * The GitHubPort's test backing (spec 21, Testing Decisions): in-memory
 * branch and PR state, keyed by remote. Tests (or scripted provider phases,
 * standing in for the agent that pushes and opens the PR) declare what
 * "GitHub" knows; the battery reads it through the same seam production
 * will back with `gh` in slice 31.
 */
export class FakeGitHub implements GitHubPort {
  #branches = new Set<string>();
  #prs = new Map<string, PullRequestRef>();
  #nextNumber = 1;

  recordBranch(remote: string, branch: string): void {
    this.#branches.add(key(remote, branch));
  }

  openPr(remote: string, branch: string, headSha: string): PullRequestRef {
    const number = this.#nextNumber++;
    const pr = { number, url: `https://github.test/pr/${number}`, headSha };
    this.#prs.set(key(remote, branch), pr);
    return pr;
  }

  async branchExists(remote: string, branch: string): Promise<boolean> {
    return this.#branches.has(key(remote, branch));
  }

  async findPr(remote: string, branch: string): Promise<PullRequestRef | null> {
    return this.#prs.get(key(remote, branch)) ?? null;
  }
}

function key(remote: string, branch: string): string {
  return `${remote}#${branch}`;
}
