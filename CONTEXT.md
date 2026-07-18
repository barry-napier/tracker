# Tracker — Ubiquitous Language

Glossary for Tracker's core loop. Terms only — no implementation details.

## Terms

### Project

An application being worked on through Tracker. Owns a board of Tickets and spans one or more Repos. Carries project-level defaults (e.g. default provider).

### Repo

A git repository belonging to a Project. Knows its local path, GitHub remote, target branch, and how to run itself (command, port, readiness check) for Preview Environments. A Project has many Repos.

### Ticket

A unit of work on a Project's board. Belongs to exactly one Project and, from promotion onward, targets exactly one Repo — one Ticket yields one branch, one PR, one merge. Work spanning multiple Repos is multiple Tickets.

### Acceptance Criterion (AC)

A single verifiable line item on a Ticket stating something that must be true for the work to be right. Lifecycle: pending → verified, failed, or waived. Verification is by machine (an agent-authored check) or by a human (Manual Walkthrough) — provenance records which. Failing any AC bounces the Ticket. Waiving is human-only and requires a reason. Follow-up Criteria are new ACs born from a failed gate or review, and are treated identically to originals. On a new Run, failed and machine-verified ACs reset to pending; human-verified and waived ACs persist.

### Evidence Gate

A machine check the orchestrator runs against a Run before a Ticket may leave Verifying. Each gate results in pass, fail, or skip — skip means "not applicable," determined by facts (ticket type, repo config), never by the agent, and is distinct from pass. The battery is diagnostic: every gate and AC check runs even after a failure, and all failures bounce the Ticket together as a batch of Follow-up Criteria. Agent-authored AC checks are gates: the agent writes the check, the orchestrator executes it — results cannot be self-reported.

### External Reference

An optional link from a Ticket to the same work item in an outside tracker (Jira, Linear, GitHub Issues, markdown). Purely a reference — a Ticket's identity is always Tracker's own immutable id.

### Run

A single agent attempt at a Ticket: created when a worker claims the Ticket, ended when gates pass, the Ticket bounces, or the attempt crashes. Phase history, gate results, agent logs, and Artifacts belong to a Run, not directly to the Ticket. A bounced Ticket gets a new Run on re-claim; the latest Run is the one the review wizard reads.

### Phase Contract

What the workflow engine requires of every phase: run in a fresh provider session, receive context through the engine's fixed template variable set, and write `kb/<phase-name>.md` in the worktree before finishing. A phase completes only when the provider signals success and the contract file exists. The plan phase's contract additionally requires AC checks: one executable per machine-checkable Acceptance Criterion plus a manifest covering every pending AC (script or human-routing with reason).

### Bounce Report

A deterministic artifact the orchestrator renders when a Ticket bounces: per failed AC or gate — the criterion, the check, an output excerpt (full log linked), and evidence pointers; human reviewer feedback verbatim; pointers to the prior Run's artifacts and branch. Written into the persisting worktree and recorded as a Run artifact, it is how failure context reaches the next Run. Never LLM-summarized — structured data first, prose rendering second.

### Audit Trail

The append-only record of domain events describing everything that happened to a Ticket over its life — promoted, claimed, phase transitions, gate results, bounces, verdicts, merges. Each event has an actor (human or agent worker), an event type, and event-specific detail. Events are never updated or deleted. The activity feed in the ticket detail view is the rendered form of the Audit Trail.
