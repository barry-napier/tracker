# 27 — Full seeded workflow with Phase Contract handoff

**What to build:** The seeded default workflow — trigger → research → plan → implement → dogfood → document — as seed data (dogfood behaves as a plain scripted phase until slice 36). Each phase runs in a fresh session and receives the engine's fixed template variable set (ticket fields, ACs with statuses, target branch, prior phases' `kb/` paths). At the end of every Run — pass, bounce, or crash — `kb/*` is persisted to app data with artifact rows recording the worktree HEAD SHA at persist time; the drawer's artifacts section lists them.

**Blocked by:** 26 — FakeProvider runs one phase.

**Status:** done (2026-07-18)

- [x] Five-phase seed graph in the store; interpreter walks it end to end with FakeProvider
- [x] Fixed template variable set is the only context injection; later phases can read earlier `kb/` files
- [x] Phase executions recorded per node with outcome and provider session id
- [x] `kb/*` copied to per-run artifact storage on every run end regardless of outcome; artifact rows carry kind, content hash, and worktree HEAD SHA
- [x] Drawer lists a completed Run's artifacts; Ticket reaches Verifying

## Resolution (2026-07-18)

Migration v5 extends the seed to trigger → research → plan → implement →
dogfood → document (data-only — the interpreter didn't change, per ADR-0001),
adds `phase_executions.provider_session_id`, and creates `artifacts` (kind,
name, path, content hash, worktree HEAD SHA). Every phase template carries the
fixed variable set; two additions this slice: ACs render with statuses
(`- [pending] …`) and `{{priorKb}}` lists the contract files completed phases
left behind (`none yet` → `kb/research.md, kb/plan.md, …`) — the engine
accumulates the list as it walks.

`ArtifactStore` (`src/server/artifacts.ts`) copies the worktree's `kb/*` to
`<app-data>/artifacts/run-<id>/` at every run end. Ordering is deliberate:
persistence runs *before* `finishRun('completed')` and a persist failure
crashes the run — Verifying implies evidence on disk; on the failed/crashed
paths it's best-effort so a persist hiccup can't mask the real outcome.
Cancelled runs (app quit) skip it, matching the orphan-sweep design.
`Store.recordArtifacts` writes rows + `artifacts.persisted` audit atomically.

All `run.created`/`run.updated` bus events (and the runs API) now carry the
enriched shape — phases + artifacts — so the drawer stays live without
bespoke fetches; `run.phase_changed` additionally triggers a runs refetch in
the renderer, making the new phase list in the drawer's Run section tick
mid-flight. The drawer gained an Artifacts section (kind badge, name, short
hash, HEAD SHA on hover). Demo providers became phase-aware (contract file
and block ids derived from the prompt's `write kb/<phase>.md` instruction).

Gotcha for scripted providers, learned the hard way: parse the phase from the
*instruction* (`write kb/<phase>.md`), not the first `kb/*.md` mention — the
`{{priorKb}}` handoff line also names kb files and hollow-fails every phase
after research if you match it. Proven at the seam (`tests/workflow.test.ts`:
order + handoff + session ids, hollow-mid-workflow evidence survival, crash
recovery, 25-block log stream with unique ids) and live in the renderer
(phases ticking, artifacts appearing, `kb/` never in git status).
