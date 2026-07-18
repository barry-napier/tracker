# Domain model and SQLite schema

Type: grilling
Status: closed
Assignee: Barry Napier (session 2026-07-18)
Resolved: 2026-07-18

## Question

What is the domain model and SQLite schema for the core loop? Entities to pin down: projects (repo path, target branch, run config), tickets (problem, key info, acceptance criteria, screenshots/attachments, follow-up criteria), acceptance criteria as first-class rows (verified/waived state), workflows and phases as data (name, prompt template, order, gate requirements — seeded default: research→plan→implement→review→document; model as a graph or graph-compatible — see the constraint on issue 07), the event ledger (activity feed: promoted, claimed, phase transitions, gate results, bounces, merged), artifacts (recap doc, dogfood report, demo video, PR link, visual recap), evidence gate results, claims/leases for the 3-worker pool. Resolve with /domain-modeling; the answer is the ubiquitous language + schema sketch.

## Resolution (2026-07-18)

Ubiquitous language captured in repo-root `CONTEXT.md` (Project, Repo, Ticket, Run, Acceptance Criterion, External Reference, Audit Trail). Decisions, informed by examining the prototype DB (`~/Downloads/tracker/kanban/data/tracker.db`):

1. **Audit Trail is a side effect, not source of truth.** Mutable state rows are canonical; every mutation appends an event (`events`: ticket_id, nullable run_id, type, actor, JSON payload, timestamp). No event sourcing.
2. **Run is first-class.** One row per agent attempt (claim = run creation). Phase executions, gate results, transcripts, and artifacts hang off the run — fixes the prototype's latest-wins overwriting. Worktree belongs to the run; branch and PR belong to the ticket (stable across bounces).
3. **Project 1—many Repo; Ticket targets exactly one Repo.** Project = the application (board, defaults). Repo = git repository with path, GitHub remote, target branch, and run config (command, port, readiness check — feeds ticket 10). Multi-repo change = multiple tickets. repo_id nullable until promotion to Todo.
4. **Tracker owns ticket identity.** Integer PK + immutable display key from per-project prefix + counter (`TRK-12`). External trackers (Jira/Linear/GitHub Issues/markdown) are optional references (`external_system/key/url`), never identity — the prototype's DRAFT-26→AS-566 rename is the anti-pattern. Integrations themselves ruled out of scope for this map.
5. **ACs are first-class rows.** `acceptance_criteria`: ticket_id, text, position, status (pending → verified | failed | waived), origin (original / gate-fail / review-fail), provenance (agent|human, via which gate/wizard step, when), waive reason (human-only), evidence pointer. Follow-up criteria are new AC rows. On a new run: failed + machine-verified reset to pending; human-verified and waived persist.
6. **Workflows are graphs from day one.** `workflows` / `workflow_nodes` (type: trigger | agent-phase in v1; name, prompt template, gate requirements) / `workflow_edges` (from → to, nullable condition label). Conditions live on edges (per the Lindy reference: labeled branches like Approved/Not approved); multiple trigger nodes allowed. Seeded default: trigger → research → plan → implement → review → document. v1 engine walks the single unlabeled outgoing edge.
7. **Blobs on disk, DB holds pointers.** `artifacts`: run_id, kind (recap / dogfood-report / demo-video / transcript / screenshot), locator under `<app-data>/runs/<run-id>/`, content hash, size. Prototype's 500KB JSONLs-in-events is the anti-pattern.

Supporting tables: `phase_executions` (run_id, node_id, started/ended, outcome, provider session id) and `gate_results` (run_id, gate key, pass/fail/skip, detail, nullable ac_id linking agent-authored AC checks to their criterion).

Deliberately left to other tickets: lease semantics (08), gate battery (06), engine interpretation (07), previews (10), artifact document formats (11).

Prototype DB discoveries worth map notes: `intake_sessions` (chat-based ticket filing) and fine-grained verify phases (thermo-audit, ci-check, verify-*) — the latter is input to tickets 06/07.
