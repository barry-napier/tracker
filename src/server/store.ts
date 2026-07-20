import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { walkPhases } from "./graph.ts";
import { branchNameFor, type WorktreeResult } from "./worktrees.ts";
import type { CheckRegistration } from "./checks.ts";
import { PROVIDERS } from "./types.ts";
import type {
  AcceptanceCriterion,
  AcCheck,
  Actor,
  Artifact,
  AuditEvent,
  FollowUpSeed,
  GateResult,
  GateStatus,
  PhaseExecution,
  PreviewKind,
  PreviewRecord,
  PreviewStatus,
  Project,
  ProviderConfig,
  ProviderName,
  Repo,
  ReviewBounceReason,
  ReviewStepMark,
  Run,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
  TreeState,
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowListing,
  WorkflowNode,
} from "./types.ts";

export type { TicketWithAcs } from "./types.ts";

export class NotFoundError extends Error {}
/** A mutation that is well-formed but illegal in the ticket's current state. */
export class StateError extends Error {}
/** A mutation whose referenced rows don't fit together (e.g. cross-project repo). */
export class ValidationError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

/** Three failed cycles matches observed agent convergence (ticket 06 §6). */
const BOUNCE_CAP = 3;

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
    defaultProvider?: ProviderName;
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
          "INSERT INTO projects (name, ticket_prefix, default_provider, workflow_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.name,
          input.ticketPrefix ?? "TRK",
          input.defaultProvider ?? "claude-code",
          workflow.id,
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
   * Event ids order the same as time and never tie. Hidden projects (ticket
   * 50) are the one exclusion; getProject still resolves them.
   */
  listProjects(): Project[] {
    return this.db
      .prepare(
        `SELECT p.* FROM projects p
         LEFT JOIN (SELECT project_id, MAX(id) AS last_event FROM events GROUP BY project_id) e
           ON e.project_id = p.id
         WHERE p.hidden_at IS NULL
         ORDER BY COALESCE(e.last_event, 0) DESC, p.id DESC`,
      )
      .all()
      .map(projectFromRow);
  }

  /**
   * Remove from Home's recents (ticket 50): forget the list entry, delete
   * nothing — tickets, runs, and the audit trail all stay, and the project
   * still resolves by id. Recovery is re-adding the checkout (Home.addLocal).
   */
  hideProject(id: number): Project {
    return this.setProjectHidden(id, true);
  }

  /** Undo of hideProject; the unhide audit event also floats the project to
   *  the top of recents, where a just-re-added project belongs. */
  unhideProject(id: number): Project {
    return this.setProjectHidden(id, false);
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
    githubRemote: string;
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
          "INSERT INTO tickets (project_id, number, display_key, title, description, external_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.projectId,
          number,
          displayKey,
          input.title,
          input.description ?? "",
          input.externalRef ?? null,
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
    return { ...ticketFromRow(row), acceptanceCriteria: acs };
  }

  listTickets(projectId?: number): TicketWithAcs[] {
    const rows =
      projectId === undefined
        ? this.db.prepare("SELECT * FROM tickets ORDER BY id").all()
        : this.db.prepare("SELECT * FROM tickets WHERE project_id = ? ORDER BY id").all(projectId);
    return rows.map((row) => this.getTicket(Number(row.id))!);
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
  promoteTicket(id: number, input: { repoId: number; provider: ProviderName }): TicketWithAcs {
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
  claimNextTicket(excludeTicketIds: ReadonlySet<number> = new Set()): {
    ticket: TicketWithAcs;
    run: Run;
    repo: Repo;
  } | undefined {
    const claimed = withTransaction(this.db, () => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM tickets
           WHERE state = 'todo'
              OR (state = 'in_progress' AND NOT EXISTS (
                    SELECT 1 FROM runs WHERE runs.ticket_id = tickets.id AND runs.state = 'running'))
           ORDER BY id`,
        )
        .all();
      const row = candidates.find((c) => !excludeTicketIds.has(Number(c.id)));
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
   * battery arrives in slice 29 and takes it from there); failed and crashed
   * both send it back to Todo for a fresh claim — the distinction matters to
   * the crash policy and bounce machinery of later slices, so it's recorded
   * honestly now.
   */
  finishRun(
    runId: number,
    outcome: "completed" | "failed" | "crashed",
    reason?: string,
  ): Run {
    const existing = this.getRun(runId);
    if (!existing) throw new NotFoundError(`run ${runId} not found`);
    if (existing.state !== "running") {
      throw new StateError(`run ${runId} is ${existing.state}, not running`);
    }
    const ticketState = outcome === "completed" ? "verifying" : "todo";
    const { run, ticket, audit } = withTransaction(this.db, () => {
      const now = nowIso();
      this.db
        .prepare("UPDATE runs SET state = ?, crash_reason = ?, ended_at = ? WHERE id = ?")
        .run(outcome, outcome === "crashed" ? (reason ?? null) : null, now, runId);
      const run = this.getRun(runId)!;
      this.db
        .prepare("UPDATE tickets SET state = ?, updated_at = ? WHERE id = ?")
        .run(ticketState, now, run.ticketId);
      const ticket = this.getTicket(run.ticketId)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: `run.${outcome}`,
        detail: reason === undefined ? { runId } : { runId, reason },
      });
      return { run, ticket, audit };
    });
    this.bus.emit("audit.appended", audit);
    this.bus.emit("run.updated", this.runDetails(run));
    this.bus.emit("ticket.updated", ticket);
    return run;
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
    };
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
        .map(workflowNodeFromRow),
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

  /** The whole library, archived rows included — the listing shows them dimmed. */
  listWorkflows(): WorkflowListing[] {
    return this.db
      .prepare("SELECT * FROM workflows ORDER BY id")
      .all()
      .map((row) => this.listingFor(workflowFromRow(row)));
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
          "INSERT INTO workflows (name, archived, is_default, created_at) VALUES (?, 0, 0, ?)",
        )
        .run(`${source.name} (copy)`, now);
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

  /** Rename edits identity only — every version, past pin, and project follows. */
  renameWorkflow(id: number, name: string): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
    const trimmed = name.trim();
    if (trimmed === "") throw new ValidationError("a workflow needs a name");
    this.db.prepare("UPDATE workflows SET name = ? WHERE id = ?").run(trimmed, id);
    return this.listingFor(this.getWorkflow(id)!);
  }

  /** Exactly one active default at all times; the swap is one transaction. */
  setDefaultWorkflow(id: number): WorkflowListing {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
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
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
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
    this.db.prepare("UPDATE projects SET workflow_id = ? WHERE id = ?").run(workflow.id, projectId);
    return this.getProject(projectId)!;
  }

  /**
   * App-level provider config (ticket 38). A provider with no row yet reads
   * as all-defaults rather than as missing, so every adapter can ask for its
   * config unconditionally and the settings surface always has a row to show.
   */
  getProviderConfig(provider: ProviderName): ProviderConfig {
    const row = this.db
      .prepare("SELECT * FROM provider_config WHERE provider = ?")
      .get(provider) as Row | undefined;
    return row === undefined
      ? { provider, binaryPath: null, model: null, maxBudgetUsd: null, env: {} }
      : providerConfigFromRow(row);
  }

  listProviderConfigs(): ProviderConfig[] {
    return PROVIDERS.map((provider) => this.getProviderConfig(provider));
  }

  /**
   * Patch semantics: an omitted field is left alone, an explicit null clears
   * it back to the default. Without that distinction the settings form could
   * never blank a pinned model once it had been set.
   */
  setProviderConfig(
    provider: ProviderName,
    patch: Partial<Omit<ProviderConfig, "provider">>,
  ): ProviderConfig {
    const current = this.getProviderConfig(provider);
    const next: ProviderConfig = { ...current, ...patch, provider };
    if (next.maxBudgetUsd !== null && !(next.maxBudgetUsd > 0)) {
      throw new ValidationError("maxBudgetUsd must be greater than zero");
    }
    this.db
      .prepare(
        `INSERT INTO provider_config (provider, binary_path, model, max_budget_usd, env, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(provider) DO UPDATE SET
           binary_path = excluded.binary_path,
           model = excluded.model,
           max_budget_usd = excluded.max_budget_usd,
           env = excluded.env,
           updated_at = excluded.updated_at`,
      )
      .run(
        provider,
        next.binaryPath,
        next.model,
        next.maxBudgetUsd,
        JSON.stringify(next.env),
      );
    return this.getProviderConfig(provider);
  }

  /** Archived is never a new choice — the shared gate for every selection surface. */
  private selectableWorkflow(id: number): Workflow {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new NotFoundError(`workflow ${id} not found`);
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
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE workflow_id = ?")
      .get(workflow.id)!;
    return {
      ...workflow,
      version: graph.version,
      phases: walkPhases(graph).map((node) => node.name),
      usedByProjects: Number(usedBy.n),
    };
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
    state: "completed" | "failed" | "crashed",
    detail: { failureReason?: string; providerSessionId?: string; outcome?: string } = {},
  ): PhaseExecution {
    const existing = this.getPhaseExecution(executionId);
    if (!existing) throw new NotFoundError(`phase execution ${executionId} not found`);
    const { failureReason, providerSessionId, outcome } = detail;
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
        detail:
          failureReason === undefined
            ? { runId: execution.runId, phase: execution.phase }
            : { runId: execution.runId, phase: execution.phase, reason: failureReason },
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
    githubRemote: String(row.github_remote),
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

function providerConfigFromRow(row: Row): ProviderConfig {
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
    provider: String(row.provider) as ProviderName,
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
    hiddenAt: row.hidden_at === null ? null : String(row.hidden_at),
    createdAt: String(row.created_at),
  };
}

function workflowFromRow(row: Row): Workflow {
  return {
    id: Number(row.id),
    name: String(row.name),
    archived: Number(row.archived) === 1,
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at),
  };
}

function workflowNodeFromRow(row: Row): WorkflowNode {
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
