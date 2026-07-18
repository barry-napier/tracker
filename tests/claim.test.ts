import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import type { TrackerServer } from "../src/server/index.ts";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { git } from "./git-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

/**
 * A provider whose phase never ends: claimed tickets stay In Progress while
 * the test asserts claim semantics. pool.stop() cancels it at teardown.
 */
function stuckProvider(): FakeProvider {
  return new FakeProvider(async function* () {
    await new Promise(() => {});
    throw new Error("unreachable");
  });
}

async function fileTicket(
  server: TrackerServer,
  projectId: number,
  overrides: Record<string, unknown> = {},
) {
  return (
    await api(server, "POST", "/api/tickets", {
      projectId,
      title: "Ship the widget",
      acceptanceCriteria: ["Widget renders"],
      ...overrides,
    })
  ).json;
}

describe("claim cuts a worktree", () => {
  test("a promoted ticket is claimed: run row, branch, worktree, In Progress over SSE", async () => {
    const server = await bootServer(undefined, { workers: 3, providers: { "claude-code": stuckProvider() } });
    const { project, repo } = await seedWorkspace(server);
    const ticket = await fileTicket(server, project.id);

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });

    // The worker claims and cuts the worktree; run.updated carries the path.
    const runEvents = await client.waitFor("run.updated", 1, 5000);
    expect(runEvents[0]!.data).toMatchObject({
      ticketId: ticket.id,
      state: "running",
    });
    expect(runEvents[0]!.data.worktreePath).toContain("fixture-app--trk-1");

    const updates = await client.waitFor("ticket.updated", 3);
    expect(updates.at(-1)!.data).toMatchObject({
      state: "in_progress",
      branch: "feat/trk-1-ship-the-widget",
    });

    const runs = await api(server, "GET", `/api/tickets/${ticket.id}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.json).toHaveLength(1);
    expect(runs.json[0]).toMatchObject({ ticketId: ticket.id, state: "running" });
    expect(existsSync(runs.json[0].worktreePath)).toBe(true);
    expect(git(runs.json[0].worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/trk-1-ship-the-widget",
    );

    const audit = await api(server, "GET", `/api/tickets/${ticket.id}/audit`);
    const types = audit.json.map((event: { type: string }) => event.type);
    expect(types).toContain("ticket.claimed");
    expect(types).toContain("worktree.created");
    const claimed = audit.json.find((event: { type: string }) => event.type === "ticket.claimed");
    expect(claimed).toMatchObject({
      actor: "agent",
      detail: { branch: "feat/trk-1-ship-the-widget" },
    });
  });

  test("a ticket with an external ref gets its branch named after it", async () => {
    const server = await bootServer(undefined, { workers: 3, providers: { "claude-code": stuckProvider() } });
    const { project, repo } = await seedWorkspace(server);
    const ticket = await fileTicket(server, project.id, {
      title: "Fix login crash",
      externalRef: "GH-231",
    });
    expect(ticket.externalRef).toBe("GH-231");

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());
    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });

    await client.waitFor("run.updated", 1, 5000);
    const fetched = await api(server, "GET", `/api/tickets/${ticket.id}`);
    expect(fetched.json.branch).toBe("feat/gh-231-fix-login-crash");
  });

  test("the pool claims at most three tickets at once; the fourth stays in Todo", async () => {
    const server = await bootServer(undefined, { workers: 3, providers: { "claude-code": stuckProvider() } });
    const { project, repo } = await seedWorkspace(server);
    const tickets = [];
    for (let i = 0; i < 4; i++) {
      tickets.push(await fileTicket(server, project.id, { title: `Widget ${i + 1}` }));
    }

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());
    for (const ticket of tickets) {
      await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
        repoId: repo.id,
        provider: "claude-code",
      });
    }

    // Three worktrees come up; the fourth ticket must still be waiting.
    await client.waitFor("run.updated", 3, 10_000);
    const listed = await api(server, "GET", `/api/tickets?projectId=${project.id}`);
    const states = listed.json.map((t: { state: string }) => t.state).sort();
    expect(states).toEqual(["in_progress", "in_progress", "in_progress", "todo"]);
  });
});
