# Dogfood report — E2E-1: Machine-readable widget list

> Verdict: **READY**
> Frozen SHA: `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c` · Base: `main` · Scenarios: 5 green / 5 total
> Fixes: 0 · Paper cuts: 0 sharp / 0 total

## Matrix

| # | Journey (past the endpoint) | Kind | Functional | Experiential | Evidence | Fix |
|---|---|---|---|---|---|---|
| S1 | Consumer strict-parses widgets.json (python3 `json.load`, no leniency) into an array whose every entry is a string and which equals the non-empty lines of widget.txt element-for-element, in order — independent comparison, not the repo's own check script | http | ✅ pass | — | kb/evidence/S1-ac1.txt | — |
| S2 | New contributor reads README.md and learns what widgets.json contains (JSON array of widget name strings), that it derives from widget.txt's non-empty lines in order, and how to regenerate it (by hand — no generator script) | http | ✅ pass | — | kb/evidence/S2-ac2.txt | — |
| S3 | branch-recorded gate: `git ls-remote` against github.com/barry-napier/tracker-gh-proof directly (bypassing the local-path `origin` that caused the run-1 bounce) resolves `feat/e2e-1-machine-readable-widget-list` and the remote ref SHA equals the local frozen tip `b7ac1b9` | http | ✅ pass | — | kb/evidence/s3-ac3.txt | — |
| S4 | pr-fresh gate: GitHub API (`gh pr view 2`) shows PR #2 state OPEN, base `main`, head `feat/e2e-1-machine-readable-widget-list`, and headRefOid equal to the branch tip `b7ac1b9` — state, base, and SHA all asserted, not just PR existence | http | ✅ pass | — | kb/evidence/s4-ac4.txt | — |
| S5 | The ticket's own acceptance suite (checks/ac-1.sh … ac-4.sh per checks/manifest.json) runs end to end at the frozen SHA; every script prints PASS and exits 0 | http | ✅ pass | — | kb/evidence/s5-suite.txt | — |

**Cut from the matrix** (cap is 12, ranked by risk): nothing

Note on "Kind": no preview environment is configured for this repo and the diff is pure static data + docs — there is no server to curl or page to drive. S3/S4 are genuine network checks (git-over-HTTPS and the GitHub API); S1/S2/S5 were walked at the filesystem/CLI level because the artifact files are the observable surface. "http" is the closest schema value; no browser journeys exist for this change.

## Paper cuts

No persona for this repo → experiential judge skipped.

No functional paper cuts found. The README documents the regeneration story (manual, no generator), which pre-empts the most likely future confusion.

## Decisions for a human

<!-- Empty section = no open questions. -->

## Instruments

- Suite: `for f in checks/ac-*.sh; do bash "$f"; done` → 4/4 PASS (exit 0) at `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c`
- Console/network harvest: n/a — no browser surface; the two GitHub calls (ls-remote, gh api) returned clean
- Preview: none configured for this repo; the diff has no runnable surface (static JSON + README), so nothing was blocked by its absence
- Not covered: (1) blank-line filtering in widget.txt — the fixture has a single non-empty line, and exercising the filter would mean mutating a tracked file, which would move the branch tip and break the pr-fresh gate; the filter is asserted only over the current fixture. (2) Drift over time — syncing widgets.json with widget.txt is manual and only checks/ac-1.sh enforces the match; acceptable for this ticket's scope, stated in the README.

## Bounce follow-up

Both follow-up criteria from bounce 1 are resolved and independently re-verified this run:

- **branch-recorded** — run 1 pushed only to the local intermediate `origin`; the implement phase of run 2 pushed the tip directly to github.com (commit unchanged, `b7ac1b9`). S3 confirms the remote ref exists and matches the tip.
- **pr-fresh** — no PR existed; run 2 opened https://github.com/barry-napier/tracker-gh-proof/pull/2. S4 confirms it is OPEN with head == tip. No commits were added after the PR opened (working tree clean; kb/ and checks/ are git-ignored, so these artifacts do not move the tip).
