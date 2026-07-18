import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./bus.ts";
import { withTransaction } from "./db.ts";
import type {
  AcceptanceCriterion,
  AuditEvent,
  PreviewKind,
  Project,
  Provider,
  Repo,
  Ticket,
  TicketWithAcs,
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
    defaultProvider?: Provider;
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
          "INSERT INTO tickets (project_id, number, display_key, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.projectId, number, displayKey, input.title, input.description ?? "", now, now);
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
  promoteTicket(id: number, input: { repoId: number; provider: Provider }): TicketWithAcs {
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
