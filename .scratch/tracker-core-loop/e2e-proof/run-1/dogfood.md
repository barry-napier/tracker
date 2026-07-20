# Dogfood — E2E-1: Machine-readable widget list

**Verdict: READY** at frozen SHA `b7ac1b9a581cf4ec90dd033b35629e7eefa1d62c` (base: `main`).

## What was walked

Three scenarios, all green (see kb/dogfood-report.md and kb/dogfood-results.json):

- **S1 (AC-1)**: widgets.json exists at the repo root, strict-parses as a JSON array of strings, and its entries match the non-empty lines of widget.txt element-for-element in order (`["the widget"]` vs the single line `the widget`). Verified against widget.txt's actual bytes, not visually.
- **S2 (AC-2)**: README.md has a `## widgets.json` section that says what the file contains (a JSON array of widget name strings), that it derives from widget.txt's non-empty lines in order, and that regeneration is manual (no generator script).
- **S3 (AC-1, failure branch)**: a strict parser accepts the file with no leniency; all entries are strings, so downstream tooling can rely on the type contract.

The repo's own acceptance checks (`checks/ac-1.sh`, `checks/ac-2.sh`) both PASS with exit 0.

No preview environment is configured and the diff is pure static data + docs, so verification ran at the filesystem/CLI level — the artifact files are the observable surface. No persona configured → experiential judge skipped.

## What was fixed

Nothing. Zero fix commits; both acceptance criteria held on first walk.

## What a human must decide

Nothing. No open decisions, no parked scenarios, no sharp paper cuts.

One non-blocking observation: keeping widgets.json in sync with widget.txt is a manual process (documented in the README). If widget.txt starts changing often, a generator or CI check would be worth a follow-up ticket — out of scope here.
