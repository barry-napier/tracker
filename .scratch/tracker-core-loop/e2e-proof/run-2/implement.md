# E2E-1 Implement — run 2 (post-bounce)

(Run 1's implement notes are preserved at artifacts/run-1/implement.md; that
run created widgets.json and the README section in commit `b7ac1b9`.)

## What this run did

No product changes. Run 1's commit `b7ac1b9` ("E2E-1: add widgets.json and
document it in README") already satisfies AC-1 and AC-2; this run only fixed
the two evidence-gate failures from the bounce report (branch not on GitHub,
no PR).

Steps executed, in order:

1. Re-verified `bash checks/ac-1.sh` and `bash checks/ac-2.sh` — both PASS,
   confirming no code work was needed.
2. Pushed the branch tip **directly to GitHub**, bypassing the local
   intermediate `origin` (the trap that caused the run-1 bounce —
   `origin` here is a local path, and the `branch-recorded` gate reads
   github.com):
   `git push https://github.com/barry-napier/tracker-gh-proof.git HEAD:refs/heads/feat/e2e-1-machine-readable-widget-list`
   → `[new branch]` created. `checks/ac-3.sh` PASS.
3. Opened the PR into `main`:
   `gh pr create --repo barry-napier/tracker-gh-proof --head feat/e2e-1-machine-readable-widget-list --base main`
   → https://github.com/barry-napier/tracker-gh-proof/pull/2.
   `checks/ac-4.sh` PASS — open PR #2 head SHA equals branch tip
   `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c`.
4. Touched nothing tracked afterward. This file (`kb/implement.md`) is
   git-ignored (verified via `git check-ignore`), so writing it does not move
   the branch tip or invalidate `pr-fresh`.

## Why

- **branch-recorded** requires the branch on the GitHub remote; run 1 only
  pushed to the local intermediate clone. A direct-URL push is the minimal fix
  (no new remotes added, no history rewritten).
- **pr-fresh** requires an open PR whose head SHA matches the branch tip. The
  PR was opened after the push, at the final tip, and no commits were added
  after — so head == tip holds at gate time. Per the plan, the gate itself
  records the found PR on the ticket once it exists on GitHub; no tracker-API
  call was needed.

## Final state

- Branch tip: `b7ac1b9` (unchanged from run 1), on GitHub, clean tree.
- Open PR: barry-napier/tracker-gh-proof#2, head == `b7ac1b9`.
- All four check scripts PASS (ac-1 through ac-4).
