export const PROVIDERS = ["claude-code", "kiro", "copilot"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * App-level adapter config (ticket 38): how to reach a provider on this
 * machine and which model it is pinned to. Shared by every Project; see
 * migration 15 in db.ts for why the scope is app-level and not per-ticket.
 */
export interface ProviderConfig {
  provider: ProviderName;
  /** Absolute path to the CLI; null = resolve the usual name on PATH. */
  binaryPath: string | null;
  /** Pinned model; null = whatever the provider defaults to. */
  model: string | null;
  /** Native spend cap per phase; null = uncapped by the provider. */
  maxBudgetUsd: number | null;
  /** Extra environment for the adapter's child process. */
  env: Record<string, string>;
}

export interface Project {
  id: number;
  name: string;
  ticketPrefix: string;
  defaultProvider: ProviderName;
  /** The one Workflow every Ticket on this board runs (selected by reference). */
  workflowId: number;
  /** Archived off Home's recents (recoverable); null = visible. */
  hiddenAt: string | null;
  /** Soft-deleted: out of every listing, row kept for references. */
  deletedAt: string | null;
  createdAt: string;
}

/**
 * Home's recents row: the Project plus the display/sort facts the list view
 * needs, derived at list time (neither is a projects column).
 */
export interface ProjectListItem extends Project {
  /** Latest Audit Trail event's time; null = nothing since creation. */
  lastActivityAt: string | null;
  /** First registered Repo's checkout path; null = no repo yet. */
  repoPath: string | null;
}

export type PreviewKind = "ui" | "api";

export interface Repo {
  id: number;
  projectId: number;
  path: string;
  githubRemote: string;
  targetBranch: string;
  // Preview config exists from registration onward but is unused until slice 34.
  previewCommand: string | null;
  previewKind: PreviewKind | null;
  previewReadinessPath: string | null;
  /** Readiness deadline override in ms; null = the 60s default (ticket 10). */
  previewReadinessTimeoutMs: number | null;
  /** What the suite gate runs in the worktree; null = no suite → skip. */
  testCommand: string | null;
  /**
   * Worktree-relative path to the dogfood Persona markdown (ticket 11 §2);
   * null = no persona → the experiential judge is skipped, never faked.
   */
  personaPath: string | null;
  createdAt: string;
}

/**
 * Where a Ticket's preview process stands. Starting and ready describe a
 * live process; failed keeps the log pointer so the wizard can surface the
 * captured output; stopped is both "never started" after a sweep and the
 * clean end of a verdict or app quit.
 */
export type PreviewStatus = "starting" | "ready" | "failed" | "stopped";

/** The per-Ticket preview record (ticket 34): port, status, log pointer. */
export interface PreviewRecord {
  id: number;
  ticketId: number;
  /** The actually-bound port — the deterministic preference may be taken. */
  port: number | null;
  status: PreviewStatus;
  /** Combined stdout+stderr, relative to the app-data directory. */
  logPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TicketState =
  | "backlog"
  | "todo"
  | "in_progress"
  | "verifying"
  | "human_review"
  | "done";

export interface Ticket {
  id: number;
  projectId: number;
  /** The immutable per-project number behind displayKey (ADR-0002); also
   * seeds the deterministic preview port (ticket 34). */
  number: number;
  displayKey: string;
  title: string;
  description: string;
  state: TicketState;
  /** Null until promotion; promotion targets exactly one Repo. */
  repoId: number | null;
  /** Null until promotion; picked per-ticket, defaulted from the Project. */
  provider: ProviderName | null;
  /** Optional link to the same work item in an outside tracker (ADR-0002). */
  externalRef: string | null;
  /**
   * Set on first claim and recorded here at creation — the DB row, never
   * the branch-name string, is the source of identity.
   */
  branch: string | null;
  /**
   * The branch's PR, recorded when the orchestrator first observes it on the
   * remote (never self-reported by the agent). Stable across bounces.
   */
  prNumber: number | null;
  prUrl: string | null;
  /** Failed battery cycles so far; the third parks the ticket (ticket 06 §6). */
  bounceCount: number;
  /** True when the ticket reached Human Review by bounce cap, not by passing gates. */
  arrivedByCap: boolean;
  createdAt: string;
  updatedAt: string;
}

/** "failed" is legacy — see PhaseState; runs now end completed or crashed. */
export type RunState = "running" | "completed" | "failed" | "crashed";

/** A single agent attempt at a Ticket: claim = Run creation (ticket 08). */
export interface Run {
  id: number;
  ticketId: number;
  state: RunState;
  /** The workflow version current at claim — pinned for the Run's whole life (ADR-0004). */
  workflowVersionId: number;
  /** Null between claim and the worktree coming up. */
  worktreePath: string | null;
  crashReason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export type WorkflowNodeType = "trigger" | "agent_phase";

/**
 * A Workflow's identity (ADR-0004): what Projects reference and the library
 * lists. Content lives on immutable versions — see WorkflowGraph.
 */
export interface Workflow {
  id: number;
  name: string;
  /** Identity metadata like name (ticket 51); empty = not written yet. */
  description: string;
  /** Appearance (null = derived from name): a hex color and a renderer icon
   *  name. The server stores both as opaque strings. */
  color: string | null;
  icon: string | null;
  /** Removed from selection but still driving Projects that reference it. */
  archived: boolean;
  /** Preselected at Project creation; exactly one active default at all times. */
  isDefault: boolean;
  /** Soft-deleted: out of every listing, row kept so run history resolves. */
  deletedAt: string | null;
  createdAt: string;
}

/** The library listing's row: identity plus what the head version looks like. */
export interface WorkflowListing extends Workflow {
  /** Head version number — what a Project's next claim would pin. */
  version: number;
  /** Agent-phase names of the head version, in graph walk order. */
  phases: string[];
  usedByProjects: number;
  /**
   * Delete would succeed: not the default and no project currently selects
   * it. Never-used workflows hard-delete; anything with run history
   * soft-deletes (the row stays so pinned versions resolve).
   */
  deletable: boolean;
  /** Unpublished changes: a Draft exists (ticket 47), invisible to claims. */
  hasDraft: boolean;
}

/**
 * The Steps taxonomy (ticket 47, from Prototype A): classifies a Step for
 * the builder UI; it never changes how the engine executes.
 */
export const WORKFLOW_STEP_TYPES = [
  "search-global",
  "search-project",
  "search-code",
  "search-web",
  "action",
  "author",
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * A typed, ordered prompt fragment inside a Stage (CONTEXT.md: authoring
 * structure, not runtime machinery). Versioned content like nodes and edges.
 */
export interface WorkflowStep {
  id: number;
  nodeId: number;
  position: number;
  type: WorkflowStepType;
  title: string;
  prompt: string;
}

/** Workflows are node/edge graphs, never ordered lists (ADR-0001). */
export interface WorkflowNode {
  id: number;
  workflowVersionId: number;
  type: WorkflowNodeType;
  name: string;
  promptTemplate: string | null;
  /** Extended Phase Contract: this node must emit AC checks (ticket 07 §4). */
  emitsChecks: boolean;
  /**
   * The dogfood phase (ticket 36): the engine boots the ticket's Preview
   * Environment before this node runs and injects the live URL + persona +
   * vendored dogfood playbook into its prompt through the template variables.
   */
  bootsPreview: boolean;
  /**
   * Worktree-relative artifacts this node owes beyond its contract file
   * (e.g. kb/recap.html); the artifact gate checks their existence.
   */
  gateRequirements: string[];
  /** The Stage's ordered Steps (ticket 47); empty on pre-Steps versions. */
  steps: WorkflowStep[];
}

export interface WorkflowEdge {
  id: number;
  workflowVersionId: number;
  fromNodeId: number;
  toNodeId: number;
  conditionLabel: string | null;
}

/** One immutable version's content: what a Run's pinned id resolves to. */
export interface WorkflowGraph {
  /** The version row's id — what runs.workflow_version_id points at. */
  versionId: number;
  workflowId: number;
  version: number;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * The Draft's graph (ticket 47): the mutable editing layer over immutable
 * versions. Nodes carry string keys, not row ids — a draft node may not
 * exist anywhere yet; publish materializes keys into fresh node rows.
 */
export interface DraftStep {
  type: WorkflowStepType;
  title: string;
  prompt: string;
}

export interface DraftNode {
  /** Draft-local identity; stable across edits, meaningless after publish. */
  key: string;
  type: WorkflowNodeType;
  name: string;
  promptTemplate: string | null;
  emitsChecks: boolean;
  bootsPreview: boolean;
  gateRequirements: string[];
  steps: DraftStep[];
}

export interface DraftEdge {
  from: string;
  to: string;
  conditionLabel: string | null;
}

export interface DraftGraph {
  nodes: DraftNode[];
  edges: DraftEdge[];
}

/**
 * A Workflow's one mutable Draft (CONTEXT.md): created from the head
 * version on first edit, invisible to claims, gone on publish or discard.
 */
export interface WorkflowDraft {
  workflowId: number;
  /** The head version number the draft was cut from. */
  baseVersion: number;
  graph: DraftGraph;
  createdAt: string;
  updatedAt: string;
}

/**
 * The head version's content in Draft shape (ticket 48): what the canvas
 * editor renders before any edit exists. Read-only by construction — unlike
 * GET /draft, reading the head never creates anything.
 */
export interface WorkflowHeadGraph {
  workflowId: number;
  version: number;
  hasDraft: boolean;
  graph: DraftGraph;
}

/**
 * One publish-validator violation (ticket 47). The validator always returns
 * the full list, never first-failure; nodeKey/edgeIndex anchor the message
 * to the offending element so the editor can render it in place.
 */
export interface DraftViolation {
  rule:
    | "trigger"
    | "orphan"
    | "cycle"
    | "mixed-edges"
    | "duplicate-label"
    | "uncovered-path"
    | "duplicate-name"
    | "empty-prompt";
  message: string;
  nodeKey?: string;
  edgeIndex?: number;
}

/**
 * How a phase died (ticket 41): every mode is detected and audited
 * distinctly, and all of them feed the same policy — retry once, then the
 * Run crashes. Crash = work didn't happen → Todo; bounce = work was wrong →
 * In Progress, and only the gate battery gets to say "wrong."
 *
 * - crash: the provider process crashed or its stream broke
 * - non-zero-exit: the provider exited reporting failure
 * - hollow-exit: a clean exit that never wrote the contract file
 * - contract-breach: contract file present but its extended obligations
 *   unmet (check manifest, branch outcome declaration) — slice 26's open
 *   question, settled here: contract violations are deaths, not "wrong work"
 * - silence: no output for the silence window; the orchestrator killed it
 * - timeout: the per-phase wall clock expired; the orchestrator SIGTERMed it
 * - orphan: the app died over it; the startup sweep reaped it
 */
export type DeathMode =
  | "crash"
  | "non-zero-exit"
  | "hollow-exit"
  | "contract-breach"
  | "silence"
  | "timeout"
  | "orphan";

/** "failed" is legacy: rows predating ticket 41, when the engine judged work
 * wrong itself. Nothing writes it now — deaths crash, the battery bounces. */
export type PhaseState = "running" | "completed" | "failed" | "crashed";

/** One phase attempt inside a Run; history is append-only per Run. */
export interface PhaseExecution {
  id: number;
  runId: number;
  nodeId: number;
  phase: string;
  state: PhaseState;
  failureReason: string | null;
  /**
   * The edge label this phase declared when its node branches (ADR-0001);
   * null for the single-unlabeled-edge nodes of a v1 linear graph.
   */
  outcome: string | null;
  /** The provider's own session id, when it reports one. */
  providerSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * A pointer to a blob persisted under app data at run end. The row carries a
 * content hash and the worktree HEAD SHA at persist time; the blob survives
 * pass, bounce, and crash alike (spec: evidence survives failed attempts).
 */
export interface Artifact {
  id: number;
  runId: number;
  kind: string;
  name: string;
  /** Storage path relative to the app-data directory. */
  path: string;
  contentHash: string;
  worktreeHeadSha: string;
  createdAt: string;
}

/**
 * One gate execution against a Run. Skip means "not applicable" — determined
 * by facts (ticket type, repo config), never by the agent — and is distinct
 * from pass. AC checks carry the criterion they verify in acId.
 */
export type GateStatus = "pass" | "fail" | "skip";

export interface GateResult {
  id: number;
  runId: number;
  gate: string;
  status: GateStatus;
  detail: Record<string, unknown>;
  acId: number | null;
  createdAt: string;
}

/**
 * What a re-claim inherits, captured at bounce time because nothing resets
 * the worktree (ticket 08): recorded in the bounce event and Bounce Report.
 */
export interface TreeState {
  branch: string;
  aheadBy: number;
  dirtyCount: number;
}

/** A Follow-up Criterion about to be born from a failed gate (ticket 06 §5). */
export interface FollowUpSeed {
  gate: string;
  text: string;
}

/** The review wizard's six steps (ticket 12, Variant A); the verdict route
 * validates step marks against this roster — an API caller can't mint
 * follow-ups under a step name the wizard never shows. */
export const REVIEW_STEP_KEYS = [
  "recap",
  "dogfood",
  "pr",
  "docs",
  "walkthrough",
  "verdict",
] as const;
export type ReviewStepKey = (typeof REVIEW_STEP_KEYS)[number];

/**
 * One wizard step's mark as submitted with a review verdict (ticket 33).
 * A "fail" must carry the reviewer's written note — the note becomes a
 * Follow-up Criterion verbatim, so a fail without one is refused.
 */
export interface ReviewStepMark {
  step: ReviewStepKey;
  status: "pass" | "fail" | "skip";
  note?: string;
}

/** Why a Human Review ticket bounced: the review failed, or drifted evidence needs re-earning. */
export type ReviewBounceReason = "review-fail" | "stale-evidence";

export interface RunWithPhases extends Run {
  phases: PhaseExecution[];
  artifacts: Artifact[];
  gateResults: GateResult[];
}

export type AcStatus = "pending" | "verified" | "failed" | "waived";
export type AcOrigin = "original" | "gate-fail" | "review-fail";
/** Who settled the AC: an orchestrator-run check, or a human (wizard/waive). */
export type AcProvenance = "machine" | "human";

export interface AcceptanceCriterion {
  id: number;
  ticketId: number;
  text: string;
  position: number;
  status: AcStatus;
  origin: AcOrigin;
  provenance: AcProvenance | null;
  /** The human's mandatory reason; only ever set on a waived AC. */
  waiveReason: string | null;
  /** How the battery verifies this AC; null until a plan phase registers one. */
  check: AcCheck | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The registered verification for an AC (ticket 07 §4): a script the
 * orchestrator executes (exit 0 = verified), or a routing to the Manual
 * Walkthrough with the plan phase's one-line reason. One row per AC —
 * re-registration on a later Run updates in place.
 */
export interface AcCheck {
  id: number;
  acId: number;
  /** The Run whose plan phase registered (or last re-registered) it. */
  runId: number;
  kind: "script" | "human";
  /** Worktree-relative, e.g. `checks/ac-3.sh`; null for human routings. */
  scriptPath: string | null;
  /** Why a machine can't check this; null for scripts. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketWithAcs extends Ticket {
  acceptanceCriteria: AcceptanceCriterion[];
}

export type Actor = "human" | "agent";

export interface AuditEvent {
  id: number;
  projectId: number | null;
  ticketId: number | null;
  actor: Actor;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
