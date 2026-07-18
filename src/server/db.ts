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
  {
    version: 5,
    sql: `
      ALTER TABLE phase_executions ADD COLUMN provider_session_id TEXT;

      -- Reserved for future per-node gating; unused in v1 (ADR-0003).
      ALTER TABLE workflow_nodes ADD COLUMN gate_requirements TEXT;

      -- Blobs live on disk under app data; rows are pointers with a content
      -- hash and the worktree HEAD SHA at persist time (spec 21, Store).
      CREATE TABLE artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        worktree_head_sha TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Extend the seed to the full chain (workflows are data, ADR-0001):
      -- trigger → research → plan → implement → dogfood → document.
      -- Dogfood behaves as a plain scripted phase until slice 36.
      INSERT INTO workflow_nodes (id, workflow_id, type, name, prompt_template) VALUES
        (3, 1, 'agent_phase', 'research',
          'You are researching ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
          '{{description}}' || char(10) || char(10) ||
          'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
          'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
          'Explore the repository in the current directory (branch {{branch}}, target {{targetBranch}}) and understand everything this ticket touches. ' ||
          'Do not change product code. Before finishing, write kb/{{phase}}.md: what you learned, where the work will land, and the risks.'),
        (4, 1, 'agent_phase', 'plan',
          'You are planning ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
          '{{description}}' || char(10) || char(10) ||
          'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
          'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
          'Decide how the work gets done and verified. Do not change product code. ' ||
          'Before finishing, write kb/{{phase}}.md: the implementation plan, step by step, with the seams you will test at.'),
        (5, 1, 'agent_phase', 'dogfood',
          'You are dogfooding ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
          '{{description}}' || char(10) || char(10) ||
          'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
          'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
          'Actually use what was built on branch {{branch}} and judge it as a user would. ' ||
          'Before finishing, write kb/{{phase}}.md: what you tried, what held up, what felt wrong.'),
        (6, 1, 'agent_phase', 'document',
          'You are documenting ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
          '{{description}}' || char(10) || char(10) ||
          'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
          'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
          'Write up the change so a reviewer can judge it quickly. ' ||
          'Before finishing, write kb/{{phase}}.md: what changed, why, and what to review.');

      -- The v4 implement template predates the handoff variable; align it.
      UPDATE workflow_nodes SET prompt_template =
        'You are implementing ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
        '{{description}}' || char(10) || char(10) ||
        'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
        'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
        'Work in the current directory on branch {{branch}} (target: {{targetBranch}}). ' ||
        'Commit as you go. Before finishing, write kb/{{phase}}.md summarizing what you did and why.'
      WHERE id = 2;

      DELETE FROM workflow_edges WHERE workflow_id = 1;
      INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, condition_label) VALUES
        (1, 1, 3, NULL),
        (1, 3, 4, NULL),
        (1, 4, 2, NULL),
        (1, 2, 5, NULL),
        (1, 5, 6, NULL);
    `,
  },
  {
    version: 6,
    sql: `
      -- One registration per AC (upsert keeps re-runs idempotent): how the
      -- battery verifies it — a script in the worktree, or a human in the
      -- Manual Walkthrough. run_id records the latest registering Run.
      CREATE TABLE ac_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ac_id INTEGER NOT NULL UNIQUE REFERENCES acceptance_criteria(id),
        run_id INTEGER NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        script_path TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- The plan node's extended Phase Contract is workflow data, not an
      -- engine special case: any node may declare it emits AC checks. Not
      -- the reserved gate_requirements column (ADR-0003): gates verify a
      -- Run's outcome orchestrator-side after the workflow; emits_checks
      -- extends what the node itself must produce to complete.
      ALTER TABLE workflow_nodes ADD COLUMN emits_checks INTEGER NOT NULL DEFAULT 0;
      UPDATE workflow_nodes SET emits_checks = 1 WHERE id = 4;

      -- Extend the seeded plan template with the AC-check contract.
      UPDATE workflow_nodes SET prompt_template =
        'You are planning ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
        '{{description}}' || char(10) || char(10) ||
        'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
        'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
        'Decide how the work gets done and verified. Do not change product code. ' ||
        'For every pending acceptance criterion (numbered AC-<id> above): if it is machine-checkable, ' ||
        'write an executable script checks/ac-<id>.sh that exits 0 when the criterion holds; ' ||
        'otherwise route it to a human. Then write checks/manifest.json mapping every pending AC id ' ||
        'to its script path or to {"human": "<one-line reason>"} — for example ' ||
        '{"3": "checks/ac-3.sh", "4": {"human": "needs visual judgment"}}. ' ||
        'Before finishing, write kb/{{phase}}.md: the implementation plan, step by step, with the seams you will test at.'
      WHERE id = 4;
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
