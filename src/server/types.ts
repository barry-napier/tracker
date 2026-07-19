export const PROVIDERS = ["claude-code", "kiro", "copilot"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface Project {
  id: number;
  name: string;
  ticketPrefix: string;
  defaultProvider: ProviderName;
  createdAt: string;
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
  /** What the suite gate runs in the worktree; null = no suite → skip. */
  testCommand: string | null;
  createdAt: string;
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

export type RunState = "running" | "completed" | "failed" | "crashed";

/** A single agent attempt at a Ticket: claim = Run creation (ticket 08). */
export interface Run {
  id: number;
  ticketId: number;
  state: RunState;
  /** Null between claim and the worktree coming up. */
  worktreePath: string | null;
  crashReason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export type WorkflowNodeType = "trigger" | "agent_phase";

/** Workflows are node/edge graphs, never ordered lists (ADR-0001). */
export interface WorkflowNode {
  id: number;
  workflowId: number;
  type: WorkflowNodeType;
  name: string;
  promptTemplate: string | null;
  /** Extended Phase Contract: this node must emit AC checks (ticket 07 §4). */
  emitsChecks: boolean;
  /**
   * Worktree-relative artifacts this node owes beyond its contract file
   * (e.g. kb/recap.html); the artifact gate checks their existence.
   */
  gateRequirements: string[];
}

export interface WorkflowEdge {
  id: number;
  workflowId: number;
  fromNodeId: number;
  toNodeId: number;
  conditionLabel: string | null;
}

export interface WorkflowGraph {
  id: number;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** failed = wrong work (hollow phase, provider-reported failure); crashed = infrastructure. */
export type PhaseState = "running" | "completed" | "failed" | "crashed";

/** One phase attempt inside a Run; history is append-only per Run. */
export interface PhaseExecution {
  id: number;
  runId: number;
  nodeId: number;
  phase: string;
  state: PhaseState;
  failureReason: string | null;
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
