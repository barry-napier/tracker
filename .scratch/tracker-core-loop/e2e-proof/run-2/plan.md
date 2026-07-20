# E2E-1 Plan — run 2 (post-bounce): satisfy the evidence gates

## Context

The product work is done and committed (`b7ac1b9`); AC-1 and AC-2 pass locally
(re-verified this run). Run 1 bounced only on the two evidence gates. I read
the tracker's gate source (`tracker/src/server/gates.ts`, `github.ts`) to plan
against the real gate logic, not guesses:

- **branch-recorded** = `ticket.branch` set (already true per bounce report)
  AND `gh api repos/<slug>/branches/<branch>` returns 200 on **GitHub** —
  not the local intermediate `origin`.
- **pr-fresh** = `gh pr list --repo <slug> --head <branch> --state open`
  finds a PR AND its `headRefOid` == `git rev-parse HEAD` in the worktree.
  The gate **records the PR on the ticket itself** once it finds it on GitHub
  ("no PR recorded for branch" just means no open PR existed). No tracker-API
  call is needed from us.

Verified preconditions this run:
- `gh` authenticated as `barry-napier`; `~/.gitconfig` wires
  `credential.https://github.com.helper = !gh auth git-credential`, so HTTPS
  push will authenticate.
- `git ls-remote https://github.com/barry-napier/tracker-gh-proof.git` shows
  only `main`, stale `feat/proof`, and old `refs/pull/1/head` — ticket branch
  absent, no open PR. Both gates would still fail today.

## Steps (implement phase)

1. **Push the branch tip directly to GitHub**, bypassing the intermediate
   local clone (`origin` here is a local path; pushing only there is exactly
   what bit run 1):
   ```sh
   git push https://github.com/barry-napier/tracker-gh-proof.git \
     HEAD:refs/heads/feat/e2e-1-machine-readable-widget-list
   ```
   Then `bash checks/ac-3.sh` → must PASS.

2. **Open the PR** from the ticket branch into `main`:
   ```sh
   gh pr create --repo barry-napier/tracker-gh-proof \
     --head feat/e2e-1-machine-readable-widget-list --base main \
     --title "E2E-1: machine-readable widget list" \
     --body "Adds widgets.json (JSON array of widget.txt's non-empty lines, same order) and documents it in README.md."
   ```
   Then `bash checks/ac-4.sh` → must PASS (open PR, head SHA == `b7ac1b9`).

3. **Touch nothing afterward.** Any new commit moves the branch tip past the
   PR head and re-fails pr-fresh. If a commit is ever unavoidable, re-push to
   the GitHub URL before the gate runs (the PR head follows the branch).

Order matters: push before PR (gh pr create needs the remote branch), and the
PR is opened at the final tip.

## Verification seams

All four pending ACs are machine-checkable — no human routing.
`checks/manifest.json` maps 1→ac-1.sh, 2→ac-2.sh, 3→ac-3.sh, 4→ac-4.sh.

- `checks/ac-1.sh` / `checks/ac-2.sh`: unchanged from run 1, both PASS now.
- `checks/ac-3.sh`: mirrors the gate's remote half — `gh api
  repos/barry-napier/tracker-gh-proof/branches/<branch>`. (The
  recordedOnTicket half is already true and the tracker DB isn't reachable
  from this worktree; the remote half is the only delta.) Currently FAILs;
  passes after step 1.
- `checks/ac-4.sh`: mirrors the gate exactly — open PR with head == branch via
  `gh pr list --json headRefOid`, compared to `git rev-parse HEAD`. Currently
  FAILs; passes after step 2.

Both new scripts were run pre-implementation and fail with the same reasons
the gates reported — confirming they test the real seam.

## Constraints / non-goals

- **No product-code changes** — widgets.json, README.md, widget.txt stay as
  committed in `b7ac1b9`.
- Don't push to the intermediate `origin` and call it done; the gate reads
  github.com.
- Leave the stale `feat/proof` ref and closed PR #1 alone.
- Don't add remotes permanently or rewrite history; a URL push is enough.
