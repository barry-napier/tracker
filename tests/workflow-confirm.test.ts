import { afterEach, describe, expect, test } from "vitest";
import { api, bootServer, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

/**
 * The board's one-time workflow ask: a project created on the defaulted
 * workflow owes a confirmation; an explicit choice (at creation or later)
 * settles it, and "keep it" settles it without changing the selection.
 */
describe("first-board-view workflow confirmation", () => {
  test("defaulted creation starts unconfirmed; explicit choice starts confirmed", async () => {
    const server = await bootServer();
    const defaulted = (await api(server, "POST", "/api/projects", { name: "Defaulted" })).json;
    expect(defaulted.workflowConfirmed).toBe(false);

    const chosen = (
      await api(server, "POST", "/api/projects", { name: "Chosen", workflowId: 1 })
    ).json;
    expect(chosen.workflowConfirmed).toBe(true);
  });

  test("keep-it confirms without changing the selection", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Keeper" })).json;

    const kept = await api(server, "PATCH", `/api/projects/${project.id}`, {
      workflowConfirmed: true,
    });
    expect(kept.status).toBe(200);
    expect(kept.json.workflowConfirmed).toBe(true);
    expect(kept.json.workflowId).toBe(project.workflowId);

    const live = (await api(server, "GET", `/api/projects/${project.id}`)).json;
    expect(live.workflowConfirmed).toBe(true);
  });

  test("picking a workflow confirms as a side effect", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Picker" })).json;
    const copy = (await api(server, "POST", `/api/workflows/1/duplicate`)).json;

    const picked = (
      await api(server, "PATCH", `/api/projects/${project.id}`, { workflowId: copy.id })
    ).json;
    expect(picked.workflowId).toBe(copy.id);
    expect(picked.workflowConfirmed).toBe(true);
  });

  test("a patch with neither field is a 400", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "Empty" })).json;
    const res = await api(server, "PATCH", `/api/projects/${project.id}`, {});
    expect(res.status).toBe(400);
  });
});
