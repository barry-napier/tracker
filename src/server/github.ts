/**
 * The GitHubPort seam (spec 21, Testing Decisions): everything the gate
 * battery and the merge path ask GitHub, behind one interface. Production
 * backs it with `gh` (slice 31); tests back it with a local "remote" plus
 * in-memory PR state.
 */

export interface PullRequestRef {
  number: number;
  url: string;
  /** The SHA the PR currently points at; pr-fresh compares it to the branch tip. */
  headSha: string;
}

export interface GitHubPort {
  /** Is the branch recorded on the remote? (`branch-recorded`, ticket 06.) */
  branchExists(remote: string, branch: string): Promise<boolean>;
  /** The open PR for the branch, if any (`pr-fresh`). */
  findPr(remote: string, branch: string): Promise<PullRequestRef | null>;
}

/**
 * The stand-in until slice 31 wires `gh`: nothing is on GitHub, honestly.
 * GitHub-flavored gates fail rather than pretend — a skip would claim
 * "not applicable" and a pass would claim evidence that doesn't exist.
 */
export class NullGitHub implements GitHubPort {
  async branchExists(): Promise<boolean> {
    return false;
  }

  async findPr(): Promise<PullRequestRef | null> {
    return null;
  }
}
