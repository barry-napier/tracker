# Tracker — Ubiquitous Language

Glossary for Tracker's core loop. Terms only — no implementation details.

## Terms

### Home

Tracker's entry surface: what a fresh window or new tab shows. Offers exactly two paths onto a board — open a Recent Project, or clone a repo from GitHub (which creates a new Project) — and hosts the app-global Workflow library as a view. Each opened Project occupies one tab; open tabs survive an app restart. Every Project is a Recent Project: existing in Tracker means it was worked on. Home lists them ordered by most recent board activity — "opened" is not a recorded event. Tabs from different Projects coexist in one window; opening a Project that is already open focuses its existing tab, never a duplicate.

### Project

An application being worked on through Tracker. Owns a board of Tickets and spans one or more Repos. Carries project-level defaults (e.g. default provider).

### Repo

A git repository belonging to a Project. Knows its local path, GitHub remote, target branch, and how to run itself (command, port, readiness check) for Preview Environments. A Project has many Repos, but a GitHub remote belongs to at most one Repo across all of Tracker — cloning an already-tracked repo from Home opens its existing Project rather than creating a duplicate.

### Ticket

A unit of work on a Project's board. Belongs to exactly one Project and, from promotion onward, targets exactly one Repo — one Ticket yields one branch, one PR, one merge. Work spanning multiple Repos is multiple Tickets.

### Acceptance Criterion (AC)

A single verifiable line item on a Ticket stating something that must be true for the work to be right. Lifecycle: pending → verified, failed, or waived. Verification is by machine (an agent-authored check) or by a human (Manual Walkthrough) — provenance records which. Failing any AC bounces the Ticket. Waiving is human-only and requires a reason. Follow-up Criteria are new ACs born from a failed gate or review, and are treated identically to originals. On a new Run, failed and machine-verified ACs reset to pending; human-verified and waived ACs persist.

### Evidence Gate

A machine check the orchestrator runs against a Run before a Ticket may leave Verifying. Each gate results in pass, fail, or skip — skip means "not applicable," determined by facts (ticket type, repo config), never by the agent, and is distinct from pass. The battery is diagnostic: every gate and AC check runs even after a failure, and all failures bounce the Ticket together in one batch — each failed gate births a Follow-up Criterion, while a failed AC carries itself forward by resetting to pending on the next Run. The third failed cycle parks the Ticket in Human Review instead, flagged arrived-by-cap: it reached the veto point without passing gates. Agent-authored AC checks are gates: the agent writes the check, the orchestrator executes it — results cannot be self-reported.

### External Reference

An optional link from a Ticket to the same work item in an outside tracker (Jira, Linear, GitHub Issues, markdown). Purely a reference — a Ticket's identity is always Tracker's own immutable id.

### Workflow

A named graph of phases defining *how* work on a Ticket gets done — never *whether* it gets checked (verification is the orchestrator's, always). Workflows live in a single app-level library shared across all Projects. A Project selects exactly one Workflow by reference — one Workflow may drive many Projects — chosen at Project creation and changeable later; every Ticket on the board runs the Project's Workflow. A Workflow's content is versioned and versions are immutable; a Project follows the head version, while a Run pins the version current at claim — editing a Workflow or changing a Project's selection affects future claims, never a running or past attempt. A Workflow is archived, never hard-deleted: archiving removes it from selection but it keeps driving Projects that already reference it, and is reversible. Editing happens in the Workflow's Draft — at most one per Workflow, created from the head version, invisible to claims; publishing validates the Draft and appends it as the new head, discarding throws it away.

### Stage

A node in a Workflow's graph: one unit of agent work run as a single fresh provider session under the Phase Contract. "Phase" is the legacy synonym still carried by code and the Phase Contract's name — Stage is the canonical term. A Stage owns an ordered list of Steps.

### Step

A typed, ordered prompt fragment inside a Stage — "do a web search," "search the codebase," "write the research doc." Steps are authoring structure, not runtime machinery: the orchestrator assembles a Stage's Steps into the single prompt handed to that Stage's one session. The type classifies the Step for the builder UI; it never changes how the engine executes.

### Default Workflow

The one Workflow the library designates as preselected when a Project is created. Exactly one active Workflow holds the designation at all times; archiving it requires naming a successor in the same action. The first Default Workflow is RPIRD — the standard research → plan → implement → review → document graph.

### Run

A single agent attempt at a Ticket: created when a worker claims the Ticket, ended when gates pass, the Ticket bounces, or the attempt crashes. Phase history, gate results, agent logs, and Artifacts belong to a Run, not directly to the Ticket. A bounced Ticket gets a new Run on re-claim; the latest Run is the one the review wizard reads.

### Phase Contract

What the workflow engine requires of every phase: run in a fresh provider session, receive context through the engine's fixed template variable set, and write `kb/<phase-name>.md` in the worktree before finishing. A phase completes only when the provider signals success and the contract file exists. A phase whose node has labeled outgoing edges must additionally declare its outcome in the contract file — one of the edge labels, passed in as template variables; a missing or unrecognized outcome fails the phase. The engine only ever string-matches the declared outcome to pick the edge: routing is the phase's judgment, verification never is. The plan phase's contract additionally requires AC checks: one executable per machine-checkable Acceptance Criterion plus a manifest covering every pending AC (script or human-routing with reason).

### Bounce Report

A deterministic artifact the orchestrator renders when a Ticket bounces: per failed AC or gate — the criterion, the check, an output excerpt (full log linked), and evidence pointers; human reviewer feedback verbatim; pointers to the prior Run's artifacts and branch. Written into the persisting worktree and recorded as a Run artifact, it is how failure context reaches the next Run. Never LLM-summarized — structured data first, prose rendering second.

### Visual Recap

An agent-authored, self-contained HTML page that lets the reviewer understand a change structurally — what changed, why, where the risk is — without reading the raw diff. Grounded mechanically in the diff; ends with "What to review," the notes directing the reviewer's attention. Produced by the document phase, never committed to the branch, rendered by the review wizard in a sandboxed iframe. The meta line and verification badges are wizard chrome drawn from live data, not part of the page.

### Dogfood Report

The dogfood phase's account of actually using what was built: a scenario Matrix of user journeys walked against the Preview Environment (with evidence and any governor-capped fixes recorded by SHA + regression test), paper cuts, open Decisions for a human, and the instruments used. Ships with a machine-readable results file the `dogfood-green` gate reads: any scenario not passed, fixed, or waived bounces the Ticket; open human decisions never bounce — they surface at Human Review.

### Persona

An optional per-Repo markdown file giving the dogfood phase a user's lens (e.g. a claims adjuster) for judging experience, not just function. No Persona configured → the report says the experiential judge was skipped; the lens is never faked.

### Demo

Recorded proof of the change working, captured against the running Preview Environment during the Run. The agent authors the demo — a Playwright spec for a `ui` Repo, a curl script for an `api` Repo — and the orchestrator executes it, so a demo can never be self-reported. The resulting video or transcript is a Run artifact stamped with the code it was recorded at; the `demo-fresh` Evidence Gate requires that stamp to match the branch tip, and Tickets whose type isn't user-facing owe no demo. The review wizard's Manual Walkthrough plays the video or shows the transcript beside the live preview.

### Audit Trail

The append-only record of domain events describing everything that happened to a Ticket over its life — promoted, claimed, phase transitions, gate results, bounces, verdicts, merges. Each event has an actor (human or agent worker), an event type, and event-specific detail. Events are never updated or deleted. The activity feed in the ticket detail view is the rendered form of the Audit Trail.
