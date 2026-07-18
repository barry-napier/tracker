# 33 — Wizard verdicts: fail bounces, pass merges

**What to build:** The wizard becomes the veto point. Pass/fail/skip per step; failing a step requires a written reviewer note that lands verbatim in a follow-up AC (origin review-fail) and the next Bounce Report. The Manual Walkthrough checklist lets the reviewer verify (human provenance), fail, or waive ACs. Final Verdict re-runs the cheap freshness subset (`pr-fresh`, `branch-recorded`, mergeability) before offering merge; drift blocks with a re-verify (bounce) or force-merge (waive-equivalent event) choice. Merge moves the Ticket to Done through the GitHubPort; a failed review bounces through the slice-30 machinery.

**Blocked by:** 31 — GitHub for real; 32 — Wizard read-only.

**Status:** ready-for-agent

- [ ] Fail without a note is impossible; the note reaches the follow-up AC and Bounce Report verbatim
- [ ] Walkthrough verify/fail/waive updates AC rows with human provenance (waive: mandatory reason)
- [ ] Done requires every AC ∈ {verified, waived}; the verdict UI makes an unmet AC visible before merge
- [ ] Freshness re-check at Final Verdict; drift → re-verify or force-merge, both audited
- [ ] Failed review → bounce with follow-ups; passed review → PR merged, Ticket Done — both drivable through the UI and asserted through the API
