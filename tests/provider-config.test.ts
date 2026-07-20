import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { NullGitHub } from "../src/server/github.ts";
import { startServer } from "../src/server/index.ts";
import { toClaudeCodeConfig } from "../src/server/providers/registry.ts";
import { api, bootServer, previewPortBase, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

test("every provider reads as all-defaults before anything is configured", async () => {
  const server = await bootServer();
  const { status, json } = await api(server, "GET", "/api/provider-config");
  expect(status).toBe(200);
  expect(json).toEqual([
    { provider: "claude-code", binaryPath: null, model: null, maxBudgetUsd: null, env: {} },
    { provider: "kiro", binaryPath: null, model: null, maxBudgetUsd: null, env: {} },
    { provider: "copilot", binaryPath: null, model: null, maxBudgetUsd: null, env: {} },
  ]);
});

test("config persists per provider and leaves the others alone", async () => {
  const server = await bootServer();
  const saved = await api(server, "PATCH", "/api/provider-config/claude-code", {
    binaryPath: "/opt/homebrew/bin/claude",
    model: "claude-opus-4-8",
    maxBudgetUsd: 5,
    env: { ANTHROPIC_LOG: "debug" },
  });
  expect(saved.status).toBe(200);
  expect(saved.json).toEqual({
    provider: "claude-code",
    binaryPath: "/opt/homebrew/bin/claude",
    model: "claude-opus-4-8",
    maxBudgetUsd: 5,
    env: { ANTHROPIC_LOG: "debug" },
  });

  const all = (await api(server, "GET", "/api/provider-config")).json;
  expect(all.find((c: any) => c.provider === "kiro").model).toBeNull();
});

test("a patch leaves omitted fields alone; null or empty clears them", async () => {
  const server = await bootServer();
  await api(server, "PATCH", "/api/provider-config/claude-code", {
    binaryPath: "/usr/local/bin/claude",
    model: "claude-opus-4-8",
  });

  // Omitted binaryPath survives a model-only edit.
  const patched = await api(server, "PATCH", "/api/provider-config/claude-code", {
    model: "claude-sonnet-5",
  });
  expect(patched.json.binaryPath).toBe("/usr/local/bin/claude");
  expect(patched.json.model).toBe("claude-sonnet-5");

  // Blanking the form field is how a pinned model gets un-pinned.
  const cleared = await api(server, "PATCH", "/api/provider-config/claude-code", { model: "" });
  expect(cleared.json.model).toBeNull();
  expect(cleared.json.binaryPath).toBe("/usr/local/bin/claude");

  const explicitNull = await api(server, "PATCH", "/api/provider-config/claude-code", {
    binaryPath: null,
  });
  expect(explicitNull.json.binaryPath).toBeNull();
});

test("rejects an unknown provider and malformed fields", async () => {
  const server = await bootServer();
  expect((await api(server, "PATCH", "/api/provider-config/gpt-9", { model: "x" })).status).toBe(404);
  expect(
    (await api(server, "PATCH", "/api/provider-config/claude-code", { maxBudgetUsd: "loads" }))
      .status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-config/claude-code", { maxBudgetUsd: 0 })).status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-config/claude-code", { env: ["nope"] })).status,
  ).toBe(400);
  expect(
    (await api(server, "PATCH", "/api/provider-config/claude-code", { env: { N: 3 } })).status,
  ).toBe(400);
});

test("config survives a restart — it is app state, not process state", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "provider-config-"));
  // startServer directly rather than bootServer: this test owns the restart,
  // so it must own both closes — bootServer's registered cleanup would close
  // the first server a second time.
  const boot = () =>
    startServer({ dataDir, port: 0, workers: 0, github: new NullGitHub(), previewPortBase: previewPortBase() });
  try {
    const first = await boot();
    await api(first, "PATCH", "/api/provider-config/claude-code", {
      model: "pinned-model",
      maxBudgetUsd: 2.5,
    });
    await first.close();

    const second = await boot();
    try {
      const reread = (await api(second, "GET", "/api/provider-config")).json[0];
      expect(reread).toMatchObject({ model: "pinned-model", maxBudgetUsd: 2.5 });
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
      provider: "claude-code",
      binaryPath: null,
      model: null,
      maxBudgetUsd: null,
      env: {},
    }),
  ).toEqual({ binaryPath: undefined, model: undefined, maxBudgetUsd: undefined, env: {} });
});
