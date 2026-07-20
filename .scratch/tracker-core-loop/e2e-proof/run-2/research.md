# E2E-1 Research — run 2 (post-bounce)

## TL;DR

The product work from run 1 is complete, committed (`b7ac1b9`), and both AC
check scripts pass locally. Nothing in `widget.txt`, `widgets.json`, or
`README.md` needs to change. This run exists only to satisfy the two failed
evidence gates: **push the branch to GitHub** and **open + record a PR**.

## Repo state

- Branch `feat/e2e-1-machine-readable-widget-list`, clean, ahead of
  `origin/main` by exactly one commit: `b7ac1b9 "E2E-1: add widgets.json and
  document it in README"`.
- That commit adds `widgets.json` (`["the widget"]`) and a README section
  documenting it. `widget.txt` has one non-empty line (`the widget`), so the
  JSON matches in content and order.
- Verified this run: `bash checks/ac-1.sh` and `bash checks/ac-2.sh` both PASS
  (AC-1 and AC-2 are done; only the gates are pending).

## Remote topology (the important discovery)

This checkout is a git worktree whose `origin` is a **local** clone, which in
turn points at GitHub:

1. Worktree: this directory (`.git` file → `e2e-data/repos/tracker-gh-proof.git/worktrees/…`)
2. `origin` = `…/scratchpad/tracker-gh-proof` (local path)
3. That repo's `origin` = `https://github.com/barry-napier/tracker-gh-proof.git`

`git ls-remote origin` shows only `main` and a stale `refs/remotes/origin/feat/proof`
— the ticket branch is **not** on the intermediate repo, and therefore not on
GitHub. That's exactly why the `branch-recorded` gate failed
(`recordedOnTicket: true, onRemote: false`).

`gh` is authenticated as `barry-napier` with an active token, so opening the PR
from the CLI is viable.

## What the implement phase must do

1. **Push the branch through to GitHub.** Pushing to `origin` only lands it in
   the local intermediate clone. Either push from the intermediate repo onward
   to GitHub, or (simpler) push directly:
   `git push https://github.com/barry-napier/tracker-gh-proof.git feat/e2e-1-machine-readable-widget-list`
   — or add GitHub as a second remote in this worktree. The `branch-recorded`
   gate checks the **GitHub** remote, so stopping at the local `origin` fails it
   again.
2. **Open a PR** from `feat/e2e-1-machine-readable-widget-list` into `main` on
   `barry-napier/tracker-gh-proof` (e.g. `gh pr create`), and **record it on
   ticket 1** so the `pr-fresh` gate finds it. The gate compares the PR head
   SHA against the branch tip (`b7ac1b9`) — record the PR *after* pushing, and
   don't add commits afterward without updating/re-pushing.
3. **No product-code changes.** Any new commit changes the branch tip and risks
   a `pr-fresh` mismatch; the run-1 commit is sufficient for AC-1/AC-2.

## Risks

- **Gate checks GitHub, not local origin**: the intermediate-clone topology is
  the trap that likely bit run 1. Push must reach github.com.
- **pr-fresh staleness**: PR head SHA must equal the branch tip at gate time.
  Push first, open/record PR second, touch nothing after.
- **Ticket recording**: `pr-fresh` failed with "no PR recorded for branch" —
  creating the PR on GitHub may not be enough if the tracker needs it recorded
  via its API (bounce report references `GET /api/tickets/1/runs`); the
  implement phase should confirm how PRs get recorded on the ticket.
- **Stale `feat/proof` ref** on the intermediate repo is unrelated noise; leave
  it alone.
- Drift/formatting risks from run-1 research still stand but are moot — the
  files are already committed and passing.
