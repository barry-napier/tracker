import { afterEach, describe, expect, test } from "vitest";
import type { TrackerServer } from "../src/server/index.ts";
import { api, bootServer, cleanups, runCleanups } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

async function seedProject(server: TrackerServer, overrides: Record<string, unknown> = {}) {
  return (
    await api(server, "POST", "/api/projects", { name: "Fixture App", ...overrides })
  ).json;
}

async function seedRepo(server: TrackerServer, projectId: number, overrides: Record<string, unknown> = {}) {
  return (
    await api(server, "POST", "/api/repos", {
      projectId,
      path: "/tmp/fixture-app",
      githubRemote: "git@github.com:barry/fixture-app.git",
      ...overrides,
    })
  ).json;
}

async function seedTicket(server: TrackerServer, projectId: number) {
  return (
    await api(server, "POST", "/api/tickets", {
      projectId,
      title: "Ship the widget",
      acceptanceCriteria: ["Widget renders"],
    })
  ).json;
}

describe("repo registration", () => {
  test("registers a repo on a project and reads it back", async () => {
    const server = await bootServer();
    const project = await seedProject(server);

    const created = await api(server, "POST", "/api/repos", {
      projectId: project.id,
      path: "/Users/barry/dev/fixture-app",
      githubRemote: "git@github.com:barry/fixture-app.git",
      targetBranch: "develop",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      projectId: project.id,
      path: "/Users/barry/dev/fixture-app",
      githubRemote: "git@github.com:barry/fixture-app.git",
      targetBranch: "develop",
    });
    // Preview config fields exist but stay unset until slice 34.
    expect(created.json).toMatchObject({
      previewCommand: null,
      previewKind: null,
      previewReadinessPath: null,
    });

    const listed = await api(server, "GET", `/api/repos?projectId=${project.id}`);
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].id).toBe(created.json.id);
  });

  test("target branch defaults to main; registration is audited", async () => {
    const server = await bootServer();
    const project = await seedProject(server);
    const repo = await seedRepo(server, project.id);
    expect(repo.targetBranch).toBe("main");

    const audit = await api(server, "GET", `/api/projects/${project.id}/audit`);
    expect(audit.status).toBe(200);
    expect(audit.json.at(-1)).toMatchObject({
      actor: "human",
      type: "repo.created",
      detail: { path: "/tmp/fixture-app" },
    });
  });

  test("rejects a repo without path or remote, or on an unknown project", async () => {
    const server = await bootServer();
    const project = await seedProject(server);

    const noPath = await api(server, "POST", "/api/repos", {
      projectId: project.id,
      githubRemote: "git@github.com:barry/x.git",
    });
    expect(noPath.status).toBe(400);

    const noRemote = await api(server, "POST", "/api/repos", {
      projectId: project.id,
      path: "/tmp/x",
    });
    expect(noRemote.status).toBe(400);

    const badProject = await api(server, "POST", "/api/repos", {
      projectId: 999,
      path: "/tmp/x",
      githubRemote: "git@github.com:barry/x.git",
    });
    expect(badProject.status).toBe(404);
  });
});

describe("project default provider", () => {
  test("defaults to claude-code and round-trips an explicit choice", async () => {
    const server = await bootServer();
    const defaulted = await seedProject(server);
    expect(defaulted.defaultProvider).toBe("claude-code");

    const explicit = await seedProject(server, { name: "Kiro App", defaultProvider: "kiro" });
    expect(explicit.defaultProvider).toBe("kiro");

    const fetched = await api(server, "GET", `/api/projects/${explicit.id}`);
    expect(fetched.json.defaultProvider).toBe("kiro");
  });

  test("rejects an unknown provider", async () => {
    const server = await bootServer();
    const bad = await api(server, "POST", "/api/projects", {
      name: "Bad",
      defaultProvider: "gpt-11",
    });
    expect(bad.status).toBe(400);
  });
});

describe("promotion", () => {
  test("promotes a backlog ticket to todo with repo and provider recorded", async () => {
    const server = await bootServer();
    const project = await seedProject(server);
    const repo = await seedRepo(server, project.id);
    const ticket = await seedTicket(server, project.id);
    expect(ticket).toMatchObject({ state: "backlog", repoId: null, provider: null });

    const promoted = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "copilot",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.json).toMatchObject({
      state: "todo",
      repoId: repo.id,
      provider: "copilot",
    });

    const fetched = await api(server, "GET", `/api/tickets/${ticket.id}`);
    expect(fetched.json).toMatchObject({ state: "todo", repoId: repo.id, provider: "copilot" });
  });

  test("promotion appends an audit event carrying repo + provider and lands on SSE", async () => {
    const server = await bootServer();
    const project = await seedProject(server);
    const repo = await seedRepo(server, project.id);
    const ticket = await seedTicket(server, project.id);

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });

    const audit = await api(server, "GET", `/api/tickets/${ticket.id}/audit`);
    expect(audit.json.at(-1)).toMatchObject({
      actor: "human",
      type: "ticket.promoted",
      detail: { repoId: repo.id, provider: "claude-code" },
    });

    // The stream replays the buffer, so creation events precede the promotion.
    const updates = await client.waitFor("ticket.updated", 2);
    expect(updates.at(-1)!.data).toMatchObject({ state: "todo", repoId: repo.id });
    const audits = await client.waitFor("audit.appended", 4);
    expect(audits.at(-1)!.data.type).toBe("ticket.promoted");
  });

  test("only backlog tickets can be promoted, exactly once", async () => {
    const server = await bootServer();
    const project = await seedProject(server);
    const repo = await seedRepo(server, project.id);
    const ticket = await seedTicket(server, project.id);

    const first = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    expect(first.status).toBe(200);

    const again = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    expect(again.status).toBe(409);

    // The failed second promotion changed nothing.
    const fetched = await api(server, "GET", `/api/tickets/${ticket.id}`);
    expect(fetched.json).toMatchObject({ state: "todo", provider: "claude-code" });
  });

  test("promotion requires a repo, a known provider, and a repo of the same project", async () => {
    const server = await bootServer();
    const project = await seedProject(server);
    const repo = await seedRepo(server, project.id);
    const other = await seedProject(server, { name: "Other" });
    const foreignRepo = await seedRepo(server, other.id, { path: "/tmp/other" });
    const ticket = await seedTicket(server, project.id);

    const noRepo = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      provider: "claude-code",
    });
    expect(noRepo.status).toBe(400);

    const unknownRepo = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: 999,
      provider: "claude-code",
    });
    expect(unknownRepo.status).toBe(404);

    const crossProject = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: foreignRepo.id,
      provider: "claude-code",
    });
    expect(crossProject.status).toBe(400);

    const badProvider = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "gpt-11",
    });
    expect(badProvider.status).toBe(400);

    // Nothing above moved the ticket.
    const fetched = await api(server, "GET", `/api/tickets/${ticket.id}`);
    expect(fetched.json).toMatchObject({ state: "backlog", repoId: null, provider: null });
  });
});
