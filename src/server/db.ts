import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema changes are append-only: never edit a shipped migration, add a new one.
// rekeysForeignKeys marks a migration that recreates FK'd tables: it runs with
// foreign keys off (the documented SQLite table-rebuild procedure) and proves
// integrity with foreign_key_check before committing.
const MIGRATIONS: Array<{ version: number; sql: string; rekeysForeignKeys?: boolean }> = [
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
  {
    version: 7,
    sql: `
      -- One row per gate execution against a Run (ticket 06): the battery is
      -- diagnostic, so a Run accumulates every gate's result, failures
      -- included. ac_id links agent-authored AC checks to their criterion.
      CREATE TABLE gate_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        gate TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        ac_id INTEGER REFERENCES acceptance_criteria(id),
        created_at TEXT NOT NULL
      );

      -- Who verified an AC (machine = orchestrator-run check, human = wizard
      -- or waive) and why a waived one was retired. Null until either lands.
      ALTER TABLE acceptance_criteria ADD COLUMN provenance TEXT;
      ALTER TABLE acceptance_criteria ADD COLUMN waive_reason TEXT;

      -- The suite gate runs this in the worktree; null = no suite → skip.
      ALTER TABLE repos ADD COLUMN test_command TEXT;

      -- The document node owes the Visual Recap (ticket 11): the artifact
      -- gate reads each node's owed files from gate_requirements.
      UPDATE workflow_nodes SET gate_requirements = '["kb/recap.html"]' WHERE id = 6;
      UPDATE workflow_nodes SET prompt_template =
        'You are documenting ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
        '{{description}}' || char(10) || char(10) ||
        'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
        'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
        'Write up the change so a reviewer can judge it quickly. ' ||
        'Author kb/recap.html — a fully self-contained HTML Visual Recap grounded in the diff: ' ||
        'inline all CSS, reference no external resources whatsoever, and end with a ' ||
        '"What to review" section of 2-5 numbered notes directing the reviewer''s attention. ' ||
        'Before finishing, write kb/{{phase}}.md: what changed, why, and what to review.'
      WHERE id = 6;
    `,
  },
  {
    version: 8,
    sql: `
      -- Bounce machinery (ticket 30): failed cycles are counted on the
      -- Ticket; the third parks it in Human Review flagged arrived-by-cap
      -- so the wizard can say it got there without passing gates.
      ALTER TABLE tickets ADD COLUMN bounce_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tickets ADD COLUMN arrived_by_cap INTEGER NOT NULL DEFAULT 0;

      -- Re-entry context reaches phases through the engine's fixed template
      -- variable set, so the seeded templates must actually reference it:
      -- follow-up criteria born from failures, and the Bounce Report path
      -- ("none" on a first run).
      UPDATE workflow_nodes SET prompt_template = prompt_template || char(10) || char(10) ||
        'Follow-up criteria from bounced attempts: {{followUps}}' || char(10) ||
        'Bounce report from the previous attempt: {{bounceReportPath}}'
      WHERE type = 'agent_phase';
    `,
  },
  {
    version: 9,
    sql: `
      -- GitHub for real (ticket 31): the PR belongs to the Ticket, like the
      -- branch — recorded once the orchestrator observes it on the remote,
      -- stable across bounces (one Ticket = one branch = one PR).
      ALTER TABLE tickets ADD COLUMN pr_number INTEGER;
      ALTER TABLE tickets ADD COLUMN pr_url TEXT;
    `,
  },
  {
    version: 10,
    sql: `
      -- Preview environments (ticket 34): the record follows the worktree —
      -- one row per Ticket, created at first use, reaped by the same sweep
      -- that reaps the worktree. The process itself is in-memory only; the
      -- row holds the bound port, last observed status, and the log pointer.
      CREATE TABLE previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
        port INTEGER,
        status TEXT NOT NULL DEFAULT 'stopped',
        log_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Per-repo readiness override for frameworks that bind early and serve
      -- late (ticket 10); null = the ~60s default.
      ALTER TABLE repos ADD COLUMN preview_readiness_timeout_ms INTEGER;
    `,
  },
  {
    version: 11,
    sql: `
      -- Identity (what Projects reference) stays on workflows; immutable
      -- content moves under workflow_versions. The seeded graph becomes
      -- RPIRD, version 1, the Default Workflow.
      CREATE TABLE workflow_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL REFERENCES workflows(id),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workflow_id, version)
      );

      ALTER TABLE workflows ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workflows ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
      UPDATE workflows SET name = 'RPIRD', is_default = 1 WHERE id = 1;

      INSERT INTO workflow_versions (workflow_id, version, created_at)
        SELECT id, 1, datetime('now') FROM workflows ORDER BY id;

      -- Re-key nodes and edges from workflow to version, ids preserved so
      -- phase_executions.node_id keeps resolving for every past run. Table
      -- rebuilds run with foreign keys off (rekeysForeignKeys).
      CREATE TABLE workflow_nodes_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_version_id INTEGER NOT NULL REFERENCES workflow_versions(id),
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt_template TEXT,
        gate_requirements TEXT,
        emits_checks INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO workflow_nodes_v2 (id, workflow_version_id, type, name, prompt_template, gate_requirements, emits_checks)
        SELECT n.id, v.id, n.type, n.name, n.prompt_template, n.gate_requirements, n.emits_checks
        FROM workflow_nodes n JOIN workflow_versions v ON v.workflow_id = n.workflow_id;
      DROP TABLE workflow_nodes;
      ALTER TABLE workflow_nodes_v2 RENAME TO workflow_nodes;

      CREATE TABLE workflow_edges_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_version_id INTEGER NOT NULL REFERENCES workflow_versions(id),
        from_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
        to_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
        condition_label TEXT
      );
      INSERT INTO workflow_edges_v2 (id, workflow_version_id, from_node_id, to_node_id, condition_label)
        SELECT e.id, v.id, e.from_node_id, e.to_node_id, e.condition_label
        FROM workflow_edges e JOIN workflow_versions v ON v.workflow_id = e.workflow_id;
      DROP TABLE workflow_edges;
      ALTER TABLE workflow_edges_v2 RENAME TO workflow_edges;

      -- Every Project selects a Workflow; every Run pins the version current
      -- at claim. Backfill lands both on RPIRD v1 (ids 1/1 — the only graph
      -- that has ever existed). The column defaults exist only to satisfy
      -- NOT NULL on ALTER; the store always writes both explicitly.
      ALTER TABLE projects ADD COLUMN workflow_id INTEGER NOT NULL DEFAULT 1 REFERENCES workflows(id);
      ALTER TABLE runs ADD COLUMN workflow_version_id INTEGER NOT NULL DEFAULT 1 REFERENCES workflow_versions(id);
    `,
    rekeysForeignKeys: true,
  },
  {
    version: 12,
    sql: `
      -- The dogfood phase becomes real (ticket 36). The node needs a live
      -- Preview Environment before it runs and the vendored dogfood playbook
      -- in its prompt; boots_preview marks the node the engine boots a preview
      -- for and hands the dogfood asset variables to (parallel to emits_checks
      -- — a per-node capability, not an engine special case).
      ALTER TABLE workflow_nodes ADD COLUMN boots_preview INTEGER NOT NULL DEFAULT 0;
      UPDATE workflow_nodes SET boots_preview = 1 WHERE name = 'dogfood';

      -- Persona (ticket 11 §2, CONTEXT.md): an optional per-Repo markdown file
      -- giving the experiential judge a user's lens. Null = no persona → the
      -- report says the experiential judge was skipped; never faked.
      ALTER TABLE repos ADD COLUMN persona_path TEXT;

      -- The dogfood template stops being a generic "use it and judge" phase:
      -- it now references the engine-supplied dogfood asset variables
      -- (src/server/dogfood.ts) — the live preview URL, the persona lens, the
      -- verification guide, the governor, the results schema, and the report
      -- template. The contract file stays kb/dogfood.md; the phase also owes
      -- kb/dogfood-report.md and kb/dogfood-results.json (slice 37 gates them).
      UPDATE workflow_nodes SET prompt_template =
        'You are the dogfood verification agent for ticket {{displayKey}}: {{title}}.' || char(10) || char(10) ||
        '{{description}}' || char(10) || char(10) ||
        'Acceptance criteria:' || char(10) || '{{acceptanceCriteria}}' || char(10) || char(10) ||
        'Knowledge from earlier phases: {{priorKb}}' || char(10) || char(10) ||
        'A running preview of this branch is available at: {{previewBaseUrl}}' || char(10) || char(10) ||
        'Persona (experiential judge):' || char(10) || '{{persona}}' || char(10) || char(10) ||
        'Follow this verification playbook exactly:' || char(10) || '{{dogfoodGuide}}' || char(10) || char(10) ||
        'The fix-loop governor — read it before changing any code:' || char(10) || '{{dogfoodGovernor}}' || char(10) || char(10) ||
        'Write kb/dogfood-results.json with at least one scenario, conforming to this schema:' || char(10) ||
        '{{matrixSchema}}' || char(10) || char(10) ||
        'Write kb/dogfood-report.md following this template heading-for-heading:' || char(10) ||
        '{{dogfoodReportTemplate}}' || char(10) || char(10) ||
        'Follow-up criteria from bounced attempts: {{followUps}}' || char(10) ||
        'Bounce report from the previous attempt: {{bounceReportPath}}' || char(10) || char(10) ||
        'Before finishing, write kb/dogfood.md: the verdict, what you walked, what you fixed (with SHAs), and what a human must decide.'
      WHERE name = 'dogfood';
    `,
  },
  {
    version: 13,
    sql: `
      -- The dogfood phase grows gate teeth (ticket 37). The node now owes its
      -- Dogfood Report and machine-readable results file the same way the
      -- document node owes the recap: gate_requirements drives the artifact
      -- gate (existence) and marks the file artifact-lint validates against the
      -- vendored matrix schema and dogfood-green reads for scenario statuses.
      UPDATE workflow_nodes
        SET gate_requirements = '["kb/dogfood-report.md","kb/dogfood-results.json"]'
        WHERE name = 'dogfood';
    `,
  },
  {
    version: 14,
    sql: `
      -- Branch routing (ticket 46, ADR-0001): a phase whose node has labeled
      -- outgoing edges declares which one it took in its contract, and the
      -- engine records the matched label here. Null for the single-unlabeled-
      -- edge nodes that make up every v1 (RPIRD) graph.
      ALTER TABLE phase_executions ADD COLUMN outcome TEXT;
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

/** upTo is a test seam: build a database as it stood at an older version. */
export function migrate(db: DatabaseSync, upTo?: number): void {
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
    if (upTo !== undefined && migration.version > upTo) break;
    // PRAGMA foreign_keys is a no-op inside a transaction, so the rebuild
    // window opens before BEGIN and closes after — with the check inside.
    if (migration.rekeysForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
    try {
      withTransaction(db, () => {
        db.exec(migration.sql);
        if (migration.rekeysForeignKeys) {
          const violations = db.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) {
            throw new Error(
              `migration ${migration.version} broke referential integrity: ${JSON.stringify(violations)}`,
            );
          }
        }
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      });
    } finally {
      if (migration.rekeysForeignKeys) db.exec("PRAGMA foreign_keys = ON");
    }
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
