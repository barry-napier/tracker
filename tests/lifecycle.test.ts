import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { api, bootServer, cleanups, runCleanups } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

describe("headless skeleton", () => {
  test("creates a project and reads it back", async () => {
    const server = await bootServer();

    const created = await api(server, "POST", "/api/projects", {
      name: "Fixture App",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Fixture App" });
    expect(created.json.id).toBeTypeOf("number");

    const fetched = await api(server, "GET", `/api/projects/${created.json.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json).toMatchObject({ id: created.json.id, name: "Fixture App" });

    const list = await api(server, "GET", "/api/projects");
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
  });

  test("creates tickets with ACs and per-project TRK keys", async () => {
    const server = await bootServer();
    const projectA = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const projectB = (await api(server, "POST", "/api/projects", { name: "B" })).json;

    const created = await api(server, "POST", "/api/tickets", {
      projectId: projectA.id,
      title: "Ship the widget",
      description: "It should widget.",
      acceptanceCriteria: ["Widget renders", "Widget persists"],
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      projectId: projectA.id,
      displayKey: "TRK-1",
      title: "Ship the widget",
      state: "backlog",
    });
    expect(created.json.acceptanceCriteria).toHaveLength(2);
    expect(created.json.acceptanceCriteria[0]).toMatchObject({
      text: "Widget renders",
      position: 0,
      status: "pending",
      origin: "original",
    });

    // Keys allocate per project: second ticket in A is TRK-2, first in B is TRK-1.
    const secondInA = await api(server, "POST", "/api/tickets", {
      projectId: projectA.id,
      title: "Another",
      acceptanceCriteria: ["Does the thing"],
    });
    expect(secondInA.json.displayKey).toBe("TRK-2");
    const firstInB = await api(server, "POST", "/api/tickets", {
      projectId: projectB.id,
      title: "B work",
      acceptanceCriteria: ["B thing"],
    });
    expect(firstInB.json.displayKey).toBe("TRK-1");

    const fetched = await api(server, "GET", `/api/tickets/${created.json.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.displayKey).toBe("TRK-1");
    expect(fetched.json.acceptanceCriteria).toHaveLength(2);

    const listed = await api(server, "GET", `/api/tickets?projectId=${projectA.id}`);
    expect(listed.json).toHaveLength(2);
  });

  test("rejects creates referencing a nonexistent project", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Real" })).json;
    const missing = project.id + 999;

    const ticket = await api(server, "POST", "/api/tickets", {
      projectId: missing,
      title: "Orphan",
      acceptanceCriteria: ["Never lands"],
    });
    expect(ticket.status).toBe(404);
    expect(ticket.json).toMatchObject({ error: "project not found" });

    const repo = await api(server, "POST", "/api/repos", {
      projectId: missing,
      path: "/tmp/nowhere",
    });
    expect(repo.status).toBe(404);

    const automation = await api(server, "POST", "/api/automations", {
      projectId: missing,
      title: "Orphan",
      prompt: "do the thing",
    });
    expect(automation.status).toBe(404);

    // Nothing was inserted.
    const listed = await api(server, "GET", "/api/tickets");
    expect(listed.json).toHaveLength(0);
  });

  test("updates a ticket without touching its display key", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Before",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const updated = await api(server, "PATCH", `/api/tickets/${ticket.id}`, {
      title: "After",
      description: "New description",
      displayKey: "TRK-999",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.title).toBe("After");
    expect(updated.json.description).toBe("New description");
    expect(updated.json.displayKey).toBe("TRK-1");
    expect(updated.json.updatedAt >= ticket.updatedAt).toBe(true);
  });

  test("every mutation appends an immutable audit event", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Audited",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const afterCreate = await api(server, "GET", `/api/tickets/${ticket.id}/audit`);
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.json).toHaveLength(1);
    expect(afterCreate.json[0]).toMatchObject({
      actor: "human",
      type: "ticket.created",
      detail: { displayKey: "TRK-1", title: "Audited" },
    });

    await api(server, "PATCH", `/api/tickets/${ticket.id}`, { title: "Audited v2" });
    const afterUpdate = await api(server, "GET", `/api/tickets/${ticket.id}/audit`);
    expect(afterUpdate.json).toHaveLength(2);
    // Earlier events are untouched by later mutations.
    expect(afterUpdate.json[0]).toEqual(afterCreate.json[0]);
    // A title-only patch is audited as exactly that.
    expect(afterUpdate.json[1]).toMatchObject({
      type: "ticket.updated",
      detail: { changed: ["title"] },
    });
  });

  test("malformed JSON gets a 400, not a 500", async () => {
    const server = await bootServer();
    const res = await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("SSE stream sees every mutation with monotonic seq", async () => {
    const server = await bootServer();
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Streamed",
        acceptanceCriteria: ["First AC", "Second AC"],
      })
    ).json;
    await api(server, "PATCH", `/api/tickets/${ticket.id}`, { title: "Streamed v2" });

    // project.created + ticket.created + ticket.updated audits
    const audits = await client.waitFor("audit.appended", 3);
    expect(audits.map((m) => m.data.type)).toEqual([
      "project.created",
      "ticket.created",
      "ticket.updated",
    ]);
    const ticketUpdates = await client.waitFor("ticket.updated", 2);
    expect(ticketUpdates[1]!.data.title).toBe("Streamed v2");
    const acUpdates = await client.waitFor("ac.updated", 2);
    expect(acUpdates.map((m) => m.data.text)).toEqual(["First AC", "Second AC"]);

    // Seq is strictly monotonic across all event types.
    const seqs = client.messages.map((m) => m.id);
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)).toBe(true);
  });

  test("Last-Event-ID resume replays missed events", async () => {
    const server = await bootServer();
    const first = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => first.close());

    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    await first.waitFor("audit.appended", 1);
    const lastSeen = first.messages.at(-1)!.id;
    first.close();

    // Mutations happening while disconnected...
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "Missed me",
      acceptanceCriteria: ["An AC"],
    });

    // ...are replayed on reconnect with Last-Event-ID.
    const resumed = await SseClient.connect(`${server.url}/api/events`, lastSeen);
    cleanups.push(async () => resumed.close());
    const audits = await resumed.waitFor("audit.appended", 1);
    expect(audits[0]!.data.type).toBe("ticket.created");
    const ticketEvents = await resumed.waitFor("ticket.updated", 1);
    expect(ticketEvents[0]!.data.title).toBe("Missed me");
    expect(resumed.messages.every((m) => m.id > lastSeen)).toBe(true);

    // And the live stream keeps flowing after the replay.
    await api(server, "PATCH", `/api/tickets/${ticketEvents[0]!.data.id}`, { title: "Live again" });
    const live = await resumed.waitFor("ticket.updated", 2);
    expect(live[1]!.data.title).toBe("Live again");
  });

  test("relaunch against the same data dir keeps state and numbering", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-test-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

    const first = await bootServer(dataDir);
    const project = (await api(first, "POST", "/api/projects", { name: "Persistent" })).json;
    const ticket = (
      await api(first, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Survives restart",
        acceptanceCriteria: ["Still here"],
      })
    ).json;
    await cleanups.pop()!(); // close the first server

    // Second launch migrates idempotently and reads the same rows.
    const second = await bootServer(dataDir);
    const fetched = await api(second, "GET", `/api/tickets/${ticket.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json).toMatchObject({ displayKey: "TRK-1", title: "Survives restart" });
    expect(fetched.json.acceptanceCriteria).toHaveLength(1);

    // Numbering continues where it left off.
    const next = await api(second, "POST", "/api/tickets", {
      projectId: project.id,
      title: "After restart",
      acceptanceCriteria: ["Numbered right"],
    });
    expect(next.json.displayKey).toBe("TRK-2");
  });
});
