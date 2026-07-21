import { execFileSync } from "node:child_process";
import type { AffiliatedRepo, GitHubPort, Mergeability, PullRequestRef, TeamPr } from "../src/server/github.ts";

interface FakePr {
  number: number;
  url: string;
  remote: string;
  branch: string;
  targetBranch: string;
  title: string;
  state: "open" | "merged";
}

/**
 * The GitHubPort's test backing (spec 21, Testing Decisions): a local git
 * repo stands in for GitHub's copy of each remote — so branchExists and PR
 * head SHAs are real refs, proving the agent actually pushed — while PR
 * state lives in memory. Head SHAs resolve live from the local remote,
 * mirroring how GitHub moves a PR's head when its branch is pushed again;
 * mergePr performs a real merge in the local remote, so "merged" is
 * verifiable from the repo, not just from this fake's memory.
 */
export class FakeGitHub implements GitHubPort {
  /** remote url → local repo path standing in for GitHub's copy. */
  #remotes = new Map<string, string>();
  #affiliated: AffiliatedRepo[] = [];
  #prs: FakePr[] = [];
  #nextNumber = 1;
  #mergeability = new Map<number, Mergeability>();

  registerRemote(remote: string, localPath: string): void {
    this.#remotes.set(remote, localPath);
  }

  /** Make a repo show up in the user's own+org listing (Home, ticket A). */
  registerAffiliatedRepo(repo: AffiliatedRepo): void {
    this.#affiliated.push(repo);
  }

  async listAffiliatedRepos(): Promise<AffiliatedRepo[]> {
    return [...this.#affiliated];
  }

  /** Team-work PR rows by owner/repo slug, seeded directly (no git backing). */
  #teamPrs = new Map<string, TeamPr[]>();

  seedTeamPr(pr: TeamPr): void {
    const rows = this.#teamPrs.get(pr.repo) ?? [];
    rows.push(pr);
    this.#teamPrs.set(pr.repo, rows);
  }

  async listPrs(remote: string): Promise<TeamPr[]> {
    const rows = this.#teamPrs.get(remote);
    if (rows === undefined) throw new Error(`gh pr list failed: could not resolve ${remote}`);
    return [...rows];
  }

  async clone(remote: string, destination: string): Promise<void> {
    // A real clone from the local repo playing GitHub's copy — the checkout
    // lands on that repo's HEAD branch, exactly as `gh repo clone` would.
    git(process.cwd(), "clone", this.#remotePath(remote), destination);
  }

  /** Force the next mergeability answer for a PR (default: "mergeable"). */
  setMergeability(prNumber: number, value: Mergeability): void {
    this.#mergeability.set(prNumber, value);
  }

  async branchExists(remote: string, branch: string): Promise<boolean> {
    return this.#branchSha(remote, branch) !== null;
  }

  async branchTip(remote: string, branch: string): Promise<string | null> {
    return this.#branchSha(remote, branch);
  }

  async findPr(remote: string, branch: string): Promise<PullRequestRef | null> {
    const pr = this.#prs.find(
      (candidate) =>
        candidate.remote === remote && candidate.branch === branch && candidate.state === "open",
    );
    if (!pr) return null;
    return { number: pr.number, url: pr.url, headSha: this.#branchSha(remote, branch) ?? "" };
  }

  async createPr(
    remote: string,
    input: { branch: string; targetBranch: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const headSha = this.#branchSha(remote, input.branch);
    if (headSha === null) {
      throw new Error(`cannot open PR: branch ${input.branch} was never pushed to ${remote}`);
    }
    const number = this.#nextNumber++;
    const pr: FakePr = {
      number,
      url: `https://github.test/pr/${number}`,
      remote,
      branch: input.branch,
      targetBranch: input.targetBranch,
      title: input.title,
      state: "open",
    };
    this.#prs.push(pr);
    return { number, url: pr.url, headSha };
  }

  async mergeability(remote: string, prNumber: number): Promise<Mergeability> {
    this.#requireOpenPr(remote, prNumber);
    return this.#mergeability.get(prNumber) ?? "mergeable";
  }

  async mergePr(remote: string, prNumber: number): Promise<void> {
    const pr = this.#requireOpenPr(remote, prNumber);
    if ((this.#mergeability.get(prNumber) ?? "mergeable") === "conflicting") {
      throw new Error(`PR #${prNumber} is not mergeable`);
    }
    // A real merge in the local remote: its target branch is checked out
    // there (the repo plays the user's checkout). Squash, like production's
    // `gh pr merge --squash`, down to gh's default commit subject — the fake
    // must not pass tests the real merge shape would fail.
    const path = this.#remotePath(remote);
    git(path, "merge", "--squash", `refs/heads/${pr.branch}`);
    git(path, "commit", "-m", `${pr.title} (#${pr.number})`);
    pr.state = "merged";
  }

  async prMerged(remote: string, prNumber: number): Promise<boolean> {
    const pr = this.#prs.find(
      (candidate) => candidate.remote === remote && candidate.number === prNumber,
    );
    return pr?.state === "merged";
  }

  #requireOpenPr(remote: string, prNumber: number): FakePr {
    const pr = this.#prs.find((candidate) => candidate.remote === remote && candidate.number === prNumber);
    if (!pr) throw new Error(`no PR #${prNumber} on ${remote}`);
    if (pr.state !== "open") throw new Error(`PR #${prNumber} is already ${pr.state}`);
    return pr;
  }

  #remotePath(remote: string): string {
    const path = this.#remotes.get(remote);
    if (path === undefined) throw new Error(`remote ${remote} is not registered with FakeGitHub`);
    return path;
  }

  #branchSha(remote: string, branch: string): string | null {
    const path = this.#remotes.get(remote);
    if (path === undefined) return null;
    try {
      return git(path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
