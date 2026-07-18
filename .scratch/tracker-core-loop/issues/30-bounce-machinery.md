# 30 — Bounce machinery: follow-ups, Bounce Report, park

**What to build:** A failed battery bounces the Ticket once with the whole batch: each failure emits one follow-up AC row (origin gate-fail, text from the gate's detail), the orchestrator deterministically renders the Bounce Report (per failed AC/gate: criterion, check, output excerpt with full log linked, evidence pointers; reviewer feedback verbatim; prior-run pointers; tree-state summary) — no LLM summarization. The bounced Ticket returns to In Progress; the next claim reuses the worktree as-is (fetch only, no reset) and the new Run's templates receive the follow-ups and Bounce Report path. Third failed cycle parks the Ticket in Human Review flagged as arrived-by-cap.

**Blocked by:** 29 — Gate battery.

**Status:** ready-for-agent

- [ ] One bounce event carries the batched follow-up ACs; Ticket → In Progress
- [ ] Bounce Report written into the persisting worktree and recorded as a Run artifact
- [ ] On the new Run: failed and machine-verified ACs reset to pending; human-verified and waived persist; existing check scripts re-execute without re-authoring
- [ ] Re-claim reuses the worktree untouched (no reset/clean/rebase); tree-state summary (branch, ahead-by, dirty count) recorded
- [ ] Bounce cap 3 → Human Review with the arrived-by-cap flag on the Ticket
- [ ] A scripted FakeProvider run demonstrates fail → bounce → converge-green across two Runs through the API seam
