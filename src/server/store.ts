import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { previewPhases } from "./graph.ts";
import { branchNameFor, type WorktreeResult } from "./worktrees.ts";
import type { CheckRegistration } from "./checks.ts";
import { nextAutomationRun } from "./automation-schedule.ts";
import type {
  AcceptanceCriterion,
  AcCheck,
  Actor,
  Artifact,
  AuditEvent,
  AuthUser,
  Automation,
  AutomationCadence,
  AutomationListItem,
  AutomationPriority,
  AutomationTemplate,
  FollowUpSeed,
  GateResult,
  GateStatus,
  IntakeBreakdown,
  IntakeDraft,
  IntakeKind,
  IntakeSession,
  IntakeStatus,
  IntakeTurn,
  TicketKind,
  PhaseExecution,
  PreviewKind,
  PreviewRecord,
  PreviewStatus,
  Project,
  ProjectListItem,
  ProviderInstance,
  ProviderName,
  Repo,
  ReviewBounceReason,
  ReviewStepMark,
  Run,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
  DeathMode,
  TreeState,
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowListing,
  WorkflowNode,
  DraftGraph,
  DraftNode,
  DraftStep,
  DraftViolation,
  WorkflowDraft,
  WorkflowHeadGraph,
  WorkflowStep,
  WorkflowStepType,
} from "./types.ts";
import { WORKFLOW_STEP_TYPES } from "./types.ts";
import { validateDraftGraph } from "./workflow-validate.ts";

export type { TicketWithAcs } from "./types.ts";

export class NotFoundError extends Error {}
/** A mutation that is well-formed but illegal in the ticket's current state. */
export class StateError extends Error {}
/** A mutation whose referenced rows don't fit together (e.g. cross-project repo). */
export class ValidationError extends Error {}
/** Publish refused (ticket 47): carries the validator's full violation list. */
export class DraftInvalidError extends ValidationError {
  constructor(public readonly violations: DraftViolation[]) {
    super(
      `the draft has ${violations.length} validation ${violations.length === 1 ? "problem" : "problems"}`,
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Three failed cycles matches observed agent convergence (ticket 06 §6). */
const BOUNCE_CAP = 3;

/** Three crashed Runs park too (ticket 41), mirroring the bounce cap. */
const CRASH_CAP = 3;

/**
 * Canonical state lives in mutable rows; every mutation appends an Audit
 * Trail event as a side effect (never event sourcing — see ticket 05).
 * The audit insert commits in the same transaction as its mutation; SSE
 * emission happens after commit so a rollback can never have been broadcast.
 * One carve-out: app-global workflow-library ops audit nothing — see the
 * workflow section below.
 */
export class Store {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus: EventBus,
  ) {}

  createProject(input: {
    name: string;
    ticketPrefix?: string;
    /** A ProviderInstance id; omitted = the first configured instance. */
    defaultProvider?: string;
    /** Selection at creation (CONTEXT.md: Workflow); omitted = the Default Workflow. */
    workflowId?: number;
  }): Project {
    const workflow =
      input.workflowId === undefined
        ? this.defaultWorkflow()
        : this.selectableWorkflow(input.workflowId);
    const { project, audit } = withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          "INSERT INTO projects (name, ticket_prefix, default_provider, workflow_id, workflow_confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.name,
          input.ticketPrefix ?? "TRK",
          // The list may be empty (fresh install, nothing added yet): fall
          // back to the classic driver name as an inert placeholder — the
          // promote gate is what enforces a real, enabled instance.
          input.defaultProvider ?? this.listProviderInstances()[0]?.id ?? "claude-code",
          workflow.id,
          // An explicit selection at creation is already a decision; only a
          // defaulted project owes the board's one-time ask.
          input.workflowId === undefined ? 0 : 1,
          nowIso(),
        );
      const project = this.getProject(Number(result.lastInsertRowid));
      if (!project) throw new Error("project vanished after insert");
      const audit = this.insertAudit({
        projectId: project.id,
        ticketId: null,
        actor: "human",
        type: "project.created",
        detail: { name: project.name, workflowId: workflow.id },
      });
      return { project, audit };
    });
    this.bus.emit("audit.appended", audit);
    return project;
  }

  getProject(id: number): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row === undefined ? undefined : projectFromRow(row);
  }

  /**
   * Ordered for Home's recents: latest board activity first, read straight
   * off the Audit Trail — "opened" is not a recorded event (see CONTEXT.md).
   * Event ids order the same as time and never tie. Archived projects (ticket
   * 50) are excluded unless asked for — Home's "Show archived" pref asks.
   */
  listProjects(opts?: { includeHidden?: boolean }): ProjectListItem[] {
    return this.db
      .prepare(
        `SELECT p.*, le.created_at AS last_activity_at,
           (SELECT path FROM repos r WHERE r.project_id = p.id ORDER BY r.id LIMIT 1) AS repo_path
         FROM projects p
         LEFT JOIN (SELECT project_id, MAX(id) AS last_event FROM events GROUP BY project_id) e
           ON e.project_id = p.id
         LEFT JOIN events le ON le.id = e.last_event
         WHERE p.deleted_at IS NULL ${opts?.includeHidden ? "" : "AND p.hidden_at IS NULL"}
         ORDER BY COALESCE(e.last_event, 0) DESC, p.id DESC`,
      )
      .all()
      .map((row) => ({
        ...projectFromRow(row),
        lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at),
        repoPath: row.repo_path == null ? null : String(row.repo_path),
      }));
  }

  /**
   * Archive from Home's recents (ticket 50): the row leaves the default
   * listing, delete nothing — tickets, runs, and the audit trail all stay,
   * and the project still resolves by id. Recovery is unhideProject (the
   * "Show archived" listing) or re-adding the checkout (Home.addLocal).
   */
  hideProject(id: number): Project {
    return this.setProjectHidden(id, true);
  }

  /** Undo of hideProject; the unhide audit event also floats the project to
   *  the top of recents, where a just-re-added project belongs. */
  unhideProject(id: number): Project {
    return this.setProjectHidden(id, false);
  }

  /**
   * Soft delete: the project leaves every listing (archived included), but
   * the row, tickets, runs, and audit trail all stay — history that names
   * this project keeps resolving by id. Re-adding the checkout resurrects it
   * (Home.addLocal), the same recovery path archiving uses.
   */
  deleteProject(id: number): Project {
    return this.setProjectDeleted(id, true);
  }

  /** Recovery seam for addLocal — clears deleted_at so the row lists again. */
  undeleteProject(id: number): Project {
    return this.setProjectDeleted(id, false);
  }

  private setProjectDeleted(id: number, deleted: boolean): Project {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (deleted === (project.deletedAt !== null)) return project;
    const { updated, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE projects SET deleted_at = ? WHERE id = ?")
        .run(deleted ? nowIso() : null, id);
      const audit = this.insertAudit({
        projectId: id,
        ticketId: null,
        actor: "human",
        type: deleted ? "project.deleted" : "project.undeleted",
        detail: { name: project.name },
      });
      return { updated: this.getProject(id)!, audit };
    });
    this.bus.emit("audit.appended", audit);
    return updated;
  }

  private setProjectHidden(id: number, hidden: boolean): Project {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    const { updated, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE projects SET hidden_at = ? WHERE id = ?")
        .run(hidden ? nowIso() : null, id);
      const audit = this.insertAudit({
        projectId: id,
        ticketId: null,
        actor: "human",
        type: hidden ? "project.hidden" : "project.unhidden",
        detail: { name: project.name },
      });
      return { updated: this.getProject(id)!, audit };
    });
    this.bus.emit("audit.appended", audit);
    return updated;
  }

  createRepo(input: {
    projectId: number;
    path: string;
    githubRemote: string | null;
    targetBranch?: string;
    previewCommand?: string;
    previewKind?: PreviewKind;
    previewReadinessPath?: string;
    previewReadinessTimeoutMs?: number;
    testCommand?: string;
    personaPath?: string;
  }): Repo {
    const project = this.getProject(input.projectId);
    if (!project) throw new NotFoundError(`project ${input.projectId} not found`);
    const { repo, audit } = withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          "INSERT INTO repos (project_id, path, github_remote, target_branch, preview_command, preview_kind, preview_readiness_path, preview_readiness_timeout_ms, test_command, persona_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.projectId,
          input.path,
          input.githubRemote,
          input.targetBranch ?? "main",
          input.previewCommand ?? null,
          input.previewKind ?? null,
          input.previewReadinessPath ?? null,
          input.previewReadinessTimeoutMs ?? null,
          input.testCommand ?? null,
          input.personaPath ?? null,
          nowIso(),
        );
      const repo = this.getRepo(Number(result.lastInsertRowid));
      if (!repo) throw new Error("repo vanished after insert");
      const audit = this.insertAudit({
        projectId: repo.projectId,
        ticketId: null,
        actor: "human",
        type: "repo.created",
        detail: { repoId: repo.id, path: repo.path, targetBranch: repo.targetBranch },
      });
      return { repo, audit };
    });
    this.bus.emit("audit.appended", audit);
    return repo;
  }

  getRepo(id: number): Repo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id);
    return row === undefined ? undefined : repoFromRow(row);
  }

  listRepos(projectId?: number): Repo[] {
    const rows =
      projectId === undefined
        ? this.db.prepare("SELECT * FROM repos ORDER BY id").all()
        : this.db.prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY id").all(projectId);
    return rows.map(repoFromRow);
  }

  createTicket(input: {
    projectId: number;
    title: string;
    description?: string;
    externalRef?: string;
    kind?: TicketKind;
    acceptanceCriteria: string[];
  }): TicketWithAcs {
    const project = this.getProject(input.projectId);
    if (!project) throw new NotFoundError(`project ${input.projectId} not found`);
    const now = nowIso();

    const { ticket, audit } = withTransaction(this.db, () => {
      // Allocate the immutable per-project ticket number (ADR-0002).
      const numberRow = this.db
        .prepare(
          "UPDATE projects SET next_ticket_number = next_ticket_number + 1 WHERE id = ? RETURNING next_ticket_number - 1 AS number",
        )
        .get(input.projectId);
      const number = Number(numberRow!.number);
      const displayKey = `${project.ticketPrefix}-${number}`;
      const result = this.db
        .prepare(
          "INSERT INTO tickets (project_id, number, display_key, title, description, external_ref, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.projectId,
          number,
          displayKey,
          input.title,
          input.description ?? "",
          input.externalRef ?? null,
          input.kind ?? "feature",
          now,
          now,
        );
      const ticketId = Number(result.lastInsertRowid);
      const insertAc = this.db.prepare(
        "INSERT INTO acceptance_criteria (ticket_id, text, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      input.acceptanceCriteria.forEach((text, position) => {
        insertAc.run(ticketId, text, position, now, now);
      });
      const ticket = this.getTicket(ticketId);
      if (!ticket) throw new Error("ticket vanished after insert");
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.created",
        detail: { displayKey: ticket.displayKey, title: ticket.title },
      });
      return { ticket, audit };
    });

    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    for (const ac of ticket.acceptanceCriteria) this.bus.emit("ac.updated", ac);
    return ticket;
  }

  getTicket(id: number): TicketWithAcs | undefined {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
    if (row === undefined) return undefined;
    const acs = this.db
      .prepare(
        "SELECT ac.*, c.id AS check_id, c.run_id AS check_run_id, c.kind AS check_kind, c.script_path AS check_script_path, c.reason AS check_reason, c.created_at AS check_created_at, c.updated_at AS check_updated_at FROM acceptance_criteria ac LEFT JOIN ac_checks c ON c.ac_id = ac.id WHERE ac.ticket_id = ? ORDER BY ac.position, ac.id",
      )
      .all(id)
      .map(acFromRow);
    // The LATEST run only: an old crash must not haunt a ticket whose most
    // recent attempt completed.
    const lastRun = this.db
      .prepare("SELECT crash_reason FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1")
      .get(id);
    const lastFailureReason =
      lastRun === undefined || lastRun.crash_reason === null ? null : String(lastRun.crash_reason);
    return { ...ticketFromRow(row), acceptanceCriteria: acs, lastFailureReason };
  }

  listTickets(projectId?: number): TicketWithAcs[] {
    const rows =
      projectId === undefined
        ? this.db.prepare("SELECT * FROM tickets ORDER BY id").all()
        : this.db.prepare("SELECT * FROM tickets WHERE project_id = ? ORDER BY id").all(projectId);
    return rows.map((row) => this.getTicket(Number(row.id))!);
  }

  /**
   * A human sending a parked ticket back to Todo for another attempt — the
   * recovery for setup failures and cap-parked tickets, where the verdict
   * path has no reviewable work to judge. The ticket.updated emit is what
   * wakes the pool: the claim follows immediately if a slot is free.
   */
  retryTicket(id: number): TicketWithAcs {
    const existing = this.getTicket(id);
    if (!existing) throw new NotFoundError(`ticket ${id} not found`);
    if (existing.state !== "human_review") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not human_review`);
    }
    const { ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE tickets SET state = 'todo', arrived_by_cap = 0, updated_at = ? WHERE id = ?")
        .run(nowIso(), id);
      const ticket = this.getTicket(id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.retried",
        detail: { from: existing.state, lastFailureReason: existing.lastFailureReason },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  updateTicket(id: number, patch: { title?: string; description?: string }): TicketWithAcs {
    const existing = this.getTicket(id);
    if (!existing) throw new NotFoundError(`ticket ${id} not found`);
    const changed = (["title", "description"] as const).filter(
      (field) => patch[field] !== undefined,
    );
    const { ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE tickets SET title = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(patch.title ?? existing.title, patch.description ?? existing.description, nowIso(), id);
      const ticket = this.getTicket(id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.updated",
        detail: { changed },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  /**
   * The single deliberate "go" action: Backlog → Todo with the target Repo
   * and provider fixed on the Ticket (one Ticket = one branch = one PR).
   */
  promoteTicket(id: number, input: { repoId: number; provider: string }): TicketWithAcs {
    const existing = this.getTicket(id);
    if (!existing) throw new NotFoundError(`ticket ${id} not found`);
    if (existing.state !== "backlog") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not backlog`);
    }
    const repo = this.getRepo(input.repoId);
    if (!repo) throw new NotFoundError(`repo ${input.repoId} not found`);
    if (repo.projectId !== existing.projectId) {
      throw new ValidationError(`repo ${repo.id} belongs to a different project`);
    }
    const { ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE tickets SET state = 'todo', repo_id = ?, provider = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.repoId, input.provider, nowIso(), id);
      const ticket = this.getTicket(id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.promoted",
        detail: { repoId: repo.id, repoPath: repo.path, provider: input.provider },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  /**
   * Claim = Run creation (ticket 08, no leases): atomically claim the oldest
   * claimable ticket — Todo, or a bounced In Progress ticket with no Run
   * still running — fix its branch name (first claim only), and open the
   * Run. Opening a new Run resets failed and machine-verified ACs to
   * pending (human-verified and waived persist — ticket 05); the battery
   * re-earns machine green marks every cycle. Worktree paths land later via
   * recordWorktree — git is slow and runs outside the transaction.
   */
  claimNextTicket(): {
    ticket: TicketWithAcs;
    run: Run;
    repo: Repo;
  } | undefined {
    const claimed = withTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT id FROM tickets
           WHERE state = 'todo'
              OR (state = 'in_progress' AND NOT EXISTS (
                    SELECT 1 FROM runs WHERE runs.ticket_id = tickets.id AND runs.state = 'running'))
           ORDER BY id
           LIMIT 1`,
        )
        .get();
      if (row === undefined) return undefined;
      const existing = this.getTicket(Number(row.id))!;
      const repo = this.getRepo(existing.repoId!);
      if (!repo) throw new StateError(`ticket ${existing.displayKey} is claimable without a repo`);

      const branch = existing.branch ?? branchNameFor(existing);
      const now = nowIso();
      this.db
        .prepare("UPDATE tickets SET state = 'in_progress', branch = ?, updated_at = ? WHERE id = ?")
        .run(branch, now, existing.id);
      // Resolve project → workflow head version and pin it on the Run
      // (ADR-0004): editing the library or the selection affects future
      // claims, never this attempt.
      const project = this.getProject(existing.projectId)!;
      const workflowVersionId = this.headVersionId(project.workflowId);
      const runResult = this.db
        .prepare(
          "INSERT INTO runs (ticket_id, state, workflow_version_id, created_at) VALUES (?, 'running', ?, ?)",
        )
        .run(existing.id, workflowVersionId, now);
      const resetAcIds = this.db
        .prepare(
          `UPDATE acceptance_criteria SET status = 'pending', provenance = NULL, updated_at = ?
           WHERE ticket_id = ?
             AND (status = 'failed' OR (status = 'verified' AND provenance = 'machine'))
           RETURNING id`,
        )
        .all(now, existing.id)
        .map((reset) => Number(reset.id));
      const run = this.getRun(Number(runResult.lastInsertRowid))!;
      const ticket = this.getTicket(existing.id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "ticket.claimed",
        detail: { runId: run.id, branch, repoId: repo.id, workflowVersionId, resetAcIds },
      });
      return { ticket, run, repo, resetAcIds, audit };
    });
    if (!claimed) return undefined;
    this.bus.emit("audit.appended", claimed.audit);
    this.bus.emit("ticket.updated", claimed.ticket);
    this.bus.emit("run.created", this.runDetails(claimed.run));
    for (const ac of claimed.ticket.acceptanceCriteria) {
      if (claimed.resetAcIds.includes(ac.id)) this.bus.emit("ac.updated", ac);
    }
    return { ticket: claimed.ticket, run: claimed.run, repo: claimed.repo };
  }

  /** The worktree came up (or was found waiting from a prior run). */
  recordWorktree(runId: number, input: WorktreeResult): Run {
    const existing = this.getRun(runId);
    if (!existing) throw new NotFoundError(`run ${runId} not found`);
    const { run, ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE runs SET worktree_path = ? WHERE id = ?")
        .run(input.worktreePath, runId);
      const run = this.getRun(runId)!;
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: input.created ? "worktree.created" : "worktree.reused",
        detail: { runId, worktreePath: input.worktreePath, branch: ticket.branch },
      });
      return { run, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.updated", this.runDetails(run));
    return run;
  }

  /**
   * The attempt is over. Completed sends the Ticket to Verifying (the gate
   * battery takes it from there); crashed sends it back to Todo for a fresh
   * claim with no new criteria — crash = work didn't happen, bounce = work
   * was wrong (ticket 41). The third crashed Run parks the Ticket in Human
   * Review instead, arrived-by-cap, mirroring the bounce cap. The crash
   * event carries the tree-state summary the re-claim inherits.
   */
  finishRun(
    runId: number,
    outcome: "completed" | "crashed" | "failed",
    reason?: string,
    extra: { treeState?: TreeState | null } = {},
  ): Run {
    const existing = this.getRun(runId);
    if (!existing) throw new NotFoundError(`run ${runId} not found`);
    if (existing.state !== "running") {
      throw new StateError(`run ${runId} is ${existing.state}, not running`);
    }
    const { run, ticket, audit, parkAudit } = withTransaction(this.db, () => {
      const now = nowIso();
      this.db
        .prepare("UPDATE runs SET state = ?, crash_reason = ?, ended_at = ? WHERE id = ?")
        .run(outcome, outcome === "completed" ? null : (reason ?? null), now, runId);
      const run = this.getRun(runId)!;
      // Orphaned runs don't burn the cap: "orphaned" means the app quit under
      // the run — a human restarting the tool, not the work failing. With
      // phase-level resume the replay is cheap, and three dev restarts in a
      // row must not park a healthy ticket in Human Review.
      const crashCount =
        outcome === "crashed"
          ? Number(
              this.db
                .prepare(
                  `SELECT COUNT(*) AS n FROM runs
                   WHERE ticket_id = ? AND state = 'crashed'
                     AND crash_reason NOT LIKE 'orphaned:%'`,
                )
                .get(run.ticketId)!.n,
            )
          : 0;
      const parked = crashCount >= CRASH_CAP;
      // "failed" is a deterministic setup failure (empty repo, missing
      // binary): retrying the identical setup can never succeed, so it goes
      // straight to Human Review without burning the crash cap.
      const ticketState =
        outcome === "completed"
          ? "verifying"
          : outcome === "failed" || parked
            ? "human_review"
            : "todo";
      this.db
        .prepare("UPDATE tickets SET state = ?, arrived_by_cap = ?, updated_at = ? WHERE id = ?")
        .run(ticketState, parked ? 1 : 0, now, run.ticketId);
      const ticket = this.getTicket(run.ticketId)!;
      const detail: Record<string, unknown> = { runId };
      if (reason !== undefined) detail.reason = reason;
      if (extra.treeState != null) detail.treeState = extra.treeState;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: `run.${outcome}`,
        detail,
      });
      const parkAudit = parked
        ? this.insertAudit({
            projectId: ticket.projectId,
            ticketId: ticket.id,
            actor: "agent",
            type: "ticket.parked",
            detail: { runId, crashCount, reason: "crash-cap" },
          })
        : undefined;
      return { run, ticket, audit, parkAudit };
    });
    this.bus.emit("audit.appended", audit);
    if (parkAudit) this.bus.emit("audit.appended", parkAudit);
    this.bus.emit("run.updated", this.runDetails(run));
    this.bus.emit("ticket.updated", ticket);
    return run;
  }

  /** Runs still claiming to be live — at app launch, every one is an orphan. */
  listRunningRuns(): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE state = 'running' ORDER BY id")
      .all()
      .map(runFromRow);
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row === undefined ? undefined : runFromRow(row);
  }

  /** Latest first: the newest Run is the one the drawer and wizard read. */
  listRuns(ticketId: number): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE ticket_id = ? ORDER BY id DESC")
      .all(ticketId)
      .map(runFromRow);
  }

  listRunsWithPhases(ticketId: number): RunWithPhases[] {
    return this.listRuns(ticketId).map((run) => this.runDetails(run));
  }

  /** The enriched shape every run.* bus event and API read carries. */
  private runDetails(run: Run): RunWithPhases {
    return {
      ...run,
      phases: this.listPhaseExecutions(run.id),
      artifacts: this.listArtifacts(run.id),
      gateResults: this.listGateResults(run.id),
      expectedPhases: this.expectedPhases(run.workflowVersionId),
    };
  }

  /** The pinned version's agent phases in preview order; [] if it vanished. */
  private expectedPhases(workflowVersionId: number): string[] {
    try {
      return previewPhases(this.getWorkflowGraph(workflowVersionId)).map((node) => node.name);
    } catch {
      return [];
    }
  }

  getArtifact(id: number): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    return row === undefined ? undefined : artifactFromRow(row);
  }

  listArtifacts(runId: number): Artifact[] {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map(artifactFromRow);
  }

  /**
   * Point at the blobs just persisted under app data. One transaction, one
   * audit event: evidence lands atomically, whatever the run's outcome was.
   */
  recordArtifacts(
    runId: number,
    worktreeHeadSha: string,
    files: Array<{ kind: string; name: string; path: string; contentHash: string }>,
  ): Artifact[] {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (files.length === 0) return [];
    const { artifacts, audit } = withTransaction(this.db, () => {
      const insert = this.db.prepare(
        "INSERT INTO artifacts (run_id, kind, name, path, content_hash, worktree_head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const now = nowIso();
      for (const file of files) {
        insert.run(runId, file.kind, file.name, file.path, file.contentHash, worktreeHeadSha, now);
      }
      const artifacts = this.listArtifacts(runId);
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "artifacts.persisted",
        detail: { runId, count: files.length, worktreeHeadSha },
      });
      return { artifacts, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.updated", this.runDetails(this.getRun(runId)!));
    return artifacts;
  }

  /**
   * Register the plan phase's verification for each pending AC (ticket 07 §4).
   * One row per AC — a later Run's plan phase re-registering (bounce re-entry
   * re-validates coverage) updates in place, so re-registration is idempotent.
   */
  registerAcChecks(runId: number, entries: readonly CheckRegistration[]): TicketWithAcs {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const existing = this.getTicket(run.ticketId);
    if (!existing) throw new NotFoundError(`ticket ${run.ticketId} not found`);
    const acIds = new Set(existing.acceptanceCriteria.map((ac) => ac.id));
    for (const entry of entries) {
      if (!acIds.has(entry.acId)) {
        throw new ValidationError(`AC ${entry.acId} does not belong to ticket ${existing.id}`);
      }
    }
    const { ticket, audit } = withTransaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO ac_checks (ac_id, run_id, kind, script_path, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ac_id) DO UPDATE SET
           run_id = excluded.run_id, kind = excluded.kind, script_path = excluded.script_path,
           reason = excluded.reason, updated_at = excluded.updated_at`,
      );
      const now = nowIso();
      for (const entry of entries) {
        upsert.run(
          entry.acId,
          runId,
          entry.kind,
          entry.kind === "script" ? entry.scriptPath : null,
          entry.kind === "human" ? entry.reason : null,
          now,
          now,
        );
      }
      const ticket = this.getTicket(existing.id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "checks.registered",
        detail: {
          runId,
          scripts: entries.filter((entry) => entry.kind === "script").length,
          human: entries.filter((entry) => entry.kind === "human").length,
        },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    for (const ac of ticket.acceptanceCriteria) {
      if (entries.some((entry) => entry.acId === ac.id)) this.bus.emit("ac.updated", ac);
    }
    return ticket;
  }

  /**
   * One gate execution lands: the row, its audit event, and — for an AC
   * check — the criterion's new status commit together. Results come from
   * the orchestrator only; nothing here is reachable from a provider.
   */
  recordGateResult(
    runId: number,
    input: { gate: string; status: GateStatus; detail?: Record<string, unknown>; acId?: number },
  ): GateResult {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const { result, acChanged, ticket, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      const inserted = this.db
        .prepare(
          "INSERT INTO gate_results (run_id, gate, status, detail, ac_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          runId,
          input.gate,
          input.status,
          JSON.stringify(input.detail ?? {}),
          input.acId ?? null,
          now,
        );
      // An executed AC check settles its criterion with machine provenance;
      // a skip (waived, human-routed) leaves the row alone.
      const settledAcId = input.status === "skip" ? undefined : input.acId;
      if (settledAcId !== undefined) {
        this.db
          .prepare(
            "UPDATE acceptance_criteria SET status = ?, provenance = 'machine', updated_at = ? WHERE id = ?",
          )
          .run(input.status === "pass" ? "verified" : "failed", now, settledAcId);
      }
      const result = this.getGateResult(Number(inserted.lastInsertRowid))!;
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "gate.result",
        detail:
          input.acId === undefined
            ? { runId, gate: input.gate, status: input.status }
            : { runId, gate: input.gate, status: input.status, acId: input.acId },
      });
      return { result, acChanged: settledAcId !== undefined, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("gate.result", { ticketId: ticket.id, ...result });
    // The enriched run row rides along so board state (where live events
    // outrank snapshot fetches) sees gate results without a refetch race.
    this.bus.emit("run.updated", this.runDetails(this.getRun(runId)!));
    if (acChanged) {
      const ac = ticket.acceptanceCriteria.find((candidate) => candidate.id === input.acId);
      if (ac) this.bus.emit("ac.updated", ac);
    }
    return result;
  }

  getGateResult(id: number): GateResult | undefined {
    const row = this.db.prepare("SELECT * FROM gate_results WHERE id = ?").get(id);
    return row === undefined ? undefined : gateResultFromRow(row);
  }

  listGateResults(runId: number): GateResult[] {
    return this.db
      .prepare("SELECT * FROM gate_results WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map(gateResultFromRow);
  }

  /**
   * The battery's verdict on a Verifying ticket: all green → Human Review;
   * any failure leaves it in Verifying with the failures on record — the
   * bounce that acts on them lands in slice 30.
   */
  concludeVerification(runId: number, outcome: { passed: boolean; failed: string[] }): Ticket {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const existing = this.getTicket(run.ticketId)!;
    if (existing.state !== "verifying") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not verifying`);
    }
    const { ticket, audit } = withTransaction(this.db, () => {
      if (outcome.passed) {
        this.db
          .prepare("UPDATE tickets SET state = 'human_review', updated_at = ? WHERE id = ?")
          .run(nowIso(), existing.id);
      }
      const ticket = this.getTicket(existing.id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: outcome.passed ? "gates.passed" : "gates.failed",
        detail: outcome.passed ? { runId } : { runId, failed: outcome.failed },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    if (outcome.passed) this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  /**
   * The failed battery's one bounce (ticket 06 §5): the whole batch lands in
   * a single event — follow-up AC rows born from the failed gates, the tree
   * state the next Run inherits, and the Ticket's move back to In Progress
   * for a fresh claim. The third failed cycle parks in Human Review instead,
   * flagged arrived-by-cap: past that point the failure is spec-shaped,
   * which is human territory (ticket 06 §6).
   */
  bounceTicket(
    runId: number,
    input: {
      /** The battery's failed labels (gates and ac-check:AC-<id>), verbatim. */
      failed: string[];
      followUps: FollowUpSeed[];
      treeState: TreeState;
    },
  ): { ticket: TicketWithAcs; parked: boolean; followUpAcIds: number[] } {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const existing = this.getTicket(run.ticketId)!;
    if (existing.state !== "verifying") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not verifying`);
    }
    const bounceCount = existing.bounceCount + 1;
    const parked = bounceCount >= BOUNCE_CAP;
    const { ticket, followUpAcIds, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      const positionRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM acceptance_criteria WHERE ticket_id = ?",
        )
        .get(existing.id)!;
      const insert = this.db.prepare(
        "INSERT INTO acceptance_criteria (ticket_id, text, position, origin, created_at, updated_at) VALUES (?, ?, ?, 'gate-fail', ?, ?)",
      );
      const followUpAcIds = input.followUps.map((followUp, offset) => {
        const inserted = insert.run(
          existing.id,
          followUp.text,
          Number(positionRow.next) + offset,
          now,
          now,
        );
        return Number(inserted.lastInsertRowid);
      });
      this.db
        .prepare(
          "UPDATE tickets SET state = ?, bounce_count = ?, arrived_by_cap = ?, updated_at = ? WHERE id = ?",
        )
        .run(parked ? "human_review" : "in_progress", bounceCount, parked ? 1 : 0, now, existing.id);
      const ticket = this.getTicket(existing.id)!;
      const detail: Record<string, unknown> = {
        runId,
        bounceCount,
        failed: input.failed,
        followUpAcIds,
        treeState: input.treeState,
      };
      if (parked) detail.reason = "bounce-cap";
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: parked ? "ticket.parked" : "ticket.bounced",
        detail,
      });
      return { ticket, followUpAcIds, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    for (const ac of ticket.acceptanceCriteria) {
      if (followUpAcIds.includes(ac.id)) this.bus.emit("ac.updated", ac);
    }
    return { ticket, parked, followUpAcIds };
  }

  /**
   * The orchestrator observed the branch's PR on the remote (never
   * self-reported): record it on the Ticket, where it lives alongside the
   * branch, stable across bounces. Idempotent — the battery re-observes the
   * same PR every cycle, and only a change is worth a row or an event.
   */
  recordPr(ticketId: number, pr: { number: number; url: string }): TicketWithAcs {
    const existing = this.getTicket(ticketId);
    if (!existing) throw new NotFoundError(`ticket ${ticketId} not found`);
    if (existing.prNumber === pr.number && existing.prUrl === pr.url) return existing;
    const { ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE tickets SET pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?")
        .run(pr.number, pr.url, nowIso(), ticketId);
      const ticket = this.getTicket(ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "pr.recorded",
        detail: { prNumber: pr.number, prUrl: pr.url, branch: ticket.branch },
      });
      return { ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  /**
   * The pass verdict's landing (ticket 31): the PR is already merged through
   * the GitHubPort by the caller — this records the verdict and moves the
   * Ticket to Done. State re-checked here so a racing mutation can't Done a
   * ticket that left Human Review mid-merge.
   */
  mergeTicket(
    ticketId: number,
    opts: {
      /** Drift the human force-merged past (ticket 33) — the waive-equivalent, audited. */
      freshnessWaived?: string[];
    } = {},
  ): TicketWithAcs {
    const existing = this.getTicket(ticketId);
    if (!existing) throw new NotFoundError(`ticket ${ticketId} not found`);
    if (existing.state !== "human_review") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not human_review`);
    }
    const { ticket, verdictAudit, mergedAudit } = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE tickets SET state = 'done', updated_at = ? WHERE id = ?")
        .run(nowIso(), ticketId);
      const ticket = this.getTicket(ticketId)!;
      const detail: Record<string, unknown> = { outcome: "pass", prNumber: ticket.prNumber };
      if (opts.freshnessWaived !== undefined) detail.freshnessWaived = opts.freshnessWaived;
      const verdictAudit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "verdict.recorded",
        detail,
      });
      const mergedAudit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.merged",
        detail: { prNumber: ticket.prNumber, prUrl: ticket.prUrl, branch: ticket.branch },
      });
      return { ticket, verdictAudit, mergedAudit };
    });
    this.bus.emit("audit.appended", verdictAudit);
    this.bus.emit("audit.appended", mergedAudit);
    this.bus.emit("ticket.updated", ticket);
    return ticket;
  }

  /**
   * The Done sweep's record half (ticket 42): the preview row goes with the
   * worktree, and the reap is audited per ticket — disk hygiene is a real
   * event in the Ticket's life, not silent housekeeping. Ticket state is
   * untouched; Done stays Done.
   */
  reapTicket(
    ticketId: number,
    detail: { worktreePath: string | null },
  ): { previewRemoved: boolean } {
    const existing = this.getTicket(ticketId);
    if (!existing) throw new NotFoundError(`ticket ${ticketId} not found`);
    const { previewRemoved, audit } = withTransaction(this.db, () => {
      const deleted = this.db.prepare("DELETE FROM previews WHERE ticket_id = ?").run(ticketId);
      const previewRemoved = Number(deleted.changes) > 0;
      const audit = this.insertAudit({
        projectId: existing.projectId,
        ticketId,
        actor: "human",
        type: "worktree.reaped",
        detail: {
          worktreePath: detail.worktreePath,
          previewRemoved,
          prNumber: existing.prNumber,
        },
      });
      return { previewRemoved, audit };
    });
    this.bus.emit("audit.appended", audit);
    return { previewRemoved };
  }

  /**
   * A reviewer answers an open "Decision for a human" from the dogfood phase
   * (ticket 37). Decisions never gate — the answer changes no Ticket state; it
   * lands in the Audit Trail as a human event so the reasoning survives. The
   * decision's id and the observed-behavior question travel with the answer so
   * the trail reads on its own.
   */
  answerDogfoodDecision(
    ticketId: number,
    input: { decisionId: string; question: string; answer: string },
  ): AuditEvent {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    const audit = this.insertAudit({
      projectId: ticket.projectId,
      ticketId: ticket.id,
      actor: "human",
      type: "dogfood.decision_answered",
      detail: { decisionId: input.decisionId, question: input.question, answer: input.answer },
    });
    this.bus.emit("audit.appended", audit);
    return audit;
  }

  /**
   * A human settles an AC from the Manual Walkthrough (ticket 33): verified
   * or failed, provenance human. Like waiveAc, legal in any state — the
   * walkthrough happens at Human Review, but a human observation is never
   * illegal. Any earlier waive reason is cleared: one status, one story.
   */
  settleAcByHuman(acId: number, status: "verified" | "failed"): AcceptanceCriterion {
    const row = this.db.prepare("SELECT * FROM acceptance_criteria WHERE id = ?").get(acId);
    if (!row) throw new NotFoundError(`acceptance criterion ${acId} not found`);
    const { ac, ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE acceptance_criteria SET status = ?, provenance = 'human', waive_reason = NULL, updated_at = ? WHERE id = ?",
        )
        .run(status, nowIso(), acId);
      const ticket = this.getTicket(Number(row.ticket_id))!;
      const ac = ticket.acceptanceCriteria.find((candidate) => candidate.id === acId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: status === "verified" ? "ac.verified" : "ac.failed",
        detail: { acId },
      });
      return { ac, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ac.updated", ac);
    this.bus.emit("ticket.updated", ticket);
    return ac;
  }

  /**
   * The reviewer's bounce (ticket 33): a failed review — or a drift
   * re-verify — sends a Human Review ticket back to In Progress through the
   * slice-30 machinery. Each failed step's note becomes a Follow-up
   * Criterion verbatim (origin review-fail); failed ACs need no new rows —
   * they reset to pending on the next claim like any other failure. Never
   * parks: the cap stops agents looping, and this bounce is a human
   * explicitly buying another cycle.
   */
  reviewBounceTicket(
    runId: number,
    input: {
      reason: ReviewBounceReason;
      /** The marks as submitted; audited whole so the review is reconstructable. */
      steps: ReviewStepMark[];
      /** Verbatim reviewer notes about to become Follow-up Criteria. */
      followUps: string[];
      treeState: TreeState | null;
      /** What the Final Verdict freshness subset found, for stale-evidence bounces. */
      driftReasons?: string[];
    },
  ): { ticket: TicketWithAcs; followUpAcIds: number[] } {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const existing = this.getTicket(run.ticketId)!;
    if (existing.state !== "human_review") {
      throw new StateError(`ticket ${existing.displayKey} is ${existing.state}, not human_review`);
    }
    const bounceCount = existing.bounceCount + 1;
    const { ticket, followUpAcIds, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      const positionRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM acceptance_criteria WHERE ticket_id = ?",
        )
        .get(existing.id)!;
      const insert = this.db.prepare(
        "INSERT INTO acceptance_criteria (ticket_id, text, position, origin, created_at, updated_at) VALUES (?, ?, ?, 'review-fail', ?, ?)",
      );
      const followUpAcIds = input.followUps.map((text, offset) => {
        const inserted = insert.run(existing.id, text, Number(positionRow.next) + offset, now, now);
        return Number(inserted.lastInsertRowid);
      });
      this.db
        .prepare(
          "UPDATE tickets SET state = 'in_progress', bounce_count = ?, arrived_by_cap = 0, updated_at = ? WHERE id = ?",
        )
        .run(bounceCount, now, existing.id);
      const ticket = this.getTicket(existing.id)!;
      const detail: Record<string, unknown> = {
        runId,
        bounceCount,
        reason: input.reason,
        steps: input.steps,
        followUpAcIds,
        treeState: input.treeState,
      };
      if (input.driftReasons !== undefined) detail.driftReasons = input.driftReasons;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ticket.bounced",
        detail,
      });
      return { ticket, followUpAcIds, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ticket.updated", ticket);
    for (const ac of ticket.acceptanceCriteria) {
      if (followUpAcIds.includes(ac.id)) this.bus.emit("ac.updated", ac);
    }
    return { ticket, followUpAcIds };
  }

  /**
   * Human-only, reason mandatory, legal in any state (pre-waiving an
   * aspirational AC is legitimate — ticket 06). Forward-acting: the battery
   * reads statuses at its start, so a mid-flight waive takes effect next
   * cycle, never rescuing a Verifying run.
   */
  waiveAc(acId: number, reason: string): AcceptanceCriterion {
    const row = this.db.prepare("SELECT * FROM acceptance_criteria WHERE id = ?").get(acId);
    if (!row) throw new NotFoundError(`acceptance criterion ${acId} not found`);
    if (reason.trim() === "") throw new ValidationError("a waive requires a reason");
    const { ac, ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE acceptance_criteria SET status = 'waived', provenance = 'human', waive_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(reason.trim(), nowIso(), acId);
      const ticket = this.getTicket(Number(row.ticket_id))!;
      const ac = ticket.acceptanceCriteria.find((candidate) => candidate.id === acId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "human",
        type: "ac.waived",
        detail: { acId, reason: reason.trim() },
      });
      return { ac, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("ac.updated", ac);
    this.bus.emit("ticket.updated", ticket);
    return ac;
  }

  getPreview(ticketId: number): PreviewRecord | undefined {
    const row = this.db.prepare("SELECT * FROM previews WHERE ticket_id = ?").get(ticketId);
    return row === undefined ? undefined : previewFromRow(row);
  }

  /**
   * One preview transition lands (ticket 34): the per-Ticket row (created at
   * first use) and its audit event commit together. Actor says who drove the
   * transition: the reviewer's wizard session (the default) or the
   * orchestrator's demo phase (ticket 35).
   */
  upsertPreview(
    ticketId: number,
    input: {
      status: PreviewStatus;
      port?: number | null;
      logPath?: string | null;
      actor?: Actor;
      detail?: Record<string, unknown>;
    },
  ): PreviewRecord {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    const { record, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      const existing = this.getPreview(ticketId);
      if (existing) {
        this.db
          .prepare("UPDATE previews SET port = ?, status = ?, log_path = ?, updated_at = ? WHERE ticket_id = ?")
          .run(
            input.port !== undefined ? input.port : existing.port,
            input.status,
            input.logPath !== undefined ? input.logPath : existing.logPath,
            now,
            ticketId,
          );
      } else {
        this.db
          .prepare(
            "INSERT INTO previews (ticket_id, port, status, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(ticketId, input.port ?? null, input.status, input.logPath ?? null, now, now);
      }
      const record = this.getPreview(ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId,
        actor: input.actor ?? "human",
        type: `preview.${input.status === "starting" ? "started" : input.status}`,
        detail: { port: record.port, ...input.detail },
      });
      return { record, audit };
    });
    this.bus.emit("audit.appended", audit);
    return record;
  }

  /**
   * Boot honesty: no preview process survives an app restart, so any row
   * still claiming starting/ready is a leftover from a crashed or quit
   * session. Silent — the processes died with the app; there is no
   * transition worth an audit event, just a record catching up to reality.
   */
  sweepOrphanedPreviews(): void {
    this.db
      .prepare("UPDATE previews SET status = 'stopped', updated_at = ? WHERE status IN ('starting', 'ready')")
      .run(nowIso());
  }

  listPhaseExecutions(runId: number): PhaseExecution[] {
    return this.db
      .prepare("SELECT * FROM phase_executions WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map(phaseFromRow);
  }

  // -- workflow library (ticket 43) --------------------------------------
  //
  // These ops are app-global: no project, no ticket — outside the Audit
  // Trail's domain, which CONTEXT.md scopes to what happened to a Ticket.
  // They deliberately append no audit events (an event no project or ticket
  // can surface is write-only noise); the Run's pinned version is the
  // enduring record of what actually drove work.

  /** One immutable version's content — what a Run's pinned id resolves to. */
  getWorkflowGraph(versionId: number): WorkflowGraph {
    const row = this.db
      .prepare(
        `SELECT v.id AS version_id, v.workflow_id, v.version, w.name
         FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
         WHERE v.id = ?`,
      )
      .get(versionId);
    if (!row) throw new NotFoundError(`workflow version ${versionId} not found`);
    return {
      versionId: Number(row.version_id),
      workflowId: Number(row.workflow_id),
      version: Number(row.version),
      name: String(row.name),
      nodes: this.db
        .prepare("SELECT * FROM workflow_nodes WHERE workflow_version_id = ? ORDER BY id")
        .all(versionId)
        .map((nodeRow) => workflowNodeFromRow(nodeRow, this.stepsForNode(Number(nodeRow.id)))),
      edges: this.db
        .prepare("SELECT * FROM workflow_edges WHERE workflow_version_id = ? ORDER BY id")
        .all(versionId)
        .map(workflowEdgeFromRow),
    };
  }

  getWorkflow(id: number): Workflow | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    return row === undefined ? undefined : workflowFromRow(row);
  }

  /** The whole library, archived rows included (shown dimmed) — deleted rows never. */
  listWorkflows(): WorkflowListing[] {
    return this.db
      .prepare("SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY id")
      .all()
      .map((row) => this.listingFor(workflowFromRow(row)));
  }

  /**
   * A from-scratch workflow (ticket 51): identity plus a version 1 holding
   * only the trigger node. Zero phases is legal to hold but not to select —
   * selectableWorkflow guards claims, and the editor ticket fills the graph.
   */
  createWorkflow(
    name?: string,
    description?: string,
    color?: string | null,
    icon?: string | null,
  ): WorkflowListing {
    const trimmed = (name ?? "").trim();
    if (color !== undefined && color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw new ValidationError("color must be a #rrggbb hex value");
    }
    if (icon !== undefined && icon !== null && icon.trim() === "") {
      throw new ValidationError("icon must be a name or null");
    }
    const created = withTransaction(this.db, () => {
      const now = nowIso();
      const inserted = this.db
        .prepare(
          "INSERT INTO workflows (name, description, color, icon, archived, is_default, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
        )
        .run(
          trimmed === "" ? "New Workflow" : trimmed,
          (description ?? "").trim(),
          color ?? null,
          icon ?? null,
          now,
        );
      const workflowId = Number(inserted.lastInsertRowid);
      const versionResult = this.db
        .prepare("INSERT INTO workflow_versions (workflow_id, version, created_at) VALUES (?, 1, ?)")
        .run(workflowId, now);
      this.db
        .prepare(
          "INSERT INTO workflow_nodes (workflow_version_id, type, name, prompt_template, gate_requirements, emits_checks, boots_preview) VALUES (?, 'trigger', 'ticket-claimed', NULL, NULL, 0, 0)",
        )
        .run(Number(versionResult.lastInsertRowid));
      return this.getWorkflow(workflowId)!;
    });
    return this.listingFor(created);
  }

  /**
   * Delete a workflow. Never-used ones (ticket 51: no project references it,
   * no run pinned a version) hard-delete — there is no history to preserve.
   * Anything with run history soft-deletes: the row keeps deleted_at so
   * pinned versions still resolve, but it leaves the library and every
   * selection surface. Blocked while it is the default or a project's
   * current choice — hand those off first.
   */
  deleteWorkflow(id: number): void {
    const workflow = this.getWorkflow(id);
    if (!workflow || workflow.deletedAt !== null) {
      throw new NotFoundError(`workflow ${id} not found`);
    }
    if (workflow.isDefault) {
      throw new StateError(`"${workflow.name}" is the Default Workflow — archive with a successor instead`);
    }
    const usedBy = this.db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE workflow_id = ? AND deleted_at IS NULL")
      .get(id)!;
    if (Number(usedBy.n) > 0) {
      throw new StateError(
        `"${workflow.name}" is the current workflow of ${usedBy.n} project(s) — switch them first`,
      );
    }
    if (!this.workflowNeverUsed(id)) {
      this.db.prepare("UPDATE workflows SET deleted_at = ? WHERE id = ?").run(nowIso(), id);
      return;
    }
    withTransaction(this.db, () => {
      this.db
        .prepare(
          "DELETE FROM workflow_edges WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?)",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM workflow_nodes WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM workflow_versions WHERE workflow_id = ?").run(id);
      this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    });
  }

  /** No project selection and no run pin — nothing on disk or in history points here. */
  private workflowNeverUsed(id: number): boolean {
    const projects = this.db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE workflow_id = ?")
      .get(id)!;
    const runs = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs r JOIN workflow_versions v ON r.workflow_version_id = v.id WHERE v.workflow_id = ?",
      )
      .get(id)!;
    return Number(projects.n) === 0 && Number(runs.n) === 0;
  }

  /**
   * Create-by-duplicate (the only creation path until the editor ticket):
   * the head version's graph becomes the new workflow's own version 1 —
   * fresh node rows, so no future edit can ever touch the source.
   */
  duplicateWorkflow(id: number): WorkflowListing {
    const source = this.getWorkflow(id);
    if (!source) throw new NotFoundError(`workflow ${id} not found`);
    const graph = this.getWorkflowGraph(this.headVersionId(id));
    const copy = withTransaction(this.db, () => {
      const now = nowIso();
      const inserted = this.db
        .prepare(
          "INSERT INTO workflows (name, description, archived, is_default, created_at) VALUES (?, ?, 0, 0, ?)",
        )
        .run(`${source.name} (copy)`, source.description, now);
      const workflowId = Number(inserted.lastInsertRowid);
      const versionResult = this.db
        .prepare("INSERT INTO workflow_versions (workflow_id, version, created_at) VALUES (?, 1, ?)")
        .run(workflowId, now);
      const versionId = Number(versionResult.lastInsertRowid);
      const nodeIds = new Map<number, number>();
      const insertNode = this.db.prepare(
        "INSERT INTO workflow_nodes (workflow_version_id, type, name, prompt_template, gate_requirements, emits_checks, boots_preview) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const node of graph.nodes) {
        const nodeResult = insertNode.run(
          versionId,
          node.type,
          node.name,
          node.promptTemplate,
          node.gateRequirements.length === 0 ? null : JSON.stringify(node.gateRequirements),
          node.emitsChecks ? 1 : 0,
          node.bootsPreview ? 1 : 0,
        );
        nodeIds.set(node.id, Number(nodeResult.lastInsertRowid));
        this.insertSteps(
          Number(nodeResult.lastInsertRowid),
          node.steps.map((step) => ({ type: step.type, title: step.title, prompt: step.prompt })),
        );
      }
      const insertEdge = this.db.prepare(
        "INSERT INTO workflow_edges (workflow_version_id, from_node_id, to_node_id, condition_label) VALUES (?, ?, ?, ?)",
      );
      for (const edge of graph.edges) {
        insertEdge.run(
          versionId,
          nodeIds.get(edge.fromNodeId)!,
          nodeIds.get(edge.toNodeId)!,
          edge.conditionLabel,
        );
      }
      return this.getWorkflow(workflowId)!;
    });
    return this.listingFor(copy);
  }

  /** Identity edits only — every version, past pin, and project follows. */
  updateWorkflow(
    id: number,
    patch: { name?: string; description?: string; color?: string | null; icon?: string | null },
  ): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed === "") throw new ValidationError("a workflow needs a name");
      this.db.prepare("UPDATE workflows SET name = ? WHERE id = ?").run(trimmed, id);
    }
    if (patch.description !== undefined) {
      this.db
        .prepare("UPDATE workflows SET description = ? WHERE id = ?")
        .run(patch.description.trim(), id);
    }
    if (patch.color !== undefined) {
      if (patch.color !== null && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) {
        throw new ValidationError("color must be a #rrggbb hex value");
      }
      this.db.prepare("UPDATE workflows SET color = ? WHERE id = ?").run(patch.color, id);
    }
    if (patch.icon !== undefined) {
      if (patch.icon !== null && patch.icon.trim() === "") {
        throw new ValidationError("icon must be a name or null");
      }
      this.db.prepare("UPDATE workflows SET icon = ? WHERE id = ?").run(patch.icon, id);
    }
    return this.listingFor(this.getWorkflow(id)!);
  }

  /** Exactly one active default at all times; the swap is one transaction. */
  setDefaultWorkflow(id: number): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow || workflow.deletedAt !== null) {
      throw new NotFoundError(`workflow ${id} not found`);
    }
    if (workflow.archived) {
      throw new ValidationError(`workflow "${workflow.name}" is archived and cannot be the default`);
    }
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE workflows SET is_default = 0 WHERE is_default = 1").run();
      this.db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(id);
    });
    return this.listingFor(this.getWorkflow(id)!);
  }

  /**
   * Archiving removes a workflow from selection but never from duty — its
   * projects keep claiming against it (CONTEXT.md: archived, never
   * hard-deleted). Archiving the default demands a successor in the same
   * call, so the one-active-default invariant moves atomically.
   */
  archiveWorkflow(id: number, successorId?: number): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow || workflow.deletedAt !== null) {
      throw new NotFoundError(`workflow ${id} not found`);
    }
    if (workflow.archived) return this.listingFor(workflow);
    if (!workflow.isDefault) {
      this.db.prepare("UPDATE workflows SET archived = 1 WHERE id = ?").run(id);
      return this.listingFor(this.getWorkflow(id)!);
    }
    if (successorId === undefined) {
      throw new StateError(
        `"${workflow.name}" is the Default Workflow — archiving it requires naming a successor`,
      );
    }
    const successor = this.getWorkflow(successorId);
    if (!successor) throw new NotFoundError(`workflow ${successorId} not found`);
    if (successor.id === workflow.id) {
      throw new ValidationError("the successor must be a different workflow");
    }
    if (successor.archived) {
      throw new ValidationError(`successor "${successor.name}" is archived — the default must be active`);
    }
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE workflows SET archived = 1, is_default = 0 WHERE id = ?").run(id);
      this.db.prepare("UPDATE workflows SET is_default = 1 WHERE id = ?").run(successor.id);
    });
    return this.listingFor(this.getWorkflow(id)!);
  }

  /** Reversible by design; the default designation does not come back with it. */
  unarchiveWorkflow(id: number): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
    this.db.prepare("UPDATE workflows SET archived = 0 WHERE id = ?").run(id);
    return this.listingFor(this.getWorkflow(id)!);
  }

  /**
   * Change a project's selection. Takes effect at the next claim — running
   * Runs keep their pin. Deliberately no audit event: the Run's pinned
   * version is the record (ticket 43).
   */
  setProjectWorkflow(projectId: number, workflowId: number): Project {
    const project = this.getProject(projectId);
    if (!project) throw new NotFoundError(`project ${projectId} not found`);
    const workflow = this.selectableWorkflow(workflowId);
    this.db
      .prepare("UPDATE projects SET workflow_id = ?, workflow_confirmed = 1 WHERE id = ?")
      .run(workflow.id, projectId);
    return this.getProject(projectId)!;
  }

  /** "Keep it": answers the board's one-time ask without changing anything. */
  confirmProjectWorkflow(projectId: number): Project {
    const project = this.getProject(projectId);
    if (!project) throw new NotFoundError(`project ${projectId} not found`);
    this.db.prepare("UPDATE projects SET workflow_confirmed = 1 WHERE id = ?").run(projectId);
    return this.getProject(projectId)!;
  }

  /**
   * Provider instances (migration 26): the user-managed provider list. The
   * seeded defaults (id = driver name) guarantee the list is never empty, so
   * every settings surface has rows to show and every legacy provider
   * reference resolves.
   */
  getProviderInstance(id: string): ProviderInstance | undefined {
    const row = this.db
      .prepare("SELECT * FROM provider_instances WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? undefined : providerInstanceFromRow(row);
  }

  listProviderInstances(): ProviderInstance[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_instances ORDER BY created_at, id")
      .all() as Row[];
    return rows.map(providerInstanceFromRow);
  }

  /**
   * The id is a slug cut from the display name (fallback: the driver name),
   * suffixed -2, -3… on collision. Stable once minted — references point at
   * it — which is why rename edits touch display_name only, never the id.
   */
  addProviderInstance(input: {
    driver: ProviderName;
    displayName: string;
  }): ProviderInstance {
    const displayName = input.displayName.trim();
    if (displayName === "") throw new ValidationError("displayName is required");
    const base =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || input.driver;
    let id = base;
    for (let n = 2; this.getProviderInstance(id) !== undefined; n++) id = `${base}-${n}`;
    this.db
      .prepare(
        "INSERT INTO provider_instances (id, driver, display_name) VALUES (?, ?, ?)",
      )
      .run(id, input.driver, displayName);
    return this.getProviderInstance(id)!;
  }

  /**
   * Patch semantics: an omitted field is left alone, an explicit null clears
   * it back to the default. Without that distinction the settings form could
   * never blank a pinned model once it had been set. id and driver are
   * immutable — the entry's references and its adapter hang off them.
   */
  setProviderInstance(
    id: string,
    patch: Partial<Omit<ProviderInstance, "id" | "driver">>,
  ): ProviderInstance {
    const current = this.getProviderInstance(id);
    if (!current) throw new NotFoundError(`provider instance ${id} not found`);
    const next: ProviderInstance = { ...current, ...patch, id, driver: current.driver };
    if (next.maxBudgetUsd !== null && !(next.maxBudgetUsd > 0)) {
      throw new ValidationError("maxBudgetUsd must be greater than zero");
    }
    if (next.displayName.trim() === "") {
      throw new ValidationError("displayName is required");
    }
    this.db
      .prepare(
        `UPDATE provider_instances SET
           display_name = ?, enabled = ?, binary_path = ?, model = ?,
           max_budget_usd = ?, env = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        next.displayName.trim(),
        next.enabled ? 1 : 0,
        next.binaryPath,
        next.model,
        next.maxBudgetUsd,
        JSON.stringify(next.env),
        id,
      );
    return this.getProviderInstance(id)!;
  }

  /**
   * Deletion is refused while anything points at the entry — a dangling
   * provider reference would crash the next claim. Disable is the "stop
   * using it but keep history resolvable" path.
   */
  deleteProviderInstance(id: string): void {
    if (!this.getProviderInstance(id)) {
      throw new NotFoundError(`provider instance ${id} not found`);
    }
    const referenced = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM projects WHERE default_provider = ?1)
              + (SELECT COUNT(*) FROM tickets WHERE provider = ?1)
              + (SELECT COUNT(*) FROM automations WHERE provider = ?1) AS n`,
      )
      .get(id) as Row;
    if (Number(referenced.n) > 0) {
      throw new ValidationError(
        `provider instance ${id} is still referenced by a project, ticket, or automation — disable it instead`,
      );
    }
    this.db.prepare("DELETE FROM provider_instances WHERE id = ?").run(id);
  }

  // -- auth (ADR-0006) ----------------------------------------------------
  //
  // One GitHub account per app instance (id CHECK = 1). No audit events:
  // sign-in is operator identity, not ticket work. The ciphertext is opaque
  // to the store; GitHubAuth owns encrypt/decrypt via its SecretCipher.

  getAuthAccount(): { user: AuthUser; tokenCiphertext: Uint8Array; plaintextFallback: boolean; scopes: string } | null {
    const row = this.db.prepare("SELECT * FROM auth_account WHERE id = 1").get() as
      | Row
      | undefined;
    if (row === undefined) return null;
    return {
      user: {
        login: String(row.login),
        name: row.name === null ? null : String(row.name),
        email: row.email === null ? null : String(row.email),
        avatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
      },
      tokenCiphertext: row.token_ciphertext as Uint8Array,
      plaintextFallback: Number(row.token_plaintext_fallback) === 1,
      scopes: String(row.scopes),
    };
  }

  saveAuthAccount(input: {
    user: AuthUser;
    tokenCiphertext: Uint8Array;
    plaintextFallback: boolean;
    scopes: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_account (id, token_ciphertext, token_plaintext_fallback, login, name, email, avatar_url, scopes, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token_ciphertext = excluded.token_ciphertext,
           token_plaintext_fallback = excluded.token_plaintext_fallback,
           login = excluded.login,
           name = excluded.name,
           email = excluded.email,
           avatar_url = excluded.avatar_url,
           scopes = excluded.scopes,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.tokenCiphertext,
        input.plaintextFallback ? 1 : 0,
        input.user.login,
        input.user.name,
        input.user.email,
        input.user.avatarUrl,
        input.scopes,
        nowIso(),
        nowIso(),
      );
  }

  deleteAuthAccount(): void {
    this.db.prepare("DELETE FROM auth_account WHERE id = 1").run();
  }

  // -- workflow drafts (ticket 47) ---------------------------------------
  //
  // The mutable editing layer over immutable versions (ADR-0004). A draft
  // lives in its own table as a JSON blob: claims resolve workflow_versions
  // and can never see it. Same audit carve-out as the library ops above.

  /**
   * The head version in Draft shape, read-only (ticket 48): the editor's
   * opening render. Never creates a draft — an open is not an edit.
   */
  getWorkflowHeadGraph(workflowId: number): WorkflowHeadGraph {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError(`workflow ${workflowId} not found`);
    const head = this.getWorkflowGraph(this.headVersionId(workflowId));
    return {
      workflowId,
      version: head.version,
      hasDraft: this.readDraft(workflowId) !== undefined,
      graph: draftGraphFromVersion(head),
    };
  }

  /** Get-or-create: first touch cuts the Draft from the head version. */
  getWorkflowDraft(workflowId: number): WorkflowDraft {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError(`workflow ${workflowId} not found`);
    const existing = this.readDraft(workflowId);
    if (existing) return existing;
    const head = this.getWorkflowGraph(this.headVersionId(workflowId));
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO workflow_drafts (workflow_id, base_version, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(workflowId, head.version, JSON.stringify(draftGraphFromVersion(head)), now, now);
    return this.readDraft(workflowId)!;
  }

  /**
   * Replace the Draft's graph — the one mutation surface (the editor and the
   * builder chat both funnel through it). Shape-checked only: a mid-edit
   * draft may be as invalid as it likes; the validator gates publish.
   */
  updateWorkflowDraft(workflowId: number, graph: unknown): WorkflowDraft {
    this.getWorkflowDraft(workflowId);
    const parsed = parseDraftGraph(graph);
    this.db
      .prepare("UPDATE workflow_drafts SET graph = ?, updated_at = ? WHERE workflow_id = ?")
      .run(JSON.stringify(parsed), nowIso(), workflowId);
    return this.readDraft(workflowId)!;
  }

  /** The full violation list, never first-failure (ticket 47). */
  validateWorkflowDraft(workflowId: number): DraftViolation[] {
    return validateDraftGraph(this.getWorkflowDraft(workflowId).graph);
  }

  /**
   * Validate, then append the Draft as the new immutable head and clear it —
   * one transaction. The previous head and every pinned Run are untouched;
   * Projects following the workflow pick the new head up at their next claim.
   */
  publishWorkflowDraft(workflowId: number): WorkflowListing {
    const draft = this.getWorkflowDraft(workflowId);
    const violations = validateDraftGraph(draft.graph);
    if (violations.length > 0) throw new DraftInvalidError(violations);
    const published = withTransaction(this.db, () => {
      const head = this.getWorkflowGraph(this.headVersionId(workflowId));
      const versionResult = this.db
        .prepare("INSERT INTO workflow_versions (workflow_id, version, created_at) VALUES (?, ?, ?)")
        .run(workflowId, head.version + 1, nowIso());
      const versionId = Number(versionResult.lastInsertRowid);
      const insertNode = this.db.prepare(
        "INSERT INTO workflow_nodes (workflow_version_id, type, name, prompt_template, gate_requirements, emits_checks, boots_preview) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const nodeIds = new Map<string, number>();
      for (const node of draft.graph.nodes) {
        const nodeResult = insertNode.run(
          versionId,
          node.type,
          node.name,
          node.promptTemplate,
          node.gateRequirements.length === 0 ? null : JSON.stringify(node.gateRequirements),
          node.emitsChecks ? 1 : 0,
          node.bootsPreview ? 1 : 0,
        );
        nodeIds.set(node.key, Number(nodeResult.lastInsertRowid));
        this.insertSteps(Number(nodeResult.lastInsertRowid), node.steps);
      }
      const insertEdge = this.db.prepare(
        "INSERT INTO workflow_edges (workflow_version_id, from_node_id, to_node_id, condition_label) VALUES (?, ?, ?, ?)",
      );
      for (const edge of draft.graph.edges) {
        insertEdge.run(versionId, nodeIds.get(edge.from)!, nodeIds.get(edge.to)!, edge.conditionLabel);
      }
      this.db.prepare("DELETE FROM workflow_drafts WHERE workflow_id = ?").run(workflowId);
      return this.getWorkflow(workflowId)!;
    });
    return this.listingFor(published);
  }

  /** Throw the Draft away; the head version is untouched by construction. */
  discardWorkflowDraft(workflowId: number): WorkflowListing {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError(`workflow ${workflowId} not found`);
    this.db.prepare("DELETE FROM workflow_drafts WHERE workflow_id = ?").run(workflowId);
    return this.listingFor(workflow);
  }

  private readDraft(workflowId: number): WorkflowDraft | undefined {
    const row = this.db
      .prepare("SELECT * FROM workflow_drafts WHERE workflow_id = ?")
      .get(workflowId);
    if (!row) return undefined;
    return {
      workflowId: Number(row.workflow_id),
      baseVersion: Number(row.base_version),
      graph: JSON.parse(String(row.graph)) as DraftGraph,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // -------------------------------------------------------------------------
  // AI ticket intake (pre-Backlog): sessions are JSON-blob state like
  // workflow_drafts — nothing queries inside transcript/draft; approval
  // materializes the draft through createTicket and keeps only the pointer.

  createIntakeSession(input: {
    projectId: number;
    repoId: number;
    /** A ProviderInstance id. */
    provider: string;
    kind: IntakeKind;
    intent: string;
  }): IntakeSession {
    const project = this.getProject(input.projectId);
    if (!project) throw new NotFoundError(`project ${input.projectId} not found`);
    const repo = this.getRepo(input.repoId);
    if (!repo) throw new NotFoundError(`repo ${input.repoId} not found`);
    if (repo.projectId !== input.projectId) {
      throw new ValidationError(`repo ${input.repoId} belongs to another project`);
    }
    const now = nowIso();
    const result = this.db
      .prepare(
        "INSERT INTO intake_sessions (project_id, repo_id, provider, kind, intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.projectId, input.repoId, input.provider, input.kind, input.intent, now, now);
    return this.getIntakeSession(Number(result.lastInsertRowid))!;
  }

  getIntakeSession(id: number): IntakeSession | undefined {
    const row = this.db.prepare("SELECT * FROM intake_sessions WHERE id = ?").get(id);
    if (row === undefined) return undefined;
    return {
      id: Number(row.id),
      projectId: Number(row.project_id),
      repoId: Number(row.repo_id),
      provider: String(row.provider),
      status: String(row.status) as IntakeStatus,
      kind: String(row.kind) as IntakeKind,
      intent: String(row.intent),
      transcript: JSON.parse(String(row.transcript)) as IntakeTurn[],
      // One storage column, two shapes: the session's kind says which.
      draft:
        row.draft === null || String(row.kind) === "initiative"
          ? null
          : (JSON.parse(String(row.draft)) as IntakeDraft),
      breakdown:
        row.draft === null || String(row.kind) !== "initiative"
          ? null
          : (JSON.parse(String(row.draft)) as IntakeBreakdown),
      ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Open sessions only — the "resume drafting" list; finished ones are history. */
  listIntakeSessions(projectId: number): IntakeSession[] {
    return this.db
      .prepare(
        "SELECT id FROM intake_sessions WHERE project_id = ? AND status IN ('active', 'drafted') ORDER BY id DESC",
      )
      .all(projectId)
      .map((row) => this.getIntakeSession(Number(row.id))!);
  }

  /** Replace transcript (and draft/breakdown, when the agent produced one)
   *  after a turn. Both shapes share the draft storage column. */
  updateIntakeSession(
    id: number,
    patch: {
      transcript: IntakeTurn[];
      draft?: IntakeDraft | null;
      breakdown?: IntakeBreakdown | null;
    },
  ): IntakeSession {
    const session = this.getIntakeSession(id);
    if (!session) throw new NotFoundError(`intake session ${id} not found`);
    const stored = patch.breakdown ?? patch.draft;
    const draft = stored === undefined ? (session.draft ?? session.breakdown) : stored;
    const status = draft !== null ? "drafted" : "active";
    this.db
      .prepare(
        "UPDATE intake_sessions SET transcript = ?, draft = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(patch.transcript),
        draft === null ? null : JSON.stringify(draft),
        status,
        nowIso(),
        id,
      );
    return this.getIntakeSession(id)!;
  }

  /**
   * Materialize the (possibly human-edited) draft into a real ticket.
   * createTicket owns its transaction and bus emissions; the session update
   * after it is best-effort bookkeeping — a crash between the two leaves a
   * drafted session pointing at nothing, which discard cleans up.
   */
  approveIntakeSession(
    id: number,
    input: { title: string; description: string; acceptanceCriteria: string[] },
  ): { session: IntakeSession; ticket: TicketWithAcs } {
    const session = this.getIntakeSession(id);
    if (!session) throw new NotFoundError(`intake session ${id} not found`);
    if (session.status !== "drafted" && session.status !== "active") {
      throw new StateError(`intake session ${id} is ${session.status}`);
    }
    if (session.kind === "initiative") {
      throw new StateError("initiative sessions approve a breakdown, not a single draft");
    }
    const ticket = this.createTicket({
      projectId: session.projectId,
      kind: session.kind,
      ...input,
    });
    this.db
      .prepare("UPDATE intake_sessions SET status = 'approved', ticket_id = ?, updated_at = ? WHERE id = ?")
      .run(ticket.id, nowIso(), id);
    return { session: this.getIntakeSession(id)!, ticket };
  }

  /**
   * Materialize an initiative breakdown's tickets into the Backlog. The
   * emitted tickets leave the breakdown; remaining fog (Not yet specified)
   * keeps the session open for another round of grilling — the session only
   * closes when nothing sharp or foggy remains.
   */
  approveIntakeBreakdown(
    id: number,
    breakdown: IntakeBreakdown,
    ticketInputs: Array<{
      kind: TicketKind;
      title: string;
      description: string;
      acceptanceCriteria: string[];
    }>,
  ): { session: IntakeSession; tickets: TicketWithAcs[] } {
    const session = this.getIntakeSession(id);
    if (!session) throw new NotFoundError(`intake session ${id} not found`);
    if (session.kind !== "initiative") {
      throw new StateError("only initiative sessions carry a breakdown");
    }
    if (session.status !== "drafted" && session.status !== "active") {
      throw new StateError(`intake session ${id} is ${session.status}`);
    }
    const tickets = ticketInputs.map((input) =>
      this.createTicket({ projectId: session.projectId, ...input }),
    );
    const remaining: IntakeBreakdown = { ...breakdown, tickets: [] };
    const done = remaining.notYetSpecified.length === 0;
    this.db
      .prepare("UPDATE intake_sessions SET draft = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(remaining), done ? "approved" : "drafted", nowIso(), id);
    return { session: this.getIntakeSession(id)!, tickets };
  }

  discardIntakeSession(id: number): IntakeSession {
    const session = this.getIntakeSession(id);
    if (!session) throw new NotFoundError(`intake session ${id} not found`);
    this.db
      .prepare("UPDATE intake_sessions SET status = 'discarded', updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    return this.getIntakeSession(id)!;
  }

  private stepsForNode(nodeId: number): WorkflowStep[] {
    return this.db
      .prepare("SELECT * FROM workflow_steps WHERE node_id = ? ORDER BY position, id")
      .all(nodeId)
      .map((row) => ({
        id: Number(row.id),
        nodeId: Number(row.node_id),
        position: Number(row.position),
        type: String(row.type) as WorkflowStepType,
        title: String(row.title),
        prompt: String(row.prompt),
      }));
  }

  private insertSteps(nodeId: number, steps: DraftStep[]): void {
    const insert = this.db.prepare(
      "INSERT INTO workflow_steps (node_id, position, type, title, prompt) VALUES (?, ?, ?, ?, ?)",
    );
    steps.forEach((step, position) => insert.run(nodeId, position, step.type, step.title, step.prompt));
  }

  /** Archived or deleted is never a new choice — the shared gate for every selection surface. */
  private selectableWorkflow(id: number): Workflow {
    const workflow = this.getWorkflow(id);
    if (!workflow || workflow.deletedAt !== null) {
      throw new NotFoundError(`workflow ${id} not found`);
    }
    if (workflow.archived) {
      throw new ValidationError(`workflow "${workflow.name}" is archived and cannot be selected`);
    }
    return workflow;
  }

  private defaultWorkflow(): Workflow {
    const row = this.db.prepare("SELECT * FROM workflows WHERE is_default = 1").get();
    if (!row) throw new Error("no default workflow — the invariant is broken");
    return workflowFromRow(row);
  }

  /** What a claim pins: the workflow's newest version. */
  private headVersionId(workflowId: number): number {
    const row = this.db
      .prepare(
        "SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(workflowId);
    if (!row) throw new Error(`workflow ${workflowId} has no versions`);
    return Number(row.id);
  }

  private listingFor(workflow: Workflow): WorkflowListing {
    const graph = this.getWorkflowGraph(this.headVersionId(workflow.id));
    const usedBy = this.db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE workflow_id = ? AND deleted_at IS NULL")
      .get(workflow.id)!;
    return {
      ...workflow,
      version: graph.version,
      phases: previewPhases(graph).map((node) => node.name),
      usedByProjects: Number(usedBy.n),
      deletable: !workflow.isDefault && Number(usedBy.n) === 0,
      hasDraft:
        this.db
          .prepare("SELECT 1 AS one FROM workflow_drafts WHERE workflow_id = ?")
          .get(workflow.id) !== undefined,
    };
  }

  /**
   * The completed-phase credit a fresh Run inherits from its predecessor
   * (phase-level resume): the latest earlier Run of the same ticket that
   * crashed on the same pinned workflow version in the same worktree, mapped
   * node id → declared outcome. Only that exact shape is creditable — a
   * different version renumbers nodes, a different worktree means the work
   * isn't on disk, and a completed predecessor means a bounce cycle, which
   * must re-run every phase against its follow-up criteria.
   */
  priorPhaseCredit(run: Run, worktreePath: string): Map<number, string | null> {
    const credit = new Map<number, string | null>();
    const prior = this.db
      .prepare(
        `SELECT id FROM runs
         WHERE ticket_id = ? AND id < ? AND state = 'crashed'
           AND workflow_version_id = ? AND worktree_path = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(run.ticketId, run.id, run.workflowVersionId, worktreePath);
    if (prior === undefined) return credit;
    for (const phase of this.listPhaseExecutions(Number(prior.id))) {
      if (phase.state === "completed") credit.set(phase.nodeId, phase.outcome);
    }
    return credit;
  }

  /**
   * A phase carried over from the prior crashed Run without re-running it
   * (phase-level resume). The row lands completed with zero duration; the
   * audit event says "resumed", never "completed" — replaying a phase and
   * crediting one must stay distinguishable in the trail.
   */
  recordResumedPhase(
    runId: number,
    node: { id: number; name: string },
    outcome: string | null,
  ): PhaseExecution {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const { execution, ticket, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      const result = this.db
        .prepare(
          `INSERT INTO phase_executions (run_id, node_id, phase, state, outcome, started_at, ended_at)
           VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
        )
        .run(runId, node.id, node.name, outcome, now, now);
      const execution = this.getPhaseExecution(Number(result.lastInsertRowid))!;
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "phase.resumed",
        detail: { runId, phase: node.name, ...(outcome === null ? {} : { outcome }) },
      });
      return { execution, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.phase_changed", {
      runId,
      ticketId: ticket.id,
      phase: execution.phase,
      status: "completed",
    });
    return execution;
  }

  startPhase(runId: number, node: { id: number; name: string }): PhaseExecution {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const { execution, ticket, audit } = withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          "INSERT INTO phase_executions (run_id, node_id, phase, state, started_at) VALUES (?, ?, ?, 'running', ?)",
        )
        .run(runId, node.id, node.name, nowIso());
      const execution = this.getPhaseExecution(Number(result.lastInsertRowid))!;
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "phase.started",
        detail: { runId, phase: node.name },
      });
      return { execution, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.phase_changed", {
      runId,
      ticketId: ticket.id,
      phase: execution.phase,
      status: "started",
    });
    return execution;
  }

  endPhase(
    executionId: number,
    state: "completed" | "crashed",
    detail: {
      failureReason?: string;
      providerSessionId?: string;
      outcome?: string;
      /** How a crashed phase died (ticket 41) — audited distinctly. */
      deathMode?: DeathMode;
    } = {},
  ): PhaseExecution {
    const existing = this.getPhaseExecution(executionId);
    if (!existing) throw new NotFoundError(`phase execution ${executionId} not found`);
    const { failureReason, providerSessionId, outcome, deathMode } = detail;
    const { execution, ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE phase_executions SET state = ?, failure_reason = ?, provider_session_id = ?, outcome = ?, ended_at = ? WHERE id = ?",
        )
        .run(state, failureReason ?? null, providerSessionId ?? null, outcome ?? null, nowIso(), executionId);
      const execution = this.getPhaseExecution(executionId)!;
      const run = this.getRun(execution.runId)!;
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: `phase.${state}`,
        detail: {
          runId: execution.runId,
          phase: execution.phase,
          ...(failureReason === undefined ? {} : { reason: failureReason }),
          ...(deathMode === undefined ? {} : { deathMode }),
        },
      });
      return { execution, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.phase_changed", {
      runId: execution.runId,
      ticketId: ticket.id,
      phase: execution.phase,
      status: execution.state,
    });
    return execution;
  }

  getPhaseExecution(id: number): PhaseExecution | undefined {
    const row = this.db.prepare("SELECT * FROM phase_executions WHERE id = ?").get(id);
    return row === undefined ? undefined : phaseFromRow(row);
  }

  // ---- Automation templates: saved starting points, plain CRUD rows ----

  getAutomationTemplate(id: number): AutomationTemplate | undefined {
    const row = this.db.prepare("SELECT * FROM automation_templates WHERE id = ?").get(id);
    return row === undefined ? undefined : automationTemplateFromRow(row);
  }

  listAutomationTemplates(): AutomationTemplate[] {
    return this.db
      .prepare("SELECT * FROM automation_templates ORDER BY id")
      .all()
      .map(automationTemplateFromRow);
  }

  createAutomationTemplate(input: {
    title: string;
    category?: string;
    priority?: AutomationPriority;
    prompt: string;
  }): AutomationTemplate {
    const now = nowIso();
    const result = this.db
      .prepare(
        "INSERT INTO automation_templates (title, category, priority, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(input.title, input.category ?? "general", input.priority ?? "medium", input.prompt, now, now);
    return this.getAutomationTemplate(Number(result.lastInsertRowid))!;
  }

  updateAutomationTemplate(
    id: number,
    patch: Partial<{ title: string; category: string; priority: AutomationPriority; prompt: string }>,
  ): AutomationTemplate {
    const existing = this.getAutomationTemplate(id);
    if (!existing) throw new NotFoundError(`automation template ${id} not found`);
    const next = { ...existing, ...patch };
    this.db
      .prepare(
        "UPDATE automation_templates SET title = ?, category = ?, priority = ?, prompt = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.title, next.category, next.priority, next.prompt, nowIso(), id);
    return this.getAutomationTemplate(id)!;
  }

  deleteAutomationTemplate(id: number): void {
    const existing = this.getAutomationTemplate(id);
    if (!existing) throw new NotFoundError(`automation template ${id} not found`);
    this.db.prepare("DELETE FROM automation_templates WHERE id = ?").run(id);
  }

  // ---- Automations: recurring agent tasks (see automation-schedule.ts) ----

  getAutomation(id: number): Automation | undefined {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
    return row === undefined ? undefined : automationFromRow(row);
  }

  listAutomations(): AutomationListItem[] {
    const now = new Date();
    return this.db
      .prepare("SELECT * FROM automations ORDER BY id")
      .all()
      .map((row) => {
        const automation = automationFromRow(row);
        const project =
          automation.projectId === null ? undefined : this.getProject(automation.projectId);
        return {
          ...automation,
          projectName: project?.name ?? null,
          nextRunAt: nextAutomationRun(automation, now)?.toISOString() ?? null,
        };
      });
  }

  createAutomation(input: {
    title: string;
    category?: string;
    priority?: AutomationPriority;
    prompt: string;
    cadence?: AutomationCadence;
    timeOfDay?: string | null;
    dayOfWeek?: number | null;
    projectId?: number | null;
    provider?: string | null;
  }): Automation {
    if (input.projectId !== undefined && input.projectId !== null && !this.getProject(input.projectId)) {
      throw new NotFoundError(`project ${input.projectId} not found`);
    }
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO automations
           (title, category, priority, prompt, cadence, time_of_day, day_of_week, project_id, provider, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.title,
        input.category ?? "general",
        input.priority ?? "medium",
        input.prompt,
        input.cadence ?? "manual",
        input.timeOfDay ?? null,
        input.dayOfWeek ?? null,
        input.projectId ?? null,
        input.provider ?? null,
        now,
        now,
      );
    return this.getAutomation(Number(result.lastInsertRowid))!;
  }

  updateAutomation(
    id: number,
    patch: Partial<{
      title: string;
      category: string;
      priority: AutomationPriority;
      prompt: string;
      cadence: AutomationCadence;
      timeOfDay: string | null;
      dayOfWeek: number | null;
      projectId: number | null;
      provider: string | null;
      enabled: boolean;
    }>,
  ): Automation {
    const existing = this.getAutomation(id);
    if (!existing) throw new NotFoundError(`automation ${id} not found`);
    if (patch.projectId !== undefined && patch.projectId !== null && !this.getProject(patch.projectId)) {
      throw new NotFoundError(`project ${patch.projectId} not found`);
    }
    const next = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE automations SET title = ?, category = ?, priority = ?, prompt = ?, cadence = ?,
           time_of_day = ?, day_of_week = ?, project_id = ?, provider = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.category,
        next.priority,
        next.prompt,
        next.cadence,
        next.timeOfDay,
        next.dayOfWeek,
        next.projectId,
        next.provider,
        next.enabled ? 1 : 0,
        nowIso(),
        id,
      );
    return this.getAutomation(id)!;
  }

  deleteAutomation(id: number): void {
    const existing = this.getAutomation(id);
    if (!existing) throw new NotFoundError(`automation ${id} not found`);
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  }

  /**
   * The firing: one real Ticket on the automation's Project, promoted
   * straight to Todo when the Project has a Repo (the pool claims it from
   * there); a repo-less Project keeps the ticket in Backlog. Actor is
   * "human" for a Run-now click, "agent" for the scheduler.
   */
  fireAutomation(id: number, actor: Actor): TicketWithAcs {
    const automation = this.getAutomation(id);
    if (!automation) throw new NotFoundError(`automation ${id} not found`);
    if (automation.projectId === null) {
      throw new StateError(`automation "${automation.title}" has no target project`);
    }
    const project = this.getProject(automation.projectId);
    if (!project) throw new NotFoundError(`project ${automation.projectId} not found`);

    let ticket = this.createTicket({
      projectId: project.id,
      title: automation.title,
      description: automation.prompt,
      acceptanceCriteria: [],
    });
    const repo = this.listRepos(project.id)[0];
    if (repo) {
      ticket = this.promoteTicket(ticket.id, {
        repoId: repo.id,
        provider: automation.provider ?? project.defaultProvider,
      });
    }
    this.db
      .prepare("UPDATE automations SET last_fired_at = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), id);
    const audit = this.insertAudit({
      projectId: project.id,
      ticketId: ticket.id,
      actor,
      type: "automation.fired",
      detail: {
        automationId: id,
        title: automation.title,
        category: automation.category,
        priority: automation.priority,
        cadence: automation.cadence,
        promoted: repo !== undefined,
      },
    });
    this.bus.emit("audit.appended", audit);
    return ticket;
  }

  listProjectAuditEvents(projectId: number): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id")
      .all(projectId)
      .map(auditFromRow);
  }

  listAuditEvents(ticketId: number): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE ticket_id = ? ORDER BY id")
      .all(ticketId)
      .map(auditFromRow);
  }

  private insertAudit(input: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        "INSERT INTO events (project_id, ticket_id, actor, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.projectId,
        input.ticketId,
        input.actor,
        input.type,
        JSON.stringify(input.detail),
        createdAt,
      );
    return { ...input, id: Number(result.lastInsertRowid), createdAt };
  }
}

type Row = Record<string, unknown>;

function ticketFromRow(row: Row): Ticket {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    number: Number(row.number),
    displayKey: String(row.display_key),
    title: String(row.title),
    description: String(row.description),
    state: String(row.state) as Ticket["state"],
    kind: String(row.kind) as Ticket["kind"],
    repoId: row.repo_id === null ? null : Number(row.repo_id),
    provider: row.provider === null ? null : (String(row.provider) as Ticket["provider"]),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    branch: row.branch === null ? null : String(row.branch),
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    prUrl: row.pr_url === null ? null : String(row.pr_url),
    bounceCount: Number(row.bounce_count),
    arrivedByCap: Number(row.arrived_by_cap) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runFromRow(row: Row): Run {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    state: String(row.state) as Run["state"],
    workflowVersionId: Number(row.workflow_version_id),
    worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    crashReason: row.crash_reason === null ? null : String(row.crash_reason),
    createdAt: String(row.created_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
  };
}

function phaseFromRow(row: Row): PhaseExecution {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    nodeId: Number(row.node_id),
    phase: String(row.phase),
    state: String(row.state) as PhaseExecution["state"],
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    outcome: row.outcome === null ? null : String(row.outcome),
    providerSessionId: row.provider_session_id === null ? null : String(row.provider_session_id),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
  };
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    kind: String(row.kind),
    name: String(row.name),
    path: String(row.path),
    contentHash: String(row.content_hash),
    worktreeHeadSha: String(row.worktree_head_sha),
    createdAt: String(row.created_at),
  };
}

function repoFromRow(row: Row): Repo {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    path: String(row.path),
    githubRemote: row.github_remote === null ? null : String(row.github_remote),
    targetBranch: String(row.target_branch),
    previewCommand: row.preview_command === null ? null : String(row.preview_command),
    previewKind: row.preview_kind === null ? null : (String(row.preview_kind) as Repo["previewKind"]),
    previewReadinessPath:
      row.preview_readiness_path === null ? null : String(row.preview_readiness_path),
    previewReadinessTimeoutMs:
      row.preview_readiness_timeout_ms === null ? null : Number(row.preview_readiness_timeout_ms),
    testCommand: row.test_command === null ? null : String(row.test_command),
    personaPath: row.persona_path === null ? null : String(row.persona_path),
    createdAt: String(row.created_at),
  };
}

function previewFromRow(row: Row): PreviewRecord {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    port: row.port === null ? null : Number(row.port),
    status: String(row.status) as PreviewRecord["status"],
    logPath: row.log_path === null ? null : String(row.log_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function acFromRow(row: Row): AcceptanceCriterion {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    text: String(row.text),
    position: Number(row.position),
    status: String(row.status) as AcceptanceCriterion["status"],
    origin: String(row.origin) as AcceptanceCriterion["origin"],
    provenance:
      row.provenance === null ? null : (String(row.provenance) as AcceptanceCriterion["provenance"]),
    waiveReason: row.waive_reason === null ? null : String(row.waive_reason),
    check:
      row.check_id === null || row.check_id === undefined
        ? null
        : {
            id: Number(row.check_id),
            acId: Number(row.id),
            runId: Number(row.check_run_id),
            kind: String(row.check_kind) as AcCheck["kind"],
            scriptPath: row.check_script_path === null ? null : String(row.check_script_path),
            reason: row.check_reason === null ? null : String(row.check_reason),
            createdAt: String(row.check_created_at),
            updatedAt: String(row.check_updated_at),
          },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function gateResultFromRow(row: Row): GateResult {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    gate: String(row.gate),
    status: String(row.status) as GateResult["status"],
    detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
    acId: row.ac_id === null ? null : Number(row.ac_id),
    createdAt: String(row.created_at),
  };
}

function auditFromRow(row: Row): AuditEvent {
  return {
    id: Number(row.id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
    actor: String(row.actor) as AuditEvent["actor"],
    type: String(row.type),
    detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function providerInstanceFromRow(row: Row): ProviderInstance {
  let env: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.env));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      env = parsed as Record<string, string>;
    }
  } catch {
    // A hand-edited database should not stop the app booting; an unreadable
    // env reads as none, and the next save rewrites it.
  }
  return {
    id: String(row.id),
    driver: String(row.driver) as ProviderName,
    displayName: String(row.display_name),
    enabled: Number(row.enabled) === 1,
    binaryPath: row.binary_path === null ? null : String(row.binary_path),
    model: row.model === null ? null : String(row.model),
    maxBudgetUsd: row.max_budget_usd === null ? null : Number(row.max_budget_usd),
    env,
  };
}

function projectFromRow(row: Row): Project {
  return {
    id: Number(row.id),
    name: String(row.name),
    ticketPrefix: String(row.ticket_prefix),
    defaultProvider: String(row.default_provider) as Project["defaultProvider"],
    workflowId: Number(row.workflow_id),
    workflowConfirmed: Number(row.workflow_confirmed) === 1,
    hiddenAt: row.hidden_at === null ? null : String(row.hidden_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
    createdAt: String(row.created_at),
  };
}

function workflowFromRow(row: Row): Workflow {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    color: row.color === null || row.color === undefined ? null : String(row.color),
    icon: row.icon === null || row.icon === undefined ? null : String(row.icon),
    archived: Number(row.archived) === 1,
    isDefault: Number(row.is_default) === 1,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
    createdAt: String(row.created_at),
  };
}

function workflowNodeFromRow(row: Row, steps: WorkflowStep[] = []): WorkflowNode {
  return {
    id: Number(row.id),
    workflowVersionId: Number(row.workflow_version_id),
    type: String(row.type) as WorkflowNode["type"],
    name: String(row.name),
    promptTemplate: row.prompt_template === null ? null : String(row.prompt_template),
    emitsChecks: Number(row.emits_checks) === 1,
    bootsPreview: Number(row.boots_preview) === 1,
    gateRequirements:
      row.gate_requirements === null ? [] : (JSON.parse(String(row.gate_requirements)) as string[]),
    steps,
  };
}

/** The Draft's starting content: the head version, keyed for editing. */
function draftGraphFromVersion(graph: WorkflowGraph): DraftGraph {
  const keyOf = new Map(graph.nodes.map((node) => [node.id, `n${node.id}`]));
  return {
    nodes: graph.nodes.map((node) => ({
      key: keyOf.get(node.id)!,
      type: node.type,
      name: node.name,
      promptTemplate: node.promptTemplate,
      emitsChecks: node.emitsChecks,
      bootsPreview: node.bootsPreview,
      gateRequirements: node.gateRequirements,
      steps: node.steps.map((step) => ({ type: step.type, title: step.title, prompt: step.prompt })),
    })),
    edges: graph.edges.map((edge) => ({
      from: keyOf.get(edge.fromNodeId)!,
      to: keyOf.get(edge.toNodeId)!,
      conditionLabel: edge.conditionLabel,
    })),
  };
}

/**
 * Shape check for the draft-mutation surface: structural honesty only (a
 * graph the editor can render and publish can materialize), never the
 * publish rules — those are the validator's, at publish time.
 */
function parseDraftGraph(value: unknown): DraftGraph {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("the draft graph must be an object with nodes and edges");
  }
  const { nodes, edges } = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new ValidationError("the draft graph must carry nodes[] and edges[]");
  }
  const keys = new Set<string>();
  const parsedNodes: DraftNode[] = nodes.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`node ${index} is not an object`);
    }
    const node = raw as Record<string, unknown>;
    if (typeof node.key !== "string" || node.key === "") {
      throw new ValidationError(`node ${index} needs a non-empty string key`);
    }
    if (keys.has(node.key)) throw new ValidationError(`node key "${node.key}" is used twice`);
    keys.add(node.key);
    if (node.type !== "trigger" && node.type !== "agent_phase") {
      throw new ValidationError(`node "${node.key}" has unknown type ${JSON.stringify(node.type)}`);
    }
    if (typeof node.name !== "string") {
      throw new ValidationError(`node "${node.key}" needs a string name`);
    }
    if (node.promptTemplate !== null && typeof node.promptTemplate !== "string") {
      throw new ValidationError(`node "${node.key}" promptTemplate must be a string or null`);
    }
    if (typeof node.emitsChecks !== "boolean" || typeof node.bootsPreview !== "boolean") {
      throw new ValidationError(`node "${node.key}" emitsChecks/bootsPreview must be booleans`);
    }
    if (
      !Array.isArray(node.gateRequirements) ||
      node.gateRequirements.some((item) => typeof item !== "string")
    ) {
      throw new ValidationError(`node "${node.key}" gateRequirements must be strings`);
    }
    if (!Array.isArray(node.steps)) {
      throw new ValidationError(`node "${node.key}" steps must be an array`);
    }
    const steps: DraftStep[] = node.steps.map((rawStep, stepIndex) => {
      const step = (rawStep ?? {}) as Record<string, unknown>;
      if (!(WORKFLOW_STEP_TYPES as readonly string[]).includes(String(step.type))) {
        throw new ValidationError(
          `node "${node.key}" step ${stepIndex} has unknown type ${JSON.stringify(step.type)}`,
        );
      }
      if (typeof step.title !== "string" || typeof step.prompt !== "string") {
        throw new ValidationError(`node "${node.key}" step ${stepIndex} needs title and prompt strings`);
      }
      return { type: step.type as DraftStep["type"], title: step.title, prompt: step.prompt };
    });
    return {
      key: node.key,
      type: node.type,
      name: node.name,
      promptTemplate: node.promptTemplate as string | null,
      emitsChecks: node.emitsChecks,
      bootsPreview: node.bootsPreview,
      gateRequirements: node.gateRequirements as string[],
      steps,
    };
  });
  const parsedEdges = edges.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`edge ${index} is not an object`);
    }
    const edge = raw as Record<string, unknown>;
    if (typeof edge.from !== "string" || !keys.has(edge.from)) {
      throw new ValidationError(`edge ${index} "from" does not name a node key`);
    }
    if (typeof edge.to !== "string" || !keys.has(edge.to)) {
      throw new ValidationError(`edge ${index} "to" does not name a node key`);
    }
    if (edge.conditionLabel !== null && typeof edge.conditionLabel !== "string") {
      throw new ValidationError(`edge ${index} conditionLabel must be a string or null`);
    }
    return { from: edge.from, to: edge.to, conditionLabel: edge.conditionLabel as string | null };
  });
  return { nodes: parsedNodes, edges: parsedEdges };
}

function automationTemplateFromRow(row: Row): AutomationTemplate {
  return {
    id: Number(row.id),
    title: String(row.title),
    category: String(row.category),
    priority: String(row.priority) as AutomationPriority,
    prompt: String(row.prompt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function automationFromRow(row: Row): Automation {
  return {
    id: Number(row.id),
    title: String(row.title),
    category: String(row.category),
    priority: String(row.priority) as AutomationPriority,
    prompt: String(row.prompt),
    cadence: String(row.cadence) as AutomationCadence,
    timeOfDay: row.time_of_day === null ? null : String(row.time_of_day),
    dayOfWeek: row.day_of_week === null ? null : Number(row.day_of_week),
    projectId: row.project_id === null ? null : Number(row.project_id),
    provider: row.provider === null ? null : (String(row.provider) as Automation["provider"]),
    enabled: Number(row.enabled) === 1,
    lastFiredAt: row.last_fired_at === null ? null : String(row.last_fired_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function workflowEdgeFromRow(row: Row): WorkflowEdge {
  return {
    id: Number(row.id),
    workflowVersionId: Number(row.workflow_version_id),
    fromNodeId: Number(row.from_node_id),
    toNodeId: Number(row.to_node_id),
    conditionLabel: row.condition_label === null ? null : String(row.condition_label),
  };
}
