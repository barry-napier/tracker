# Bounce Report — E2E-1, run 1 (bounce 1)

## Tree state (inherited as-is by the next run)

- Branch: feat/e2e-1-machine-readable-widget-list
- Ahead of origin/main by: 1 commit(s)
- Dirty files: 0

## Failed acceptance criteria

None.

## Failed gates

### branch-recorded

- Check: the branch is recorded on the ticket and exists on the GitHub remote
- branch: feat/e2e-1-machine-readable-widget-list
- recordedOnTicket: true
- onRemote: false
- Evidence: gate result #4 on run 1

### pr-fresh

- Check: the PR head SHA matches the branch tip
- branch: feat/e2e-1-machine-readable-widget-list
- reason: no PR recorded for branch
- Evidence: gate result #6 on run 1

## Reviewer feedback

None — this bounce came from the Evidence Gate battery, not a human review.

## Follow-up criteria added by this bounce

- [branch-recorded] Evidence gate branch-recorded passes
- [pr-fresh] Evidence gate pr-fresh passes: no PR recorded for branch

## Prior run

- Run 1 on branch feat/e2e-1-machine-readable-widget-list
- Full gate results: GET /api/tickets/1/runs
- Persisted artifacts:
  - document.md → artifacts/run-1/document.md
  - dogfood-report.md → artifacts/run-1/dogfood-report.md
  - dogfood-results.json → artifacts/run-1/dogfood-results.json
  - dogfood.md → artifacts/run-1/dogfood.md
  - implement.md → artifacts/run-1/implement.md
  - plan.md → artifacts/run-1/plan.md
  - recap.html → artifacts/run-1/recap.html
  - research.md → artifacts/run-1/research.md
