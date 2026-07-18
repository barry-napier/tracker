// PROTOTYPE — throwaway (wayfinder ticket 12). In-memory fixture data.
import type {
  AcRow,
  Phase,
  Provider,
  TicketSnapshot,
  TicketState,
} from "./events";

export interface RunFixture {
  id: string;
  ticketId: string;
  provider: Provider;
  phase: Phase | null; // current phase while running
  phasesDone: Phase[];
  gateResults: { gate: string; result: "pass" | "fail" | "skip"; detail: string | null }[];
  artifacts: { name: string; kind: "recap" | "dogfood" | "kb" | "video" | "bounce-report"; sha: string }[];
  prUrl: string | null;
  prNumber: number | null;
}

export interface AuditEvent {
  seq: number;
  ticketId: string;
  actor: string;
  eventType: string;
  detail: string;
  at: string;
}

export const PROVIDERS: Provider[] = ["claude-code", "kiro", "copilot"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  "claude-code": "Claude Code",
  kiro: "Kiro",
  copilot: "Copilot",
};

export const STATES: { key: TicketState; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "Todo" },
  { key: "in_progress", label: "In Progress" },
  { key: "verifying", label: "Verifying" },
  { key: "human_review", label: "Human Review" },
  { key: "done", label: "Done" },
];

export const PHASES: Phase[] = ["research", "plan", "implement", "dogfood", "document"];

export const tickets: TicketSnapshot[] = [
  { id: "TRK-31", projectId: "p1", repoId: null, title: "Add CSV export to claims table", state: "backlog", provider: null, currentRunId: null },
  { id: "TRK-32", projectId: "p1", repoId: null, title: "Rate-limit the webhook endpoint", state: "backlog", provider: null, currentRunId: null },
  { id: "TRK-28", projectId: "p1", repoId: "r1", title: "Fix pagination off-by-one on /claims", state: "todo", provider: "claude-code", currentRunId: null },
  { id: "TRK-29", projectId: "p1", repoId: "r1", title: "Dark mode for settings screen", state: "todo", provider: "kiro", currentRunId: null },
  { id: "TRK-25", projectId: "p1", repoId: "r1", title: "Add audit log filtering by actor", state: "in_progress", provider: "claude-code", currentRunId: "run-25a" },
  { id: "TRK-26", projectId: "p1", repoId: "r2", title: "Retry logic for S3 uploads", state: "in_progress", provider: "copilot", currentRunId: "run-26a" },
  { id: "TRK-24", projectId: "p1", repoId: "r1", title: "Bulk-assign adjusters from list view", state: "verifying", provider: "claude-code", currentRunId: "run-24b" },
  { id: "TRK-21", projectId: "p1", repoId: "r1", title: "Inline claim-note editing", state: "human_review", provider: "claude-code", currentRunId: "run-21b" },
  { id: "TRK-22", projectId: "p1", repoId: "r2", title: "Health endpoint with dependency checks", state: "human_review", provider: "kiro", currentRunId: "run-22a" },
  { id: "TRK-18", projectId: "p1", repoId: "r1", title: "Sortable columns on claims table", state: "done", provider: "claude-code", currentRunId: "run-18a" },
  { id: "TRK-19", projectId: "p1", repoId: "r1", title: "Empty-state illustrations", state: "done", provider: "copilot", currentRunId: "run-19a" },
];

export const acRows: AcRow[] = [
  { id: "ac-1", ticketId: "TRK-21", text: "Double-clicking a claim note opens an inline editor", status: "verified", provenance: "machine", followUpOf: null },
  { id: "ac-2", ticketId: "TRK-21", text: "Escape cancels the edit without saving", status: "verified", provenance: "machine", followUpOf: null },
  { id: "ac-3", ticketId: "TRK-21", text: "Edit conflict shows a merge banner, never silently overwrites", status: "pending", provenance: null, followUpOf: null },
  { id: "ac-4", ticketId: "TRK-21", text: "Screen-reader announces edit mode", status: "waived", provenance: "human", followUpOf: null },
  { id: "ac-5", ticketId: "TRK-21", text: "Note history preserved after inline edit (follow-up from bounce 1)", status: "verified", provenance: "machine", followUpOf: "ac-1" },
  { id: "ac-6", ticketId: "TRK-25", text: "Actor filter accepts multiple selections", status: "pending", provenance: null, followUpOf: null },
  { id: "ac-7", ticketId: "TRK-25", text: "Filter state survives page reload", status: "pending", provenance: null, followUpOf: null },
  { id: "ac-8", ticketId: "TRK-22", text: "GET /health returns per-dependency status", status: "verified", provenance: "machine", followUpOf: null },
  { id: "ac-9", ticketId: "TRK-22", text: "Degraded dependency yields 200 with warning, hard-down yields 503", status: "pending", provenance: null, followUpOf: null },
];

export const runs: RunFixture[] = [
  {
    id: "run-25a", ticketId: "TRK-25", provider: "claude-code", phase: "implement",
    phasesDone: ["research", "plan"],
    gateResults: [], artifacts: [{ name: "kb/research.md", kind: "kb", sha: "e41c09a" }, { name: "kb/plan.md", kind: "kb", sha: "e41c09a" }],
    prUrl: null, prNumber: null,
  },
  {
    id: "run-26a", ticketId: "TRK-26", provider: "copilot", phase: "research",
    phasesDone: [], gateResults: [], artifacts: [], prUrl: null, prNumber: null,
  },
  {
    id: "run-24b", ticketId: "TRK-24", provider: "claude-code", phase: null,
    phasesDone: ["research", "plan", "implement", "dogfood", "document"],
    gateResults: [
      { gate: "tests-pass", result: "pass", detail: "412 passed" },
      { gate: "typecheck", result: "pass", detail: null },
      { gate: "lint-clean", result: "pass", detail: null },
      { gate: "artifact", result: "pass", detail: "recap + dogfood present" },
      { gate: "artifact-lint", result: "pass", detail: null },
      { gate: "dogfood-green", result: "fail", detail: "scenario 'bulk assign 200 rows' failed: timeout" },
      { gate: "pr-fresh", result: "pass", detail: null },
      { gate: "ac:bulk-select", result: "pass", detail: null },
    ],
    artifacts: [
      { name: "visual-recap.html", kind: "recap", sha: "9c2d114" },
      { name: "dogfood-report.md", kind: "dogfood", sha: "9c2d114" },
    ],
    prUrl: "https://github.com/barry/claims-app/pull/141", prNumber: 141,
  },
  {
    id: "run-21b", ticketId: "TRK-21", provider: "claude-code", phase: null,
    phasesDone: ["research", "plan", "implement", "dogfood", "document"],
    gateResults: [
      { gate: "tests-pass", result: "pass", detail: "398 passed" },
      { gate: "typecheck", result: "pass", detail: null },
      { gate: "lint-clean", result: "pass", detail: null },
      { gate: "artifact", result: "pass", detail: null },
      { gate: "artifact-lint", result: "pass", detail: null },
      { gate: "dogfood-green", result: "pass", detail: "5 pass, 1 fixed, 0 waived" },
      { gate: "pr-fresh", result: "pass", detail: null },
      { gate: "ac:ac-1", result: "pass", detail: null },
      { gate: "ac:ac-2", result: "pass", detail: null },
      { gate: "ac:ac-5", result: "pass", detail: null },
    ],
    artifacts: [
      { name: "visual-recap.html", kind: "recap", sha: "b7a3f21" },
      { name: "dogfood-report.md", kind: "dogfood", sha: "b7a3f21" },
      { name: "demo.webm", kind: "video", sha: "b7a3f21" },
      { name: "kb/research.md", kind: "kb", sha: "b7a3f21" },
      { name: "kb/plan.md", kind: "kb", sha: "b7a3f21" },
      { name: "kb/implement.md", kind: "kb", sha: "b7a3f21" },
      { name: "kb/dogfood.md", kind: "kb", sha: "b7a3f21" },
      { name: "kb/document.md", kind: "kb", sha: "b7a3f21" },
      { name: "bounce-report.md", kind: "bounce-report", sha: "88e01dc" },
    ],
    prUrl: "https://github.com/barry/claims-app/pull/138", prNumber: 138,
  },
  {
    id: "run-22a", ticketId: "TRK-22", provider: "kiro", phase: null,
    phasesDone: ["research", "plan", "implement", "dogfood", "document"],
    gateResults: [
      { gate: "tests-pass", result: "pass", detail: "77 passed" },
      { gate: "typecheck", result: "pass", detail: null },
      { gate: "lint-clean", result: "skip", detail: "no linter configured" },
      { gate: "artifact", result: "pass", detail: null },
      { gate: "artifact-lint", result: "pass", detail: null },
      { gate: "dogfood-green", result: "pass", detail: "3 pass" },
      { gate: "pr-fresh", result: "pass", detail: null },
      { gate: "ac:ac-8", result: "pass", detail: null },
    ],
    artifacts: [
      { name: "visual-recap.html", kind: "recap", sha: "31da77b" },
      { name: "dogfood-report.md", kind: "dogfood", sha: "31da77b" },
    ],
    prUrl: "https://github.com/barry/claims-api/pull/52", prNumber: 52,
  },
  {
    id: "run-18a", ticketId: "TRK-18", provider: "claude-code", phase: null,
    phasesDone: ["research", "plan", "implement", "dogfood", "document"],
    gateResults: [], artifacts: [], prUrl: "https://github.com/barry/claims-app/pull/131", prNumber: 131,
  },
  {
    id: "run-19a", ticketId: "TRK-19", provider: "copilot", phase: null,
    phasesDone: ["research", "plan", "implement", "dogfood", "document"],
    gateResults: [], artifacts: [], prUrl: "https://github.com/barry/claims-app/pull/129", prNumber: 129,
  },
];

export const auditEvents: AuditEvent[] = [
  { seq: 101, ticketId: "TRK-21", actor: "human:barry", eventType: "ticket.filed", detail: "Filed with 4 acceptance criteria", at: "2026-07-16T09:12:00Z" },
  { seq: 102, ticketId: "TRK-21", actor: "human:barry", eventType: "ticket.promoted", detail: "Promoted to Todo · repo claims-app · provider Claude Code", at: "2026-07-16T09:14:00Z" },
  { seq: 103, ticketId: "TRK-21", actor: "worker:1", eventType: "run.claimed", detail: "Run run-21a created · worktree claims-app--TRK-21", at: "2026-07-16T09:15:00Z" },
  { seq: 110, ticketId: "TRK-21", actor: "worker:1", eventType: "gate.failed", detail: "ac:note-history failed — history rows dropped on save", at: "2026-07-16T11:40:00Z" },
  { seq: 111, ticketId: "TRK-21", actor: "worker:1", eventType: "ticket.bounced", detail: "Bounced to In Progress with 1 follow-up criterion", at: "2026-07-16T11:41:00Z" },
  { seq: 112, ticketId: "TRK-21", actor: "worker:3", eventType: "run.claimed", detail: "Run run-21b created · reusing worktree (branch ahead by 9, clean)", at: "2026-07-16T12:02:00Z" },
  { seq: 118, ticketId: "TRK-21", actor: "worker:3", eventType: "phase.completed", detail: "dogfood — 5 pass, 1 fixed (fix 4d1c2aa + regression test)", at: "2026-07-16T14:20:00Z" },
  { seq: 121, ticketId: "TRK-21", actor: "worker:3", eventType: "gates.passed", detail: "All gates green — moved to Human Review", at: "2026-07-16T14:31:00Z" },
];

export const recapHtml = `<!doctype html><html><head><style>
  body{font:14px/1.5 -apple-system,sans-serif;margin:0;padding:24px;background:#0f1115;color:#d7dae0}
  h1{font-size:18px} h2{font-size:14px;color:#8b93a7;text-transform:uppercase;letter-spacing:.05em}
  .file{background:#161a22;border:1px solid #232837;border-radius:6px;padding:10px 14px;margin:8px 0}
  .add{color:#4ade80}.del{color:#f87171} code{background:#1c2130;padding:1px 5px;border-radius:4px}
  .review{border-left:3px solid #eab308;padding-left:12px;margin-top:16px}
</style></head><body>
  <h1>Inline claim-note editing</h1>
  <p>Notes on a claim are now editable in place. Double-click swaps the read view for a
  textarea bound to the same store row; save is optimistic with rollback on 409.</p>
  <h2>Where the change lives</h2>
  <div class="file"><b>src/components/ClaimNote.tsx</b> <span class="add">+118</span> <span class="del">−12</span><br/>Read view → edit view swap, escape/save handling.</div>
  <div class="file"><b>src/store/notes.ts</b> <span class="add">+44</span> <span class="del">−3</span><br/>Optimistic update + conflict rollback, history row preserved on every edit.</div>
  <div class="file"><b>src/api/notes.ts</b> <span class="add">+19</span> <span class="del">−0</span><br/>PATCH with If-Match etag.</div>
  <h2>Risk</h2>
  <p>The conflict path. A 409 rolls back the optimistic write and raises the merge banner —
  exercised by the dogfood matrix scenario "concurrent edit".</p>
  <div class="review"><h2>What to review</h2>
  <p>1. The rollback in <code>notes.ts</code> — is restoring from the pre-edit snapshot enough, or should it refetch?<br/>
  2. History rows are written on every save (follow-up from bounce 1) — check the volume is acceptable.</p></div>
</body></html>`;

export const dogfoodMarkdown = `# Dogfood Report — TRK-21 Inline claim-note editing

Persona: claims adjuster (persona/adjuster.md)

## Scenario Matrix

| # | Journey | Result | Evidence |
|---|---------|--------|----------|
| 1 | Double-click note, edit, save | pass | screenshot 01 |
| 2 | Edit then Escape | pass | screenshot 02 |
| 3 | Concurrent edit conflict | **fixed** | fix 4d1c2aa + regression test |
| 4 | Edit 4000-char note | pass | screenshot 04 |
| 5 | Save with network offline | pass | retry banner shown |
| 6 | Keyboard-only edit flow | pass | screencast 06 |

## Paper cuts

- Save button is 1px off-baseline with the cancel link.
- No character counter on long notes.

## Decisions for a human

- Should note history rows be visible to adjusters, or admin-only? The store now
  keeps them (follow-up from bounce 1) but nothing renders them.

## Instruments

Playwright against preview localhost:4231, persona lens applied.`;

export const bounceReportMarkdown = `# Bounce Report — TRK-21, Run run-21a

## Failed criteria

### ac:note-history — "Note history preserved after inline edit"
- **Check:** checks/note-history.sh
- **Output excerpt:** \`history rows before: 3, after save: 0 — FAIL\` (full log: artifacts/run-21a/checks/note-history.log)
- **Evidence:** store/notes.ts:71 replaced the row array instead of appending.

## Reviewer feedback

(none — machine bounce)

## Prior run

- Branch feat/TRK-21-inline-note-editing @ 88e01dc
- Artifacts: artifacts/run-21a/`;
