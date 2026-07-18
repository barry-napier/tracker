import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema changes are append-only: never edit a shipped migration, add a new one.
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ticket_prefix TEXT NOT NULL DEFAULT 'TRK',
        next_ticket_number INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        number INTEGER NOT NULL,
        display_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'backlog',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, number)
      );

      CREATE TABLE acceptance_criteria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        text TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        origin TEXT NOT NULL DEFAULT 'original',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        ticket_id INTEGER REFERENCES tickets(id),
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

      CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL,
        github_remote TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'main',
        preview_command TEXT,
        preview_kind TEXT,
        preview_readiness_path TEXT,
        created_at TEXT NOT NULL
      );

      ALTER TABLE projects ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'claude-code';
      ALTER TABLE tickets ADD COLUMN repo_id INTEGER REFERENCES repos(id);
      ALTER TABLE tickets ADD COLUMN provider TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        state TEXT NOT NULL DEFAULT 'running',
        worktree_path TEXT,
        crash_reason TEXT,
        created_at TEXT NOT NULL,
        ended_at TEXT
      );

      ALTER TABLE tickets ADD COLUMN external_ref TEXT;
      ALTER TABLE tickets ADD COLUMN branch TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE workflow_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id),
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt_template TEXT
      );

      CREATE TABLE workflow_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id),
        from_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
        to_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
        condition_label TEXT
      );

      CREATE TABLE phase_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
        phase TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'running',
        failure_reason TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      -- Seed workflow (ADR-0001: seed data, not engine shape). This slice
      -- runs a single phase; slice 27 extends the seed to the full five.
      INSERT INTO workflows (id, name, created_at) VALUES (1, 'core-loop', datetime('now'));
      INSERT INTO workflow_nodes (id, workflow_id, type, name, prompt_template) VALUES
        (1, 1, 'trigger', 'ticket-claimed', NULL),
        (2, 1, 'agent_phase', 'implement',
          'You are implementing ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
          '{{description}}' || char(10) || char(10) ||
          'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
          'Work in the current directory on branch {{branch}} (target: {{targetBranch}}). ' ||
          'Commit as you go. Before finishing, write kb/{{phase}}.md summarizing what you did and why.');
      INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, condition_label)
        VALUES (1, 1, 2, NULL);
    `,
  },
];

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "tracker.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
  }
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
