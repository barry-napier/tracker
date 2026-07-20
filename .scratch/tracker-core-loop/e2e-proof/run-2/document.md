# E2E-1: Machine-readable widget list — documentation (run 2, post-bounce)

## What changed

**Product diff — unchanged since run 1.** Single commit `b7ac1b9` ("E2E-1: add
widgets.json and document it in README"), +7 lines, no deletions:

- **`widgets.json`** (new, repo root) — `["the widget"]`. A JSON array of
  strings holding the non-empty lines of `widget.txt`, in the same order. With
  the current one-line `widget.txt`, that's a single-element array.
- **`README.md`** (+6) — new `## widgets.json` section stating what the file
  contains (a JSON array of widget names), that it derives from the non-empty
  lines of `widget.txt` in order, and that there is no generator script —
  regeneration is manual.

`widget.txt` itself is untouched.

**Run 2 additions — remote state only, no commits.** Run 1 was bounced by two
evidence gates, not the code:

- `branch-recorded` failed because this worktree's `origin` is a *local*
  intermediate clone; run 1's push never reached github.com. Run 2 pushed the
  tip directly:
  `git push https://github.com/barry-napier/tracker-gh-proof.git HEAD:refs/heads/feat/e2e-1-machine-readable-widget-list`.
- `pr-fresh` failed because no PR existed. Run 2 opened
  **PR #2** (https://github.com/barry-napier/tracker-gh-proof/pull/2), base
  `main`, head SHA == branch tip `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c`.

## Why

The ticket asked for a machine-readable counterpart to `widget.txt` (one widget
name per line) so tooling can consume the list as JSON, plus README
documentation of what the file is and where it comes from. The run-2 gate work
exists solely to satisfy the bounce's follow-up criteria: the branch must exist
on the GitHub remote and an open PR must sit at the branch tip.

## Verification (all at frozen SHA `b7ac1b9`)

- AC-1: `checks/ac-1.sh` PASS; dogfood also re-verified with an independent
  `json.load` comparison against `widget.txt`.
- AC-2: `checks/ac-2.sh` PASS.
- AC-3 (branch-recorded): `checks/ac-3.sh` PASS; `git ls-remote` against
  github.com shows the branch at `b7ac1b9`, equal to the local tip.
- AC-4 (pr-fresh): `checks/ac-4.sh` PASS; GitHub API shows PR #2 OPEN with
  head == tip.
- Dogfood verdict: READY (kb/dogfood.md), five scenarios green, zero fix
  commits.

## What to review

1. The entire product diff is 7 lines across two files — check
   `widgets.json` content against `widget.txt` and the README wording (AC-1,
   AC-2).
2. Manual sync between `widget.txt` and `widgets.json` is a deliberate scope
   choice, documented in the README and enforced only by `checks/ac-1.sh`;
   flag if a generator script is wanted instead.
3. Run 2 contains no new commits — only the direct GitHub push and PR #2. The
   diff is identical to what run 1 produced.
4. Don't move the branch tip before gates re-run: `pr-fresh` requires PR #2's
   head to equal the tip. Any new commit must be pushed to GitHub so the PR
   head follows.

Visual recap: kb/recap.html (self-contained HTML, ends with the same review
notes).
