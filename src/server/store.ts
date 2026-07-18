import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./bus.ts";
import { withTransaction } from "./db.ts";
import { branchNameFor, type WorktreeResult } from "./worktrees.ts";
import type {
  AcceptanceCriterion,
  Artifact,
  AuditEvent,
  PhaseExecution,
  PreviewKind,
  Project,
  ProviderName,
  Repo,
  Run,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
  WorkflowGraph,
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

/**
 * Canonical state lives in mutable rows; every mutation appends an Audit
 * Trail event as a side effect (never event sourcing — see ticket 05).
 * The audit insert commits in the same transaction as its mutation; SSE
 * emission happens after commit so a rollback can never have been broadcast.
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
  }): Project {
    const { project, audit } = withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          "INSERT INTO projects (name, ticket_prefix, default_provider, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.name, input.ticketPrefix ?? "TRK", input.defaultProvider ?? "claude-code", nowIso());
      const project = this.getProject(Number(result.lastInsertRowid));
      if (!project) throw new Error("project vanished after insert");
      const audit = this.insertAudit({
        projectId: project.id,
        ticketId: null,
        actor: "human",
        type: "project.created",
        detail: { name: project.name },
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

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY id").all().map(projectFromRow);
  }

  createRepo(input: {
    projectId: number;
    path: string;
    githubRemote: string;
    targetBranch?: string;
    previewCommand?: string;
    previewKind?: PreviewKind;
    previewReadinessPath?: string;
  }): Repo {
    const project = this.getProject(input.projectId);
    if (!project) throw new NotFoundError(`project ${input.projectId} not found`);
    const { repo, audit } = withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          "INSERT INTO repos (project_id, path, github_remote, target_branch, preview_command, preview_kind, preview_readiness_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.projectId,
          input.path,
          input.githubRemote,
          input.targetBranch ?? "main",
          input.previewCommand ?? null,
          input.previewKind ?? null,
          input.previewReadinessPath ?? null,
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
      .prepare("SELECT * FROM acceptance_criteria WHERE ticket_id = ? ORDER BY position, id")
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
   * Claim = Run creation (ticket 08, no leases): atomically move the oldest
   * Todo ticket to In Progress, fix its branch name (first claim only), and
   * open the Run. Worktree paths land later via recordWorktree — git is slow
   * and runs outside the transaction.
   */
  claimNextTodoTicket(excludeTicketIds: ReadonlySet<number> = new Set()): {
    ticket: TicketWithAcs;
    run: Run;
    repo: Repo;
  } | undefined {
    const claimed = withTransaction(this.db, () => {
      const candidates = this.db
        .prepare("SELECT id FROM tickets WHERE state = 'todo' ORDER BY id")
        .all();
      const row = candidates.find((c) => !excludeTicketIds.has(Number(c.id)));
      if (row === undefined) return undefined;
      const existing = this.getTicket(Number(row.id))!;
      const repo = this.getRepo(existing.repoId!);
      if (!repo) throw new StateError(`ticket ${existing.displayKey} is todo without a repo`);

      const branch = existing.branch ?? branchNameFor(existing);
      const now = nowIso();
      this.db
        .prepare("UPDATE tickets SET state = 'in_progress', branch = ?, updated_at = ? WHERE id = ?")
        .run(branch, now, existing.id);
      const runResult = this.db
        .prepare("INSERT INTO runs (ticket_id, state, created_at) VALUES (?, 'running', ?)")
        .run(existing.id, now);
      const run = this.getRun(Number(runResult.lastInsertRowid))!;
      const ticket = this.getTicket(existing.id)!;
      const audit = this.insertAudit({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        actor: "agent",
        type: "ticket.claimed",
        detail: { runId: run.id, branch, repoId: repo.id },
      });
      return { ticket, run, repo, audit };
    });
    if (!claimed) return undefined;
    this.bus.emit("audit.appended", claimed.audit);
    this.bus.emit("ticket.updated", claimed.ticket);
    this.bus.emit("run.created", this.runDetails(claimed.run));
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
    };
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

  listPhaseExecutions(runId: number): PhaseExecution[] {
    return this.db
      .prepare("SELECT * FROM phase_executions WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map(phaseFromRow);
  }

  /** The seeded graph every ticket runs until workflows become assignable. */
  getDefaultWorkflow(): WorkflowGraph {
    const workflow = this.db.prepare("SELECT * FROM workflows ORDER BY id LIMIT 1").get();
    if (!workflow) throw new Error("no workflow seeded");
    const id = Number(workflow.id);
    return {
      id,
      name: String(workflow.name),
      nodes: this.db
        .prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id")
        .all(id)
        .map((row) => ({
          id: Number(row.id),
          workflowId: Number(row.workflow_id),
          type: String(row.type) as "trigger" | "agent_phase",
          name: String(row.name),
          promptTemplate: row.prompt_template === null ? null : String(row.prompt_template),
        })),
      edges: this.db
        .prepare("SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id")
        .all(id)
        .map((row) => ({
          id: Number(row.id),
          workflowId: Number(row.workflow_id),
          fromNodeId: Number(row.from_node_id),
          toNodeId: Number(row.to_node_id),
          conditionLabel: row.condition_label === null ? null : String(row.condition_label),
        })),
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
    detail: { failureReason?: string; providerSessionId?: string } = {},
  ): PhaseExecution {
    const existing = this.getPhaseExecution(executionId);
    if (!existing) throw new NotFoundError(`phase execution ${executionId} not found`);
    const { failureReason, providerSessionId } = detail;
    const { execution, ticket, audit } = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE phase_executions SET state = ?, failure_reason = ?, provider_session_id = ?, ended_at = ? WHERE id = ?",
        )
        .run(state, failureReason ?? null, providerSessionId ?? null, nowIso(), executionId);
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
    displayKey: String(row.display_key),
    title: String(row.title),
    description: String(row.description),
    state: String(row.state) as Ticket["state"],
    repoId: row.repo_id === null ? null : Number(row.repo_id),
    provider: row.provider === null ? null : (String(row.provider) as Ticket["provider"]),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    branch: row.branch === null ? null : String(row.branch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runFromRow(row: Row): Run {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    state: String(row.state) as Run["state"],
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
    createdAt: String(row.created_at),
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

function projectFromRow(row: Row): Project {
  return {
    id: Number(row.id),
    name: String(row.name),
    ticketPrefix: String(row.ticket_prefix),
    defaultProvider: String(row.default_provider) as Project["defaultProvider"],
    createdAt: String(row.created_at),
  };
}
