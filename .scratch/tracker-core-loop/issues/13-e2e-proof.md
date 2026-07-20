# End-to-end proof: one real ticket through the factory

Type: task
Status: done (2026-07-20)
Blocked by: 33, 35, 37, 38, 39, 40, 41, 42

## Question

Pick one real ticket in one real repo and run it through the built core loop hands-off: file with ACs → promote → agent claims, works the seeded workflow in a worktree → gates pass → review wizard walked → Done merges the PR — every acceptance criterion verified or explicitly waived. The answer records the ticket, the repo, what broke on the way, and the evidence bundle. This ticket closing closes the map.

## Answer (2026-07-20)

**The ticket:** E2E-1 "Machine-readable widget list" — derive `widgets.json` (JSON array of widget names) from `widget.txt` and document it in README. Two original ACs, both machine-checkable.

**The repo:** `barry-napier/tracker-gh-proof` (the ticket-31 scratch repo), fresh clone; isolated Tracker instance (own dataDir, port 4499, real provider registry, real `GhGitHub`). Provider: claude-code, seeded RPIRD workflow v1.

**The run, hands-off:**
- Filed with 2 ACs → promoted → worker pool claimed within seconds, cut worktree, branch `feat/e2e-1-machine-readable-widget-list`.
- Run 1: all five phases (research → plan → implement → dogfood → document) completed; agent authored `checks/ac-1.sh`/`ac-2.sh`; both AC checks passed at the battery — but `branch-recorded` and `pr-fresh` **failed**: the agent never pushed to GitHub (the worktree's `origin` is the local clone path, so its push landed locally and never reached the real remote). Diagnostic battery ran everything, bounced once with both failures batched.
- Bounce machinery: two Follow-up Criteria born (`gate-fail` origin), structured `kb/bounce-report.md` written into the persisting worktree (branch state, failed gates, evidence pointers).
- Run 2 (re-claim, worktree reused): read the bounce report, pushed the branch to the GitHub remote explicitly and opened PR #2, authored `ac-3.sh`/`ac-4.sh` for the follow-ups, dogfood matrix re-verified everything independently (5/5 green incl. real `git ls-remote` + `gh pr view` network checks). Battery: 6 pass, 2 legitimate skips (`suite` — no test command; `demo-fresh` — no preview, not user-facing), 4/4 AC checks pass. → Human Review.
- Review wizard walked in the real renderer (`?apiBase=` at the isolated instance): recap (2 files, +7 lines, PR head == branch tip), dogfood report, PR step (mergeable), artifacts (8 KB files with SHAs), Manual Walkthrough — ACs 1–2 re-verified by hand with human provenance on top of machine verification; all 4 settled, 0 waived.
- **Merge & Done**: real squash merge — PR #2 `MERGED` at 2026-07-20T18:52:03Z, merge commit `ec027bd` is `main`'s tip on GitHub. Ticket → Done with `verdict.recorded` + `ticket.merged` (human actor).
- Done sweep: safety predicate held (PR verifiably merged, evidence vouched into the artifact store), worktree reaped, `worktree.reaped` audited.

**What broke on the way:**
1. **Run-1 push-to-local-origin** (the one real finding): a worktree cut from a local clone inherits that clone as `origin`, so a naive `git push` satisfies the agent but not the `branch-recorded` gate, which checks the ticket's `githubRemote`. The loop *recovered by design* — the gate caught it, the bounce report explained it, run 2 pushed to the recorded remote. Possible future polish: the phase prompt (or worktree setup) could point `origin` at the ticket's GitHub remote so run 1 gets it right.
2. Non-issue, worth noting: `/api/runs/:id/log` is an SSE stream — a plain curl hangs forever.

**Evidence bundle:** `.scratch/tracker-core-loop/e2e-proof/` — run-1 and run-2 KB artifacts (research/plan/implement/dogfood/document, dogfood-results.json, recap.html, both bounce reports), `gate-results.txt` (all 20 gate rows across both runs), `audit-trail.json` (full ticket audit: 62 events, human/agent actors attributed). Durable external proof: <https://github.com/barry-napier/tracker-gh-proof/pull/2> (merged).

**Audit shape:** ticket.created/promoted (human) → ticket.claimed, worktree.created, 10× phase.started/completed, checks.registered, 20× gate.result, gates.failed, ticket.bounced, artifacts.persisted → ticket.claimed, worktree.reused, pr.recorded, gates.passed → 2× ac.verified (human), verdict.recorded (human), ticket.merged (human) → worktree.reaped.

This ticket closing closes the map.
