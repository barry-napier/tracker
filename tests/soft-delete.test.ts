import { afterEach, describe, expect, test } from "vitest";
import { api, bootServer, runCleanups, seedWorkspace } from "./server-helpers.ts";

afterEach(runCleanups);

describe("projects: soft delete", () => {
  test("deleting drops the row from every listing but keeps it resolvable", async () => {
    const server = await bootServer();
    const { project } = await seedWorkspace(server);
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "survives the delete",
      acceptanceCriteria: [],
    });

    const res = await api(server, "DELETE", `/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.json.deletedAt).not.toBeNull();

    // Gone even from the archive listing — deleted is stronger than hidden.
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
    expect((await api(server, "GET", "/api/projects?includeHidden=1")).json).toHaveLength(0);

    // The row and its history still resolve for references.
    expect((await api(server, "GET", `/api/projects/${project.id}`)).status).toBe(200);
    const audit = (await api(server, "GET", `/api/projects/${project.id}/audit`)).json;
    expect(audit.map((e: any) => e.type)).toContain("project.deleted");
  });

  test("re-adding the checkout resurrects a deleted project", async () => {
    const server = await bootServer();
    const { source, project } = await seedWorkspace(server);
    await api(server, "DELETE", `/api/projects/${project.id}`);

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(200);
    expect(res.json.alreadyTracked).toBe(true);
    expect(res.json.project.id).toBe(project.id);
    expect(res.json.project.deletedAt).toBeNull();
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(1);
  });

  test("deleting an unknown project is a 404", async () => {
    const server = await bootServer();
    expect((await api(server, "DELETE", "/api/projects/999")).status).toBe(404);
  });
});

describe("workflows: soft delete", () => {
  test("blocked while a live project selects it; allowed once the project is gone", async () => {
    const server = await bootServer();
    const { project } = await seedWorkspace(server);
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    await api(server, "PATCH", `/api/projects/${project.id}`, { workflowId: copy.id });

    const blocked = await api(server, "DELETE", `/api/workflows/${copy.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("current workflow");

    // A soft-deleted project no longer counts as a live selection, but its
    // reference keeps the workflow row alive: delete succeeds as soft.
    await api(server, "DELETE", `/api/projects/${project.id}`);
    expect((await api(server, "DELETE", `/api/workflows/${copy.id}`)).status).toBe(200);

    const names = (await api(server, "GET", "/api/workflows")).json.map((w: any) => w.id);
    expect(names).not.toContain(copy.id);

    // Out of every selection surface too.
    expect((await api(server, "POST", `/api/workflows/${copy.id}/default`)).status).toBe(404);
    // And a second delete reads as not found.
    expect((await api(server, "DELETE", `/api/workflows/${copy.id}`)).status).toBe(404);
  });

  test("a never-used workflow still deletes outright", async () => {
    const server = await bootServer();
    const created = (await api(server, "POST", "/api/workflows", { name: "One-shot" })).json;
    expect(created.deletable).toBe(true);
    expect((await api(server, "DELETE", `/api/workflows/${created.id}`)).status).toBe(200);
    const ids = (await api(server, "GET", "/api/workflows")).json.map((w: any) => w.id);
    expect(ids).not.toContain(created.id);
  });
});
