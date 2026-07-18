# Evidence gate battery v1

Type: grilling
Status: resolved
Assignee: Barry Napier (session 2026-07-18)
Resolved: 2026-07-18

## Question

Which evidence gates make up the v1 battery, and what are their exact semantics? The prototype's battery: artifact, artifact-lint, branch-recorded, suite (repo test suite), pr-fresh (PR head == branch tip), demo-fresh (demo expected/recorded for feature branches). Decide: adopt as-is or amend; pass/fail/skip semantics per gate (e.g. demo skipped for chores); how agent-authored AC checks plug in as gates; what "every criterion verified or explicitly waived" means mechanically (who can waive, where it's recorded); and what a gate failure does (bounce to In Progress with follow-up criteria).

Input from issue 05's resolution (2026-07-18): `gate_results` rows hang off a Run (gate key, pass/fail/skip, detail JSON) with a nullable `ac_id` linking agent-authored AC checks to their criterion; AC status semantics (pending/verified/failed/waived, reset rules per run) are already decided — see CONTEXT.md and the issue 05 resolution.

## Answer (2026-07-18)

1. **Roster: adopt all six prototype gates + AC checks.** `artifact`, `artifact-lint`, `branch-recorded`, `suite`, `pr-fresh`, `demo-fresh`, plus agent-authored AC checks (one per machine-verifiable criterion). Each prototype gate exists because an agent once faked that step; nothing speculative added.

2. **Skip semantics are fact-driven, never agent-declared.** `demo-fresh` skips when the ticket type is not user-facing (chore/refactor/docs — type already lives in branch naming `<type>/`); `suite` skips when the repo has no configured test command. All other gates always run. Skip renders as "n/a" in the wizard, never as a green check. The agent cannot declare a skip.

3. **AC checks: script file per check, orchestrator executes.** During the plan phase the agent writes one executable per checkable AC (`checks/<ac-id>.*` in the worktree — shell, node, playwright, anything runnable) and registers it against the AC row. At gate time the *orchestrator* runs each script in the worktree: exit 0 → AC verified, non-zero → failed; each execution is a `gate_results` row carrying its `ac_id`. ACs the agent deems un-checkable are flagged during plan and routed to the Manual Walkthrough step. Trust boundary: agent authors, orchestrator executes — a weak check is reviewable evidence in the wizard, but a result cannot be faked. Scripts survive bounces: a new run re-executes existing checks against pending ACs without re-authoring.

4. **Waive: anywhere, forward-acting.** Waiving is exposed in the review wizard (Manual Walkthrough, Final Verdict) *and* on ticket detail in any state (pre-waiving an aspirational AC is legitimate). Human-only, reason mandatory, event logged — already fixed by the domain model. A waived AC counts as satisfied for Done and its check script is skipped on future runs. A waive never rescues a run mid-Verifying: if a gate already failed, the ticket bounces regardless and the waive takes effect next cycle. Gate evaluation stays a pure function of recorded state — no re-evaluation races.

5. **Failure: run everything, one bounce, batched follow-ups.** The battery always runs all gates + all AC checks even after the first failure — it is diagnostic, not a tripwire, and bounce cycles cost minutes-to-hours. Each failure emits one follow-up AC row (`origin: gate-fail`, text generated from the gate's detail, e.g. "Test suite passes: 3 failures in auth.test.ts"). One bounce event carries the whole batch.

6. **Bounce cap: 3 per ticket, then park in Human Review.** After the third failed cycle the ticket moves to Human Review anyway, with the wizard prominently showing failed gates/ACs and that it arrived by cap, not by passing gates. The human waives, edits ACs and re-promotes, or kills the ticket. No new board state — the existing veto point absorbs the stuck case. Rationale: three attempts matches observed agent convergence; beyond that the failure is spec-shaped, which is human territory.

7. **Merge-time freshness: re-run the cheap freshness subset at Final Verdict.** Before Done merges: `pr-fresh`, `branch-recorded`, and GitHub mergeability re-check (two git/API calls, instant in the happy path). Drift blocks the merge and shows what changed; the human chooses re-verify (bounce for a fresh cycle) or force-merge (recorded as a waive-equivalent event). Suite and demos do not re-run — the human just reviewed them. Closes the gap where the audit trail could claim something the merge didn't match.

Mechanical definitions carried forward for the implementers: `pr-fresh` = PR head SHA == branch tip; `branch-recorded` = branch pushed to the GitHub remote and recorded on the ticket; `demo-fresh` = demo artifact timestamp newer than the last code commit on the branch; `artifact` existence and `artifact-lint` required-sections are defined by ticket 11 (recap/dogfood formats).

**Roster amendment (2026-07-18, via the delegation above):** [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) added a seventh gate, **`dogfood-green`** — every scenario in `dogfood-results.json` must be `pass`/`fixed`/`waived`; each failing row emits one follow-up AC through the standard bounce machinery. Definition lives in ticket 11.

"Every criterion verified or explicitly waived" mechanically: Done requires every AC row in {verified, waived} — machine-verified via check scripts, human-verified via Manual Walkthrough, or waived with reason.
