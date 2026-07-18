# 28 — Plan phase emits AC checks

**What to build:** The plan phase's extended Phase Contract (see [Workflow engine design](07-workflow-engine.md)): the agent writes one executable check per machine-verifiable AC plus a manifest mapping **every** pending AC to either a script or a human-routing with a one-line reason. Plan-phase completion fails if the manifest doesn't cover every pending AC. Checks are registered against their AC rows and survive in the worktree for the battery (slice 29) and for future bounced Runs.

**Blocked by:** 27 — Full seeded workflow.

**Status:** ready-for-agent

- [ ] Plan completion requires: contract file AND manifest covering every pending AC (script or `"human"` + reason)
- [ ] Check scripts registered against AC rows; human-routed ACs flagged for the Manual Walkthrough
- [ ] Incomplete manifest → phase failed (exercised via a misbehaving FakeProvider script)
- [ ] On a later Run, existing checks re-execute against pending ACs without re-authoring (proven when 30 lands; here: checks persist and re-registration is idempotent)
