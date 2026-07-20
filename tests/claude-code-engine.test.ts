import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import { PhaseFailedError, WorkflowEngine, type RunContext } from "../src/server/engine.ts";
import { PreviewManager } from "../src/server/previews.ts";
import { ClaudeCodeProvider } from "../src/server/providers/claude-code.ts";
import { toClaudeCodeConfig } from "../src/server/providers/registry.ts";
import { RunLogRegistry } from "../src/server/runlog.ts";
import { Store } from "../src/server/store.ts";
import { initScratchRepo } from "./git-helpers.ts";
import { cleanups, previewPortBase, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

const FAKE_CLAUDE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-claude.mjs",
);

/**
 * The real adapter driven by the real engine, with the scripted binary
 * standing in for the CLI. This is the seam the contract harness cannot
 * reach: that a phase's conversation lands in the run log the drawer reads,
 * and that the Phase Contract is enforced against a real worktree.
 */
async function harness(mode: string): Promise<{
  ctx: RunContext;
  engine: WorkflowEngine;
  logs: RunLogRegistry;
  store: Store;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-cc-engine-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = openDatabase(dataDir);
  cleanups.push(async () => db.close());
  const store = new Store(db, new EventBus());

  // The seeded RPIRD graph is what a real board runs; its research phase is
  // the first agent node, so executing it exercises the normal path.
  const project = store.createProject({ name: "Adapter" });
  const source = initScratchRepo("fixture");
  cleanups.push(() => rm(path.dirname(source), { recursive: true, force: true }));
  const repo = store.createRepo({
    projectId: project.id,
    path: source,
    githubRemote: "git@github.com:x/adapter.git",
  });
  const ticket = store.createTicket({
    projectId: project.id,
    title: "Ship the widget",
    acceptanceCriteria: [],
  });
  store.promoteTicket(ticket.id, { repoId: repo.id, provider: "claude-code" });
  const claim = store.claimNextTicket()!;
  const worktreePath = mkdtempSync(path.join(tmpdir(), "tracker-cc-wt-"));
  cleanups.push(() => rm(worktreePath, { recursive: true, force: true }));
  mkdirSync(path.join(worktreePath, "kb"), { recursive: true });

  // Config comes from the store, exactly as the app wires it — so this also
  // proves the persisted binaryPath and env actually reach the child.
  store.setProviderConfig("claude-code", {
    binaryPath: FAKE_CLAUDE,
    env: { FAKE_CLAUDE_MODE: mode },
  });
  const logs = new RunLogRegistry();
  const engine = new WorkflowEngine(
    store,
    {
      // The same translation the app wires, not a copy of it — a divergence
      // here would test a config path production never takes.
      "claude-code": new ClaudeCodeProvider(() =>
        toClaudeCodeConfig(store.getProviderConfig("claude-code")),
      ),
    },
    logs,
    new PreviewManager(dataDir, store, previewPortBase()),
  );

  return {
    ctx: { run: claim.run, ticket: claim.ticket, repo: claim.repo, worktreePath },
    engine,
    logs,
    store,
  };
}

test("a Claude Code session runs a phase in the worktree and fills the drawer's log", async () => {
  const { ctx, engine, logs } = await harness("success");

  // The stub satisfies the plain Phase Contract for whatever phase it is
  // handed, so the walk gets several nodes in before one owes an artifact it
  // does not write. Where it stops is not the point — the conversation is.
  await engine.execute(ctx).catch(() => {});

  // The contract file landed in the worktree the engine handed the adapter.
  expect(existsSync(path.join(ctx.worktreePath, "kb", "research.md"))).toBe(true);

  const events = logs.for(ctx.run.id).entriesSince(0).map((entry) => entry.event);
  const opens = events.flatMap((e) => (e.type === "block.open" ? [e] : []));
  // Every open is tagged with the phase that produced it, so the drawer can
  // group a multi-phase run's conversation.
  expect(opens.every((e) => typeof e.phase === "string" && e.phase !== "")).toBe(true);

  // The full live conversation for one phase, not just its result: the prompt
  // the engine rendered, the model's reasoning, its prose, and tool traffic.
  const research = opens.filter((e) => e.phase === "research").map((e) => e.block.kind);
  expect(research).toEqual(
    expect.arrayContaining(["prompt", "thinking", "text", "tool_call", "tool_result"]),
  );
});

test("the adapter's session id reaches the phase execution record", async () => {
  const { ctx, engine, store } = await harness("success");
  await engine.execute(ctx).catch(() => {});

  // The stub always reports the same session id, so finding it on the row
  // proves the value travelled from the result line rather than being
  // invented by the engine. --resume depends on this being real.
  const research = store.listPhaseExecutions(ctx.run.id).find((p) => p.phase === "research");
  expect(research?.state).toBe("completed");
  expect(research?.providerSessionId).toBe("fake-session-1");
});

test("a provider-reported error fails the phase rather than crashing the run", async () => {
  const { ctx, engine } = await harness("error");
  await expect(engine.execute(ctx)).rejects.toBeInstanceOf(PhaseFailedError);
});
