# 28 — Plan phase emits AC checks

**What to build:** The plan phase's extended Phase Contract (see [Workflow engine design](07-workflow-engine.md)): the agent writes one executable check per machine-verifiable AC plus a manifest mapping **every** pending AC to either a script or a human-routing with a one-line reason. Plan-phase completion fails if the manifest doesn't cover every pending AC. Checks are registered against their AC rows and survive in the worktree for the battery (slice 29) and for future bounced Runs.

**Blocked by:** 27 — Full seeded workflow.

**Status:** done (2026-07-18)

- [x] Plan completion requires: contract file AND manifest covering every pending AC (script or `"human"` + reason)
- [x] Check scripts registered against AC rows; human-routed ACs flagged for the Manual Walkthrough
- [x] Incomplete manifest → phase failed (exercised via a misbehaving FakeProvider script)
- [x] On a later Run, existing checks re-execute against pending ACs without re-authoring (proven when 30 lands; here: checks persist and re-registration is idempotent)

## Resolution notes (2026-07-18)

- Manifest format: `checks/manifest.json` is a flat object keyed by AC id — value is a
  worktree-relative script path (string) or `{"human": "<one-line reason>"}`. Validation
  lives in `src/server/checks.ts` (`readCheckManifest`): missing/invalid manifest, uncovered
  pending AC, dangling or escaping script path, empty human reason, unknown AC id all fail
  the phase. Entries for non-pending ACs are tolerated (bounce re-runs) but not registered.
- The extended contract is workflow data, not an engine special case: `workflow_nodes.emits_checks`
  (migration 6) flags the seeded plan node; the engine enforces the manifest for any flagged node.
- Registration: `ac_checks` table, UNIQUE per AC, upsert (`registerAcChecks`) — re-registration
  on a later Run updates in place (idempotent), `run_id` records the latest registering Run.
  `checks.registered` audit event; the check rides on the AC in every ticket read
  (`AcceptanceCriterion.check`), so human routings are visible to the wizard slice.
- Template ACs now render as `- [pending] AC-<id>: text` so agents know the ids to key on;
  plan template (migration 6) instructs the script + manifest contract. Demo provider and
  test fakes comply (`pendingAcIdsFromPrompt` in `providers/fake.ts`).
- AC statuses are re-read at validation time — a human may have waived an AC since claim;
  waived/verified ACs need no coverage.
