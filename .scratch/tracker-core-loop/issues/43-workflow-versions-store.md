# 43 — Workflow identity/version split and per-project assignment

**What to build:** The storage and engine layer of the workflow library per [ADR-0004](../../../docs/adr/0004-workflow-versions-from-day-one.md) and the CONTEXT.md Workflow/Default Workflow terms. Split `workflows` into identity (name, `archived`, `is_default`) and immutable content (`workflow_versions`; `workflow_nodes`/`workflow_edges` re-key from workflow to version). Migration names the seeded graph **RPIRD**, makes it version 1 and the default, backfills non-nullable `projects.workflow_id` to it, and backfills `runs.workflow_version_id` for existing runs. Claim resolves project → workflow head version and pins it on the Run; the `Store.getWorkflow()` LIMIT-1 seed hack dies. Store ops + routes: list library (with used-by-N-projects counts), duplicate (copies head version's graph as the new workflow's version 1, named "X (copy)"), rename, archive/unarchive, set-default, and change a project's selection. Invariant enforced atomically: exactly one active default at all times — archiving the default requires naming a successor in the same call. Selection changes emit no audit events (the Run's pinned version is the record).

**Blocked by:** nothing hard — but sequence after 36/37: they reshape the seeded graph's nodes, and once this ticket lands that graph is an immutable version 1 (later seed changes must append RPIRD v2). Also collides with 36 in store.ts/engine.ts if run concurrently.

**Status:** ready-for-agent

- [ ] Migration on an existing dev DB preserves all runs and phase history; `phase_executions.node_id` still resolves for past runs
- [ ] Claim pins the version: changing a project's workflow (or the library) mid-flight never alters a running or past Run
- [ ] Archived workflow stays live for projects referencing it — their next claim still runs it — but is excluded from any "selectable" listing
- [ ] Archiving the default without a successor is rejected; with one, both flags move atomically
- [ ] Duplicate yields an independent workflow whose graph edits (future) cannot touch the source; used-by counts and default badge come back on the library listing
- [ ] Project-creation path accepts a workflow id and falls back to the default when none given
