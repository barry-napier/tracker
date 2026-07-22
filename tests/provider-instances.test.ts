import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { NullGitHub } from "../src/server/github.ts";
import { startServer } from "../src/server/index.ts";
import { toClaudeCodeConfig } from "../src/server/providers/registry.ts";
import { api, bootServer, previewPortBase, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

test("the list starts empty — providers are added deliberately", async () => {
  const server = await bootServer(undefined, { seedProviders: false });
  const { status, json } = await api(server, "GET", "/api/provider-instances");
  expect(status).toBe(200);
  expect(json).toEqual([]);
});

test("adding an instance slugs the display name and takes config inline", async () => {
  const server = await bootServer(undefined, { seedProviders: false });
  const created = await api(server, "POST", "/api/provider-instances", {
    driver: "claude-code",
    displayName: "Claude (Work)",
    model: "claude-opus-4-8",
  });
  expect(created.status).toBe(201);
  expect(created.json).toMatchObject({
    id: "claude-work",
    driver: "claude-code",
    displayName: "Claude (Work)",
    enabled: true,
    model: "claude-opus-4-8",
  });

  // Same name again: the id stays unique, references stay unambiguous.
  const twin = await api(server, "POST", "/api/provider-instances", {
    driver: "claude-code",
    displayName: "Claude (Work)",
  });
  expect(twin.json.id).toBe("claude-work-2");

  expect(
    (await api(server, "POST", "/api/provider-instances", { driver: "gpt-9", displayName: "x" }))
      .status,
  ).toBe(400);
  expect(
    (await api(server, "POST", "/api/provider-instances", { driver: "kiro", displayName: " " }))
      .status,
  ).toBe(400);
});

test("config persists per instance and leaves the others alone", async () => {
  const server = await bootServer();
  const saved = await api(server, "PATCH", "/api/provider-instances/claude-code", {
    binaryPath: "/opt/homebrew/bin/claude",
    model: "claude-opus-4-8",
    maxBudgetUsd: 5,
    env: { ANTHROPIC_LOG: "debug" },
  });
  expect(saved.status).toBe(200);
  expect(saved.json).toMatchObject({
    id: "claude-code",
    driver: "claude-code",
    binaryPath: "/opt/homebrew/bin/claude",
    model: "claude-opus-4-8",
    maxBudgetUsd: 5,
    env: { ANTHROPIC_LOG: "debug" },
  });

  const all = (await api(server, "GET", "/api/provider-instances")).json;
  expect(all.find((c: any) => c.id === "kiro").model).toBeNull();
});

test("a patch leaves omitted fields alone; null or empty clears them", async () => {
  const server = await bootServer();
  await api(server, "PATCH", "/api/provider-instances/claude-code", {
    binaryPath: "/usr/local/bin/claude",
    model: "claude-opus-4-8",
  });

  // Omitted binaryPath survives a model-only edit.
  const patched = await api(server, "PATCH", "/api/provider-instances/claude-code", {
    model: "claude-sonnet-5",
  });
  expect(patched.json.binaryPath).toBe("/usr/local/bin/claude");
  expect(patched.json.model).toBe("claude-sonnet-5");

  // Blanking the form field is how a pinned model gets un-pinned.
  const cleared = await api(server, "PATCH", "/api/provider-instances/claude-code", { model: "" });
  expect(cleared.json.model).toBeNull();
  expect(cleared.json.binaryPath).toBe("/usr/local/bin/claude");

  const explicitNull = await api(server, "PATCH", "/api/provider-instances/claude-code", {
    binaryPath: null,
  });
  expect(explicitNull.json.binaryPath).toBeNull();
});

test("rejects an unknown instance and malformed fields", async () => {
  const server = await bootServer();
  expect((await api(server, "PATCH", "/api/provider-instances/gpt-9", { model: "x" })).status).toBe(404);
  expect(
    (await api(server, "PATCH", "/api/provider-instances/claude-code", { maxBudgetUsd: "loads" }))
      .status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-instances/claude-code", { maxBudgetUsd: 0 })).status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-instances/claude-code", { env: ["nope"] })).status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-instances/claude-code", { env: { N: 3 } })).status,
  ).toBe(400);
});

test("delete is refused while referenced; disable is the fallback", async () => {
  const server = await bootServer();
  // Every project's default references an instance; the first configured one
  // is referenced the moment a project exists.
  await api(server, "POST", "/api/projects", { name: "P" });
  expect((await api(server, "DELETE", "/api/provider-instances/claude-code")).status).toBe(400);

  const disabled = await api(server, "PATCH", "/api/provider-instances/claude-code", {
    enabled: false,
  });
  expect(disabled.json.enabled).toBe(false);

  // An unreferenced instance deletes cleanly.
  expect((await api(server, "DELETE", "/api/provider-instances/kiro")).status).toBe(200);
  expect((await api(server, "DELETE", "/api/provider-instances/nope")).status).toBe(404);
});

test("promotion needs a configured, enabled instance", async () => {
  const server = await bootServer(undefined, { seedProviders: false });
  const project = (await api(server, "POST", "/api/projects", { name: "P" })).json;
  const ticket = (
    await api(server, "POST", "/api/tickets", { projectId: project.id, title: "T" })
  ).json;

  // Nothing configured: the classic driver name is not a valid reference.
  const empty = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
    repoId: 1,
    provider: "claude-code",
  });
  expect(empty.status).toBe(400);

  await api(server, "POST", "/api/provider-instances", { driver: "kiro", displayName: "Kiro" });
  await api(server, "PATCH", "/api/provider-instances/kiro", { enabled: false });
  // No repo registered — but the provider check fires first, which is the
  // assertion that matters here.
  const refused = await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
    repoId: 1,
    provider: "kiro",
  });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain("disabled");
});

test("availability is PATH-shaped and rides on the list", async () => {
  const server = await bootServer(undefined, { seedProviders: false });
  await api(server, "POST", "/api/provider-instances", {
    driver: "claude-code",
    displayName: "Claude Code",
  });

  // An executable absolute path reads available; a bogus one carries why.
  await api(server, "PATCH", "/api/provider-instances/claude-code", { binaryPath: "/bin/ls" });
  let row = (await api(server, "GET", "/api/provider-instances")).json[0];
  expect(row.available).toBe(true);
  expect(row.availabilityReason).toBeNull();

  await api(server, "PATCH", "/api/provider-instances/claude-code", {
    binaryPath: "/nope/claude",
  });
  row = (await api(server, "GET", "/api/provider-instances")).json[0];
  expect(row.available).toBe(false);
  expect(row.availabilityReason).toContain("/nope/claude");

  // Copilot's unset default is the SDK-bundled runtime — nothing to resolve.
  await api(server, "POST", "/api/provider-instances", {
    driver: "copilot",
    displayName: "Copilot",
  });
  const copilot = (await api(server, "GET", "/api/provider-instances")).json.find(
    (c: any) => c.id === "copilot",
  );
  expect(copilot.available).toBe(true);
});

test("config survives a restart — it is app state, not process state", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "provider-instances-"));
  // startServer directly rather than bootServer: this test owns the restart,
  // so it must own both closes — bootServer's registered cleanup would close
  // the first server a second time.
  const boot = () =>
    startServer({ dataDir, port: 0, workers: 0, github: new NullGitHub(), previewPortBase: previewPortBase() });
  try {
    const first = await boot();
    await api(first, "POST", "/api/provider-instances", {
      driver: "claude-code",
      displayName: "Claude Code",
      model: "pinned-model",
      maxBudgetUsd: 2.5,
    });
    await api(first, "POST", "/api/provider-instances", {
      driver: "copilot",
      displayName: "Copilot (Work)",
    });
    await first.close();

    const second = await boot();
    try {
      const reread = (await api(second, "GET", "/api/provider-instances")).json;
      expect(reread.find((c: any) => c.id === "claude-code")).toMatchObject({
        model: "pinned-model",
        maxBudgetUsd: 2.5,
      });
      expect(reread.find((c: any) => c.id === "copilot-work")).toMatchObject({
        driver: "copilot",
        displayName: "Copilot (Work)",
      });
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("stored nulls become unset for the adapter, not literal nulls", () => {
  expect(
    toClaudeCodeConfig({
      id: "claude-code",
      driver: "claude-code",
      displayName: "Claude Code",
      enabled: true,
      binaryPath: null,
      model: null,
      maxBudgetUsd: null,
      env: {},
    }),
  ).toEqual({ binaryPath: undefined, model: undefined, maxBudgetUsd: undefined, env: {} });
});
