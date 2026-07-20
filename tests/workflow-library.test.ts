import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { migrate } from "../src/server/db.ts";
import type { TrackerServer } from "../src/server/index.ts";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import {
  bootWorkspace,
  PHASES,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

/** A provider whose phase never ends, for asserting mid-flight semantics. */
function stuckProvider(): FakeProvider {
  return new FakeProvider(async function* () {
    await new Promise(() => {});
    throw new Error("unreachable");
  });
}

describe("workflow versions migration (ADR-0004)", () => {
  test("an existing database migrates: RPIRD v1 default, history preserved, references backfilled", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, 10);

    // A pre-split world: a project with a run whose phase history points
    // into the seeded graph (node 4 = plan).
    db.prepare(
      "INSERT INTO projects (name, ticket_prefix, created_at) VALUES ('Legacy', 'TRK', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO tickets (project_id, number, display_key, title, created_at, updated_at) VALUES (1, 1, 'TRK-1', 'Old work', '2026-01-01', '2026-01-01')",
    ).run();
    db.prepare("INSERT INTO runs (ticket_id, state, created_at) VALUES (1, 'completed', '2026-01-01')").run();
    db.prepare(
      "INSERT INTO phase_executions (run_id, node_id, phase, state, started_at) VALUES (1, 4, 'plan', 'completed', '2026-01-01')",
    ).run();

    migrate(db);

    // Identity/content split: the seeded graph is named RPIRD, version 1, default.
    expect(db.prepare("SELECT name, archived, is_default FROM workflows WHERE id = 1").get()).toMatchObject({
      name: "RPIRD",
      archived: 0,
      is_default: 1,
    });
    expect(
      db.prepare("SELECT workflow_id, version FROM workflow_versions WHERE id = 1").get(),
    ).toMatchObject({ workflow_id: 1, version: 1 });

    // Nodes re-keyed to the version with ids preserved: past phase history
    // still resolves through its node_id FK.
    const planNode = db
      .prepare(
        `SELECT n.name, n.workflow_version_id FROM phase_executions p
         JOIN workflow_nodes n ON n.id = p.node_id WHERE p.run_id = 1`,
      )
      .get();
    expect(planNode).toMatchObject({ name: "plan", workflow_version_id: 1 });

    // Existing projects and runs are backfilled onto RPIRD v1.
    expect(db.prepare("SELECT workflow_id FROM projects WHERE id = 1").get()).toMatchObject({
      workflow_id: 1,
    });
    expect(db.prepare("SELECT workflow_version_id FROM runs WHERE id = 1").get()).toMatchObject({
      workflow_version_id: 1,
    });

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("the workflow library", () => {
  test("the seeded library lists RPIRD as default, phases in walk order, used-by counts live", async () => {
    const server = await bootServer();
    const listed = await api(server, "GET", "/api/workflows");
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0]).toMatchObject({
      id: 1,
      name: "RPIRD",
      archived: false,
      isDefault: true,
      version: 1,
      usedByProjects: 0,
    });
    // The preview line follows the graph walk, not node-id order.
    expect(listed.json[0].phases).toEqual([...PHASES]);

    await api(server, "POST", "/api/projects", { name: "Uses RPIRD" });
    const after = await api(server, "GET", "/api/workflows");
    expect(after.json[0].usedByProjects).toBe(1);
  });

  test("duplicate creates an independent 'X (copy)' from the head version's graph", async () => {
    const server = await bootServer();
    const copy = await api(server, "POST", "/api/workflows/1/duplicate");
    expect(copy.status).toBe(201);
    expect(copy.json).toMatchObject({
      name: "RPIRD (copy)",
      archived: false,
      isDefault: false,
      version: 1,
      usedByProjects: 0,
    });
    expect(copy.json.id).not.toBe(1);
    expect(copy.json.phases).toEqual([...PHASES]);

    const listed = await api(server, "GET", "/api/workflows");
    expect(listed.json).toHaveLength(2);
  });

  test("rename edits identity only; an empty name is refused", async () => {
    const server = await bootServer();
    const renamed = await api(server, "PATCH", "/api/workflows/1", { name: "Standard loop" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ id: 1, name: "Standard loop", version: 1 });
    expect((await api(server, "PATCH", "/api/workflows/1", { name: "  " })).status).toBe(400);
  });

  test("set-default swaps atomically and refuses archived targets", async () => {
    const server = await bootServer();
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;

    const promoted = await api(server, "POST", `/api/workflows/${copy.id}/default`);
    expect(promoted.status).toBe(200);
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: any) => w.id === 1).isDefault).toBe(false);
    expect(listed.find((w: any) => w.id === copy.id).isDefault).toBe(true);

    // RPIRD is no longer the default, so it archives without a successor —
    // and an archived workflow can never become the default.
    await api(server, "POST", "/api/workflows/1/archive");
    expect((await api(server, "POST", "/api/workflows/1/default")).status).toBe(400);
  });

  test("archiving the default demands a successor in the same call; both flags move atomically", async () => {
    const server = await bootServer();
    const refused = await api(server, "POST", "/api/workflows/1/archive");
    expect(refused.status).toBe(409);
    expect((await api(server, "GET", "/api/workflows")).json[0]).toMatchObject({
      archived: false,
      isDefault: true,
    });

    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    // A successor must be an active workflow other than the one leaving.
    expect(
      (await api(server, "POST", "/api/workflows/1/archive", { successorId: 1 })).status,
    ).toBe(400);

    const archived = await api(server, "POST", "/api/workflows/1/archive", {
      successorId: copy.id,
    });
    expect(archived.status).toBe(200);
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: any) => w.id === 1)).toMatchObject({ archived: true, isDefault: false });
    expect(listed.find((w: any) => w.id === copy.id)).toMatchObject({
      archived: false,
      isDefault: true,
    });

    // Reversible: unarchive restores selectability, not the default flag.
    const restored = await api(server, "POST", "/api/workflows/1/unarchive");
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({ archived: false, isDefault: false });
  });

  test("project creation falls back to the default and accepts an explicit active workflow", async () => {
    const server = await bootServer();
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;

    const defaulted = (await api(server, "POST", "/api/projects", { name: "On default" })).json;
    expect(defaulted.workflowId).toBe(1);

    const explicit = (
      await api(server, "POST", "/api/projects", { name: "On copy", workflowId: copy.id })
    ).json;
    expect(explicit.workflowId).toBe(copy.id);

    expect(
      (await api(server, "POST", "/api/projects", { name: "Nope", workflowId: 999 })).status,
    ).toBe(404);
  });

  test("archived workflows are refused as new selections but keep their projects working", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Sitting on RPIRD" })).json;
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    await api(server, "POST", "/api/workflows/1/archive", { successorId: copy.id });

    // The project still shows its archived selection.
    expect((await api(server, "GET", `/api/projects/${project.id}`)).json.workflowId).toBe(1);

    // But archived is not a new choice, anywhere.
    expect(
      (await api(server, "POST", "/api/projects", { name: "Nope", workflowId: 1 })).status,
    ).toBe(400);
    const other = (await api(server, "POST", "/api/projects", { name: "Other" })).json;
    expect(
      (await api(server, "PATCH", `/api/projects/${other.id}`, { workflowId: 1 })).status,
    ).toBe(400);
  });

  test("changing a project's selection emits no audit event — the Run's pin is the record", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Quiet switch" })).json;
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    const before = (await api(server, "GET", `/api/projects/${project.id}/audit`)).json;

    const patched = await api(server, "PATCH", `/api/projects/${project.id}`, {
      workflowId: copy.id,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.workflowId).toBe(copy.id);

    const after = (await api(server, "GET", `/api/projects/${project.id}/audit`)).json;
    expect(after).toHaveLength(before.length);
  });
});

describe("runs pin workflow versions", () => {
  async function promoteTicket(server: TrackerServer, projectId: number, repoId: number) {
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId,
        title: "Ship the widget",
        acceptanceCriteria: ["Widget renders"],
      })
    ).json;
    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId,
      provider: "claude-code",
    });
    return ticket;
  }

  test("claim pins the head version; a mid-flight selection change never touches the running run", async () => {
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": stuckProvider() },
    });
    const { project, repo } = await seedWorkspace(server);
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());
    const ticket = await promoteTicket(server, project.id, repo.id);
    await client.waitFor("run.updated", 1, 5000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs[0].workflowVersionId).toBe(1);

    // Re-point the project mid-flight: the running run keeps its pin.
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    await api(server, "PATCH", `/api/projects/${project.id}`, { workflowId: copy.id });
    const unchanged = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(unchanged[0]).toMatchObject({ state: "running", workflowVersionId: 1 });
  });

  test("an archived workflow keeps driving its projects: the next claim still runs it", async () => {
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": stuckProvider() },
    });
    const { project, repo } = await seedWorkspace(server);
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    await api(server, "POST", "/api/workflows/1/archive", { successorId: copy.id });

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());
    const ticket = await promoteTicket(server, project.id, repo.id);
    await client.waitFor("run.updated", 1, 5000);

    // The project sits on archived RPIRD; its claim pins RPIRD v1, not the default.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs[0].workflowVersionId).toBe(1);
  });

  test("a re-pointed project's next claim runs the duplicate's own graph end to end", async () => {
    const calls: PhaseCall[] = [];
    // Push to a FakeGitHub so the battery lands green: "verifying" in a
    // NullGitHub workspace is transient (doomed gates bounce it), and the
    // run-count assertions below would race the re-claim.
    const github = new FakeGitHub();
    const { server, ticket } = await bootWorkspace(
      scriptedProvider(calls, { onPhase: pushesToGitHub(github) }),
      {
        github,
        // The duplicate's graph must drive the run — set up before promotion
        // via the project the workspace seeded.
        async beforePromote(server, project) {
          const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
          await api(server, "PATCH", `/api/projects/${project.id}`, { workflowId: copy.id });
        },
      },
    );
    await waitForTicketState(server, ticket.id, "human_review");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    // Pinned to the copy's version (id 2 — the second version row ever).
    expect(runs[0].workflowVersionId).toBe(2);
    // And the phases executed are the copy's own nodes: every node id is
    // beyond the seeded graph's 1–6, in the same walk order.
    expect(runs[0].phases.map((p: any) => p.phase)).toEqual([...PHASES]);
    for (const phase of runs[0].phases) {
      expect(phase.nodeId).toBeGreaterThan(6);
    }
  }, 20_000);
});
