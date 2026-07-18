# Tracker Core Loop

Label: wayfinder:map

## Destination

The core loop lives in this Electron app: file a ticket with acceptance criteria → promote to Todo → an agent claims it, runs the research→plan→implement→review→document workflow in an isolated worktree → machine-checked evidence gates pass → Verifying → Human Review via the review wizard (visual recap, dogfood report, PR, demo video, preview environment, manual walkthrough, verdict) → Done merges the PR via GitHub. **Proven when one real ticket runs end-to-end, hands-off, with every acceptance criterion verified or explicitly waived.**

## Notes

- **Execution override:** this effort carries execution — decisions first, then implementation slices graduate from the fog, ending in the e2e proof ticket.
- **Prototype = spec.** A working prototype exists elsewhere (screenshots in session history); treat its behavior — states, gate battery, review wizard steps, artifacts — as the reference spec. Its code is NOT ported.
- Skills to consult per session: `/grilling`, `/domain-modeling` for decision tickets; `/prototype` for UI-shape tickets; `/research` subagents for research tickets.
- Standing constraints decided at charting (2026-07-18):
  - Any repo: target repo is a parameter of the project/ticket, never hardcoded. No adapter layer — plain git + GitHub assumed.
  - GitHub required: agent opens a real PR per ticket; Done merges via `gh`.
  - Providers: Claude Code, Kiro CLI, Copilot CLI as subprocesses behind a pluggable provider abstraction.
  - Store: SQLite in Tracker's app data. The activity ledger is an event log in the same DB.
  - Orchestrator runs inside Electron's main process; factory runs while the app runs.
  - Concurrency: 3 workers (5 melted the CPU).
  - States: Backlog → Todo → In Progress → Verifying → Human Review → Done. Failed verification or failed human review bounces to In Progress with follow-up criteria.
  - Evidence checks are agent-authored from prose ACs during the plan phase — no mid-flight human approval; veto lives at Human Review.
  - Tech stack (decided 2026-07-18): TypeScript throughout; Hono as a localhost API/SSE layer in the Electron main process fronting the orchestrator + SQLite; React renderer talking HTTP/SSE to it (no bespoke IPC).
  - Workflows are data, not code: stored as a graph — nodes (type, name, prompt template, gate requirements) + edges (nullable condition label) per [ADR-0001](../../docs/adr/0001-workflows-are-graphs.md); research→plan→implement→review→document ships as the seeded default; the engine is an interpreter.
  - Ubiquitous language lives in repo-root `CONTEXT.md`; consult it before naming anything.
- **Spec:** the full synthesis of tickets 01–12 lives in [Spec: Tracker core loop](issues/21-core-loop-spec.md) (`ready-for-agent`) — build sessions read it first; it also fixes the testing seams (HTTP API primary, FakeProvider + GitHubPort fakes).
- **Build slices:** the spec is sliced into vertical tracer-bullet tickets 22–42 (2026-07-18, /to-tickets; the earlier horizontal module tickets 14–20 are closed as superseded). Frontier: [25 Claim cuts a worktree](issues/25-claim-cuts-worktree.md) done 2026-07-18; next up [26 FakeProvider runs one phase](issues/26-fakeprovider-one-phase.md); [End-to-end proof](issues/13-e2e-proof.md) remains the map-closing acceptance ticket, now blocked by 33, 35, 37, 38, 39, 40, 41, 42. Work slices one at a time with /implement, clearing context between tickets.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research: Claude Code headless interface](issues/01-claude-code-headless.md) — spawn `claude -p` with stream-json NDJSON output, `--resume` per phase, `--permission-mode` for unattended runs; success = exit 0 + `result.subtype "success"`; full doc on branch `research/claude-code-headless`.
- [Research: demo-video recording options for CLI agents](issues/04-demo-video-recording.md) — v1 = per-ticket Playwright `demo.spec` with `recordVideo` + trace (CDP screencast, no TCC permission, unattended-safe); screen-capture tools disqualified by macOS re-auth prompts; full doc on branch `research/demo-video-recording`.
- [Research: Kiro CLI headless interface](issues/02-kiro-cli-headless.md) — use `kiro-cli acp` (JSON-RPC/ACP over stdio) not `chat --no-interactive` (no JSON output, unreliable exit codes); trust flags are launch-time only; ACP owns session ids; full doc on branch `research/kiro-cli-headless`.
- [Research: Copilot CLI headless interface](issues/03-copilot-cli-headless.md) — CLI headless is `copilot -p --allow-all-tools` but plain-text only with undocumented exit codes; the official Copilot SDK (Node/TS) is the structured-contract path worth weighing in the provider design; full doc on branch `research/copilot-cli-headless`.
- [Evidence gate battery v1](issues/06-evidence-gate-battery.md) — all six prototype gates + agent-authored AC checks (script per AC, orchestrator executes); skips are fact-driven (ticket type / repo config), never agent-declared; waive anywhere but forward-acting; battery runs everything and bounces once with batched follow-up ACs; cap 3 bounces then park in Human Review; Final Verdict re-checks freshness (`pr-fresh` + mergeability) before merge.
- [Domain model and SQLite schema](issues/05-domain-model-sqlite-schema.md) — glossary in `CONTEXT.md`; Run is first-class (claim = run creation; gate results/phases/artifacts hang off it); Project 1—many Repo, ticket targets one repo; native ids `TRK-12` with external trackers as references only ([ADR-0002](../../docs/adr/0002-tracker-owns-ticket-identity.md)); ACs are rows (pending/verified/failed/waived + provenance, follow-ups are new rows); workflows stored as node/edge graphs ([ADR-0001](../../docs/adr/0001-workflows-are-graphs.md)); blobs on disk, DB holds pointers.
- [Workflow engine design](issues/07-workflow-engine.md) — dumb interpreter over the graph; fresh provider session per phase with `kb/<phase>.md` file handoff (Phase Contract); completion = provider success + contract file; plan emits `checks/` scripts + manifest covering every pending AC; gates stay orchestrator-side ([ADR-0003](../../docs/adr/0003-gates-outside-the-workflow-graph.md)); bounce = fresh run, full workflow, fed a deterministic Bounce Report; crash = retry phase once → run crashed → back to Todo, 3 crashes park in Human Review.
- [Worktree lifecycle and claim/lease semantics](issues/08-worktree-lifecycle.md) — Tracker-owned bare clone per repo in app data, worktrees at `<app-data>/worktrees/<repo>--<trk-id>` cut on first claim; branch = conventional-commit type + external-ref id (TRK fallback); no leases — claim is the Run row, single-instance lock, startup sweep crashes orphans; re-claims reuse the tree as-is (fetch only, no reset/rebase); teardown is the manual Done-column sweep behind a merged-and-artifacts-persisted predicate, startup reaps only true orphans.
- [Provider abstraction interface](issues/09-provider-abstraction.md) — TS `Provider` interface in the main process (`runPhase → events + RunResult`), per-provider adapters: Claude `-p` stream-json, Kiro via ACP JSON-RPC, Copilot via the official SDK wrapped in a Tracker-owned subprocess; block-level conversation event union (prompt/thinking/text/tool call+result); thin RunResult + orchestrator wall-clock timeout; full-trust permissions everywhere (worktree + review veto as containment); human picks provider at promotion, model pinned in provider config; capability flags `costReporting`/`streamsPartialText`/`emitsThinking`.
- [Recap doc and dogfood report formats](issues/11-recap-dogfood-formats.md) — Visual Recap = self-contained HTML per the vendored prototype authoring spec (wizard renders meta/badges live, agent authors narrative→what-to-review); Dogfood Report = templated markdown + `dogfood-results.json` against the vendored matrix schema; seed's review node becomes the dogfood phase (fresh session, preview-driven journeys, governor-capped fixes); nothing committed to the branch — `kb/`+`checks/` in `.git/info/exclude`, artifacts persisted to app data every run; lint stays minimal (ported `lintRecap` + schema check); new `dogfood-green` gate bounces failed scenarios, human questions flow to the wizard.
- [Board and review wizard UI shape](issues/12-board-review-wizard-ui.md) — kanban classic won the 3-variant prototype (branch `prototype/renderer-ui`): six-column board + slide-over drawer detail + centered modal wizard with horizontal stepper; SSE contract draft (app-wide `/api/events` + per-run log block streams) in the prototype's `events.ts`.
- [Preview environments](issues/10-preview-environments.md) — one PreviewManager, two consumers (demo recording during the run, wizard Manual Walkthrough at review); runs from the ticket's worktree at plain `localhost:<port>` (port `4000 + n % 1000`, probe-up fallback); per-repo config `command`/`kind: ui|api`/optional `readiness_path`, `$PORT` injected; TCP-open readiness default; record reaped by the Done sweep, process on demand, stops on verdict/app quit; system browser, no webview.

## Not yet specified

- Recurring agent templates (prototype's backlog cards: Find Critical Bugs, Architectural Cleanup, Living Docs, Simplify, Snyk, SonarQube) — includes the launch dialog's "auto-assign least-busy agent" option; core-loop tickets always get a human-picked provider at promotion (decided in [Provider abstraction interface](issues/09-provider-abstraction.md)).
- Stats / analytics views — includes the prototype's Variant C worker-lanes strip as a candidate "factory view" (noted while resolving [Board and review wizard UI shape](issues/12-board-review-wizard-ui.md)).
- Ticket templates.
- Cost / CPU throttling beyond the fixed 3-worker cap.
- Notifications.
- Orchestrator surviving app quit (daemonization).
- Preview infra beyond v1 (decided in [Preview environments](issues/10-preview-environments.md)): reverse proxy with `*.preview.localhost` hostnames + local HTTPS, standing named environments (prototype's dev/e-aide-admin/s-bedrock cards), a dedicated Previews management page with per-row start/stop/GC, remote development environments.
- Additional workflow phase library beyond the seeded default.
- Demo recording migrating from the orchestrator's demo step into the dogfood phase (recording proven matrix rows — the prototype's own deferred wish, noted while resolving [Recap doc and dogfood report formats](issues/11-recap-dogfood-formats.md)); v1 keeps the split decided in [Preview environments](issues/10-preview-environments.md).
- Paper cuts auto-drafting Backlog tickets (sharp-but-out-of-scope findings from the Dogfood Report; human still promotes).

## Out of scope

- Multi-user.
- External tracker integrations (Jira, Linear, GitHub Issues, markdown files) — decided while resolving [Domain model and SQLite schema](issues/05-domain-model-sqlite-schema.md): tickets carry an optional `external_ref` so sync can arrive as a fresh effort without a migration, but no sync in this map.
- Chat-based ticket intake (the prototype's `intake_sessions` — grill-style filing chat). Manual filing with ACs is enough to prove the loop.
- Repo adapters / non-GitHub forges.
- Workflow builder UI — workflows are data from day one (see Notes), but the authoring UI is a future effort. Reference captured at charting: Lindy-style node-graph flow editor (trigger node → perform-action / search-knowledge-base / enter-loop / condition / enter-agent-step nodes); screenshot in session history 2026-07-18. Implies the workflow data model is a graph — constraint noted on the workflow engine ticket.
- Porting the existing prototype's code — reference only.
