# Spec: Tracker core loop

Type: spec
Status: open
Label: ready-for-agent

Synthesized 2026-07-18 from the wayfinder map [Tracker Core Loop](../map.md) — all decision tickets (01–12) resolved. Vocabulary per repo-root `CONTEXT.md`; ADRs 0001–0003 apply.

## Problem Statement

Barry runs multiple side projects and client apps but has one pair of hands. Coding agents (Claude Code, Kiro, Copilot) can do real implementation work, but driving them by hand — writing prompts, watching terminals, checking their claims, opening PRs, verifying acceptance criteria — costs more attention than doing the work directly. Agents also lie: they report success on work they faked, skipped, or half-finished. There is no way to file a piece of work, walk away, and later review finished, *evidence-backed* output with confidence that every claim was machine-checked.

## Solution

Tracker is a desktop app (Electron) that runs a ticket factory. Barry files a Ticket with prose Acceptance Criteria and promotes it to Todo; an agent worker claims it, works a seeded research → plan → implement → dogfood → document workflow inside an isolated git worktree, and opens a real GitHub PR. The orchestrator — never the agent — executes a battery of Evidence Gates, including agent-authored but orchestrator-run AC checks. Failures bounce the Ticket back with machine-generated follow-up criteria; passes land it in Human Review, where a six-step review wizard (Visual Recap, Dogfood Report, Pull Request, Documentation & Artifacts, Manual Walkthrough with live preview, Final Verdict) lets Barry judge the work in minutes. Done merges the PR. The loop is proven when one real ticket runs end-to-end hands-off with every criterion verified or explicitly waived.

## User Stories

**Filing and the board**

1. As a developer, I want to file a Ticket with a title, description, and a list of prose Acceptance Criteria, so that I can capture work the moment I think of it.
2. As a developer, I want new Tickets to land in Backlog where no agent touches them, so that filing is free of commitment.
3. As a developer, I want to promote a Backlog Ticket to Todo by picking its target Repo and provider (defaulted from the Project), so that promotion is the single deliberate "go" action.
4. As a developer, I want a six-column board (Backlog, Todo, In Progress, Verifying, Human Review, Done), so that the state of every Ticket is visible at a glance.
5. As a developer, I want Ticket cards to show their immutable `TRK-<n>` id, title, and provider, so that I can identify work without opening it.
6. As a developer, I want in-progress cards to show a live phase indicator (research → plan → implement → dogfood → document), so that I can see where each Run is without reading logs.
7. As a developer, I want the board to update live over SSE without refreshing, so that I can leave it open as a monitoring surface.
8. As a developer, I want to link a Ticket to an External Reference (Jira/Linear/GitHub issue), so that outside trackers stay connected without owning identity.

**Ticket detail**

9. As a developer, I want a slide-over detail view with description, ACs, properties, artifacts, activity, and agent logs, so that everything about a Ticket is one click deep.
10. As a developer, I want each AC row to show its status (pending / verified / failed / waived), provenance (machine or human, via which gate or wizard step), and follow-up origin, so that I can trust — and audit — every green mark.
11. As a developer, I want to watch the agent's full conversation live (prompt, thinking, text, tool calls with results, streaming deltas), so that I can spot-check work in flight without interfering.
12. As a developer, I want the activity feed to render the append-only Audit Trail (promoted, claimed, phase transitions, gate results, bounces, verdicts, merges — each with actor and timestamp), so that I can reconstruct any Ticket's history.
13. As a developer, I want to waive an AC (with a mandatory reason) from ticket detail in any state, so that I can retire aspirational criteria before they burn a bounce cycle.
14. As a developer, I want to see every Run of a bounced Ticket with its phases, gate results, and artifacts, so that history is never overwritten by the latest attempt.

**The factory**

15. As a developer, I want a pool of 3 workers claiming Todo tickets automatically while the app runs, so that the factory needs no babysitting.
16. As a developer, I want each first claim to cut a branch from the target branch tip and create an isolated worktree off a Tracker-owned bare clone, so that agents never touch my own checkout.
17. As a developer, I want each phase to run in a fresh provider session that must write its Phase Contract file (`kb/<phase>.md`), so that context handoff is explicit and hollow phases are detectable.
18. As a developer, I want the plan phase to emit one executable check per machine-verifiable AC plus a manifest covering every pending AC (script or human-routed with reason), so that verification is planned before implementation begins.
19. As a developer, I want the dogfood phase to boot the Preview Environment and walk diff-and-AC-derived user journeys — fixing small issues under governor caps with fix SHA + regression test recorded — so that the work gets actually used before I see it.
20. As a developer, I want the document phase to author a Visual Recap and for every Run's `kb/` output to be persisted to app data (pass, bounce, or crash), so that evidence survives even failed attempts.
21. As a developer, I want the agent to open a real GitHub PR per Ticket, so that review and merge happen through the tools I already trust.
22. As a developer, I want a crashed phase retried once and a twice-crashed Run to send the Ticket back to Todo (with no new criteria), so that infrastructure failures are distinguished from wrong work.
23. As a developer, I want an orphaned Run detected at app startup and marked crashed, so that a hard quit never leaves zombie claims.
24. As a developer, I want a per-phase wall-clock timeout with SIGTERM, so that a hung provider can't wedge a worker slot.

**Gates and bouncing**

25. As a developer, I want the orchestrator — never the agent — to execute all Evidence Gates (artifact, artifact-lint, branch-recorded, suite, pr-fresh, demo-fresh, dogfood-green) plus every AC check, so that results cannot be self-reported.
26. As a developer, I want gate skips to be fact-driven (ticket type, repo config) and rendered as "n/a", never green, so that a skip can't masquerade as a pass.
27. As a developer, I want the whole battery to run even after the first failure and bounce once with the full batch of follow-up ACs, so that one bounce cycle carries maximum diagnostic value.
28. As a developer, I want a bounced Ticket's next Run fed a deterministic Bounce Report (failed criteria, check output excerpts, evidence pointers, my notes verbatim), so that failure context transfers without LLM summarization.
29. As a developer, I want a Ticket parked in Human Review after 3 bounces (or 3 crashes) with its arrival-by-cap clearly flagged, so that spec-shaped failures reach me instead of looping forever.

**Review wizard**

30. As a reviewer, I want a six-step wizard (Visual Recap, Dogfood Report, Pull Request, Documentation & Artifacts, Manual Walkthrough, Final Verdict) with pass/fail/skip per step, so that review is a guided walk, not a scavenger hunt.
31. As a reviewer, I want the wizard chrome to render the meta header and verification badge row live from ticket/run/git data and gate results — never from agent-authored content — so that status can't be faked or go stale.
32. As a reviewer, I want the Visual Recap rendered in a sandboxed iframe, so that agent-authored HTML can't touch the app.
33. As a reviewer, I want the Dogfood Report's "Decisions for a human" surfaced in its step for me to answer, so that open questions reach me at the veto point instead of blocking the factory.
34. As a reviewer, I want the Manual Walkthrough to start/link the Preview Environment (system browser, live status, log tail on failure) with the ACs as my checklist and the demo video beside it, so that I can verify human-routed criteria by hand.
35. As a reviewer, I want failing any step to require a written note that lands verbatim in the follow-up AC and the Bounce Report, so that the next Run knows exactly what I objected to.
36. As a reviewer, I want the Final Verdict to re-check freshness (pr-fresh, branch-recorded, mergeability) before offering merge, and to block with a re-verify/force-merge choice on drift, so that the merge always matches what I reviewed.
37. As a reviewer, I want Done to merge the PR via GitHub, so that verdicts have real effect.
38. As a reviewer, I want a park-by-cap arrival to show explicit "missing — arrived via bounce cap" placeholders for absent artifacts, so that I'm never staring at a silently blank panel.

**Previews, hygiene, projects**

39. As a developer, I want per-Repo preview config (command, `ui`/`api` kind, optional readiness path) with `$PORT` injected and deterministic port allocation, so that any repo can offer a walkable preview without per-ticket setup.
40. As a developer, I want preview processes started on demand and stopped on verdict submit and app quit, so that previews never accumulate as stray processes.
41. As a developer, I want a Done-column sweep that reaps worktrees and preview records only behind a merged-and-artifacts-persisted predicate — listing anything skipped with the reason — so that disk cleanup can never destroy evidence.
42. As a developer, I want to register Projects with one or more Repos (path, GitHub remote, target branch, preview config, optional Persona file), so that Tracker works against any repo without hardcoding.
43. As a developer, I want app-level provider config (binary path, pinned model, extra env) per provider, so that runs are reproducible and Kiro's model router stays pinned off `auto`.

## Implementation Decisions

- **Stack**: TypeScript throughout. Electron app; the orchestrator, store, and a localhost Hono HTTP/SSE server run in the main process; a React renderer talks HTTP/SSE to it. No bespoke IPC. Factory runs only while the app runs; Electron's single-instance lock guarantees one orchestrator.
- **States**: Backlog → Todo → In Progress → Verifying → Human Review → Done. Failed gates or failed review bounce to In Progress with follow-up criteria; crashes return to Todo; 3 bounces or 3 crashes park in Human Review.
- **Store**: SQLite in app data. Mutable state rows are canonical; the Audit Trail is an append-only `events` side effect of every mutation (no event sourcing). Run is first-class: claim = Run creation; phase executions, gate results, and artifacts hang off the Run; worktree belongs to the Run, branch and PR belong to the Ticket. ACs are rows with status/origin/provenance/waive-reason; follow-ups are new rows; on a new Run, failed and machine-verified reset to pending, human-verified and waived persist. Ticket identity is Tracker's own `TRK-<n>` (ADR-0002); external trackers are references only. Blobs live on disk under app data; the DB holds pointers with content hash and the worktree HEAD SHA at persist time.
- **Workflows are data** (ADR-0001): node/edge graphs (nodes: trigger and agent-phase, with name, prompt template, gate requirements; edges with nullable condition labels). The engine is a dumb interpreter: run node, walk the single unlabeled outgoing edge. The seed — trigger → research → plan → implement → dogfood → document — is seed data, not engine shape.
- **Phase Contract**: fresh provider session per phase; context travels as files; each phase must write `kb/<phase>.md`; completion = provider success signal AND contract file exists. Templates receive a fixed variable set (ticket fields, ACs with statuses, target branch, prior kb paths; plus follow-ups and Bounce Report path on re-entry). Plan-phase completion additionally requires the AC-check manifest to cover every pending AC.
- **Gates live orchestrator-side, outside the graph** (ADR-0003). Seven gates plus AC checks; skips fact-driven; battery is diagnostic (runs everything, bounces once with the batch). The agent authors AC check scripts; the orchestrator executes them — exit 0 verifies, non-zero fails. Waives are human-only, reasoned, forward-acting, and never rescue a mid-flight Verifying.
- **Provider abstraction** (from the three headless-interface research docs + prototype): a TS interface in the main process, one adapter per provider — Claude Code via `-p` stream-json NDJSON (tolerant parser), Kiro via ACP JSON-RPC over stdio, Copilot via the official SDK wrapped in a Tracker-owned subprocess emitting normalized NDJSON. Full-trust permission postures; containment = worktree isolation + Human Review veto. Uniform cancellation by SIGTERM (Kiro: ACP cancel first). Exactly three capability flags: `costReporting`, `streamsPartialText`, `emitsThinking`. The interface shape (from the research/prototype work):

  ```ts
  Provider.runPhase(prompt, cwd, opts) → { events: AsyncIterable<AgentEvent>, done: Promise<RunResult> }
  // RunResult: { outcome: completed|failed|cancelled|crashed, failureReason?, providerSessionId?, costUsd?, usage? }
  ```
- **Worktrees**: Tracker-owned bare clone per Repo in app data; worktrees keyed by ticket (`<repo>--<trk-id>`), cut on first claim, reused as-is on re-claim (fetch only — no reset, no rebase; a tree-state summary goes into the Bounce Report). Branch = conventional-commit type + external-ref id, TRK fallback. `kb/` and `checks/` go in the worktree's `.git/info/exclude` so nothing workflow-generated reaches the PR. No leases — the startup sweep crashes orphans. Teardown only via the Done-column sweep predicate.
- **Previews**: one PreviewManager, three consumers (dogfood phase, demo recording, wizard Manual Walkthrough). Runs from the ticket's worktree at `localhost:<port>` (preferred `4000 + n % 1000`, probe up); TCP-open readiness with optional HTTP path override; `failed` captures stdout/stderr. Demo = per-ticket Playwright spec with `recordVideo` for `ui` repos, curl-script transcript for `api` repos.
- **Artifacts**: Visual Recap is agent-authored self-contained HTML per the vendored authoring spec (wizard renders meta/badges live; sandboxed iframe; `artifact-lint` hard-fails only external resources and a missing "What to review"). Dogfood Report is templated markdown plus `dogfood-results.json` against the vendored matrix schema; `dogfood-green` requires every scenario pass/fixed/waived; open "Decisions for a human" never gate. Prototype prompt assets (recap spec, dogfood SKILL/template/governor, matrix schema) are vendored and adapted, not ported as code.
- **Renderer shape** (won by prototype, branch `prototype/renderer-ui` — reference, don't port): six-column kanban; ticket detail as right slide-over drawer; review wizard as centered modal with horizontal stepper; wizard step content as one shared component set; phase bar on in-progress cards; provider picker on the Backlog card at promotion.
- **API/SSE contract** (drafted in the prototype's typed events module): REST for projects/repos/tickets/ACs/runs/artifacts/provider config plus promotion and verdict actions; two SSE streams — app-wide `/api/events` (`ticket.updated`, `run.created`, `run.phase_changed`, `gate.result`, `ac.updated`, `run.ended`, `audit.appended` with monotonic seq for Last-Event-ID resume, `preview.status`) and per-run `/api/runs/:id/log` (`block.open` / `block.delta` / `block.close` over a prompt/thinking/text/tool_call/tool_result block union).

## Testing Decisions

- **A good test drives external behavior through the highest seam and asserts observable outcomes** — ticket states, AC rows, gate results, audit events, files on disk, merged branches — never internal call sequences or module internals.
- **Primary seam: the Hono HTTP/SSE API.** Black-box lifecycle tests drive file → promote → claim → phases → gates → bounce → review verdict → merge over HTTP with real SQLite, real git worktrees against scratch repos, and real gate execution, asserting via API reads plus a subscribed SSE client that sees every transition.
- **Fakes at exactly two boundaries:**
  - **FakeProvider** implementing the Provider interface, scripted per-test to write `kb/` files, `checks/` scripts, and commits — or to misbehave (omit the contract file, crash, hang) for crash-policy and gate-failure tests.
  - **GitHubPort** — one new seam wrapping branch-recorded/pr-fresh/mergeability/PR create+merge; production backs it with `gh`, tests back it with a local bare "remote" plus in-memory PR state.
- **Real provider adapters** get thin contract tests apart from the loop: run a scripted prompt in a scratch dir, assert the normalized event sequence shape and RunResult (skippable in CI where the CLIs are absent).
- **Module-level tests only where the API can't reach the edge cases cheaply**: worktree manager against a real scratch repo (create / re-claim / sweep-predicate / orphan-reap), PreviewManager with scratch `ui` and `api` repos (readiness, port-conflict fallback, teardown), gate implementations (`artifact-lint` rules, schema validation, `dogfood-green` roll-up).
- **Prior art**: none — the repo is a greenfield Electron scaffold; these tests establish the house style.

## Out of Scope

Per the map: multi-user; external tracker sync (references only — `external_ref` leaves the door open); chat-based ticket intake; repo adapters / non-GitHub forges; the workflow builder UI (workflows are data from day one, but authoring is a future effort); porting any prototype code (reference only). Deferred fog, not in this spec: recurring agent templates and auto-assign; stats/analytics views (including the factory-view worker lanes from prototype Variant C); ticket templates; throttling beyond the fixed 3-worker cap; notifications; orchestrator surviving app quit; preview infra beyond v1 (proxy hostnames, HTTPS, standing environments, previews management page); additional phase libraries; demo recording moving into the dogfood phase; paper cuts auto-drafting Backlog tickets.

## Further Notes

- This spec is sliced into vertical tracer-bullet tickets 22–42 (via /to-tickets, 2026-07-18), starting at [22 Headless skeleton](22-headless-skeleton.md); each slice's body carries its blockers and acceptance criteria. The earlier horizontal module tickets 14–20 are closed as superseded. [13 e2e proof](13-e2e-proof.md) is the acceptance test for the whole spec: one real ticket, hands-off, every criterion verified or waived — closing it closes the map.
- Primary sources: prototype UI branch `prototype/renderer-ui` (three variants + typed SSE draft), research branches `research/claude-code-headless`, `research/kiro-cli-headless`, `research/copilot-cli-headless`, `research/demo-video-recording`, and the reference prototype at `~/Downloads/tracker` (behavior spec only).
- Concurrency is capped at 3 workers because 5 melted the CPU on the reference machine.
