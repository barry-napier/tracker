# Dogfood — E2E-1: Machine-readable widget list (run 2, post-bounce)

**Verdict: READY** at frozen SHA `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c` (base: `main`).

## What was walked

Five scenarios, all green (see kb/dogfood-report.md and kb/dogfood-results.json):

- **S1 (AC-1)**: widgets.json at the repo root strict-parses (python3 `json.load`) as a JSON array of strings equal to the non-empty lines of widget.txt in order — `["the widget"]`. Verified with an independent parser comparison, not just the repo's check script.
- **S2 (AC-2)**: README.md's `## widgets.json` section states what the file contains, that it derives from widget.txt's non-empty lines in order, and that regeneration is manual.
- **S3 (AC-3, branch-recorded)**: `git ls-remote` against github.com directly shows the branch on barry-napier/tracker-gh-proof with the remote ref SHA equal to the local tip `b7ac1b9`. This was bounce cause #1 (run 1 pushed only to the local intermediate `origin`); the run-2 implement phase fixed it with a direct push, and this run re-verified it independently.
- **S4 (AC-4, pr-fresh)**: PR #2 (https://github.com/barry-napier/tracker-gh-proof/pull/2) is OPEN, base `main`, head SHA == branch tip `b7ac1b9` — asserted via the GitHub API. This was bounce cause #2 (no PR existed); run 2 opened it and no commits landed after, so head == tip holds.
- **S5 (suite)**: all four checks/ac-*.sh scripts PASS with exit 0 at the frozen SHA.

No preview environment is configured and the diff is static data + docs, so S1/S2/S5 ran at the filesystem/CLI level; S3/S4 are real network checks against GitHub. No persona configured → experiential judge skipped.

## What was fixed

Nothing this phase. Zero fix commits; all four ACs held on first walk. (The gate failures from bounce 1 were fixed by the run-2 implement phase — direct push + PR #2 — before verification; this run confirmed both independently. The branch tip is unchanged from run 1.)

## What a human must decide

Nothing. No open decisions, no parked scenarios, no sharp paper cuts.

Non-blocking observations: (1) blank-line filtering in widget.txt is untested by fixture — exercising it would mutate a tracked file and break pr-fresh; (2) widgets.json ↔ widget.txt sync is manual, enforced only by checks/ac-1.sh. Both fine for this ticket's scope.
