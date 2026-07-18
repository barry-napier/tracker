# Workflow engine design

Type: grilling
Status: closed
Assignee: Barry Napier (session 2026-07-18)
Resolved: 2026-07-18
Blocked by: 05

## Question

How does the orchestrator interpret a workflow? Workflows are data (decided at charting); this ticket designs the interpreter: one provider session per phase vs one session driven through phases; what each phase's prompt template receives (ticket body, ACs, prior-phase outputs, follow-up criteria on re-entry); how phase completion is detected and recorded to the ledger; how the plan phase emits machine-checkable AC checks; how bounce-backs re-enter the workflow (full restart vs resume at implement); and failure handling when a provider session dies mid-phase.

Input from issue 05's resolution (2026-07-18): schema is fixed — `workflow_nodes` + `workflow_edges` (condition labels on edges), `runs`, `phase_executions` (with a provider session id column for resume). The prototype DB shows its real phase sequence ran finer-grained than the seeded default (research → implement → review → thermo-audit → ci-check → verify-scope/analyze/matrix/serve/execute/report, plus a `resuming` phase on re-entry that jumped straight back to the failed phase) — decide whether v1's seeded default absorbs any of that.

Design constraint from charting (2026-07-18): the future workflow builder (out of scope here) is a Lindy-style node-graph editor — triggers, actions, conditions, loops, agent steps. The v1 engine only interprets the linear seeded default, but the workflow data model should be a graph (nodes + edges) or at least not preclude one, so the builder doesn't force a schema migration.

## Resolution (2026-07-18)

The engine is a dumb interpreter over workflow data: start at the trigger, run each node, walk the single unlabeled outgoing edge (v1). The five-phase seed (trigger → research → plan → implement → review → document) is seed data — one workflow of many, not the engine's shape. Workflows perform the work and produce evidence artifacts; verification of outcome belongs to the orchestrator ([ADR-0003](../../docs/adr/0003-gates-outside-the-workflow-graph.md)).

1. **Fresh session per phase, explicit file handoff.** Each phase spawns a new provider session. Context travels as files: every phase must write `kb/<phase-name>.md` in the worktree (the Phase Contract). Session resume is a provider capability/optimization, never required — Copilot can't do it reliably. `phase_executions.provider_session_id` still recorded per phase.
2. **Fixed template variable set** (the engine's API to templates): ticket title/body/key-info, ACs with current statuses, repo target branch, prior phases' `kb/` file paths; on re-entry additionally follow-up criteria and the bounce report path.
3. **Phase completion = provider success signal AND contract file exists.** Either missing → phase failed. Recorded to `phase_executions.outcome` + ledger event. No per-phase LLM judging — hollow output is caught by the gate battery.
4. **Plan phase emits AC checks:** one executable per machine-checkable AC (`checks/ac-<id>.sh`, exit 0 = verified) plus `checks/manifest.json` mapping every pending AC to a script or `"human"` + one-line reason (routes to Manual Walkthrough). Plan-phase completion additionally requires manifest coverage of every pending AC. `"human"` routing is a proposal — the reviewer can still fail the AC in the wizard.
5. **Seeded default absorbs none of the prototype's verify-* phases** (thermo-audit, ci-check, verify-scope/…): those predate the gate battery and are its job now. `resuming` is re-entry mechanics, not a node.
6. **Bounce re-entry = fresh run, full workflow.** Worktree/branch/commits persist; templates receive the bounce context and the agent plans the delta (research on re-entry ≈ read bounce report + git log). Re-running plan re-validates AC-check coverage against the updated AC set — no re-entry-point config needed, works for any user-built workflow.
7. **Bounce Report:** on bounce, the orchestrator deterministically renders `kb/bounce-<n>.md` (also a run artifact) from structured data: per failed AC — criterion, check script, last ~50 lines of output (full log linked), evidence pointer; per failed gate — key + detail; human reviewer feedback verbatim; pointers to prior run's kb/ artifacts and the branch. No LLM summarization. **Constraint flowed to ticket 12:** wizard fail steps must require a reviewer note.
8. **Crash policy (distinct from bounce):** phase death (crash, non-zero exit, clean exit without contract file, or 15 min output silence → kill) retries the phase once (phases are idempotent); second failure ends the run `crashed` → ticket returns to **Todo** with no new criteria (bounce = work was wrong → In Progress; crash = work didn't happen → Todo). 3 crashed runs park the ticket in Human Review, mirroring the 3-bounce cap.

New ubiquitous-language terms (added to `CONTEXT.md`): **Phase Contract**, **Bounce Report**.
