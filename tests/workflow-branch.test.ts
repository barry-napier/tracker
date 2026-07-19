import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import { PhaseFailedError, WorkflowEngine, type RunContext } from "../src/server/engine.ts";
import { NullGitHub } from "../src/server/github.ts";
import { GateBattery } from "../src/server/gates.ts";
import { PreviewManager } from "../src/server/previews.ts";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { RunLogRegistry } from "../src/server/runlog.ts";
import { Store } from "../src/server/store.ts";
import { initScratchRepo } from "./git-helpers.ts";
import { cleanups, previewPortBase, runCleanups } from "./server-helpers.ts";
import { writeDogfood, writeRecap } from "./workflow-helpers.ts";

afterEach(runCleanups);

type NodeSpec = {
  name: string;
  type?: "trigger" | "agent_phase";
  prompt?: string;
  gateRequirements?: string[];
};
type EdgeSpec = { from: string; to: string; label?: string };

/**
 * Hand-seed a workflow as its own immutable version 1 and return the version
 * id plus a name→node-id map. Node prompts default to a template naming the
 * contract file (so the fake provider can read its phase) and the branch
 * choices, mirroring what a real branch node's template would carry.
 */
function seedWorkflow(
  db: DatabaseSync,
  name: string,
  nodes: NodeSpec[],
  edges: EdgeSpec[],
): { workflowId: number; versionId: number; nodeIds: Map<string, number> } {
  const workflowId = Number(
    db
      .prepare("INSERT INTO workflows (name, archived, is_default, created_at) VALUES (?, 0, 0, ?)")
      .run(name, "2026-01-01").lastInsertRowid,
  );
  const versionId = Number(
    db
      .prepare("INSERT INTO workflow_versions (workflow_id, version, created_at) VALUES (?, 1, ?)")
      .run(workflowId, "2026-01-01").lastInsertRowid,
  );
  const nodeIds = new Map<string, number>();
  const insertNode = db.prepare(
    "INSERT INTO workflow_nodes (workflow_version_id, type, name, prompt_template, gate_requirements) VALUES (?, ?, ?, ?, ?)",
  );
  for (const node of nodes) {
    const prompt =
      node.prompt ?? `Do the ${node.name} work; pick from {{outcomes}}; write kb/${node.name}.md.`;
    const id = Number(
      insertNode.run(
        versionId,
        node.type ?? "agent_phase",
        node.name,
        node.type === "trigger" ? null : prompt,
        node.gateRequirements ? JSON.stringify(node.gateRequirements) : null,
      ).lastInsertRowid,
    );
    nodeIds.set(node.name, id);
  }
  const insertEdge = db.prepare(
    "INSERT INTO workflow_edges (workflow_version_id, from_node_id, to_node_id, condition_label) VALUES (?, ?, ?, ?)",
  );
  for (const edge of edges) {
    insertEdge.run(versionId, nodeIds.get(edge.from)!, nodeIds.get(edge.to)!, edge.label ?? null);
  }
  return { workflowId, versionId, nodeIds };
}

/** A provider that behaves per node, recording every rendered prompt it saw. */
function branchProvider(
  prompts: Map<string, string>,
  behavior: (phase: string, cwd: string) => void,
): FakeProvider {
  return new FakeProvider(async function* (ctx) {
    const phase = /write kb\/([a-z]+)\.md/.exec(ctx.prompt)![1]!;
    prompts.set(phase, ctx.prompt);
    yield { type: "block.open", blockId: `${phase}-1`, block: { kind: "text", text: phase } };
    yield { type: "block.close", blockId: `${phase}-1` };
    behavior(phase, ctx.cwd);
    return { outcome: "completed" as const, providerSessionId: `sess-${phase}` };
  });
}

/** Contract file with an optional YAML frontmatter block ahead of the body. */
function writeContract(cwd: string, phase: string, frontmatter?: string): void {
  const dir = path.join(cwd, "kb");
  writeFileSync(
    path.join(dir, `${phase}.md`),
    `${frontmatter ? `---\n${frontmatter}\n---\n` : ""}# ${phase}\n\nDid the ${phase} thing.\n`,
  );
}

/** Store on a throwaway DB plus a real one-commit worktree for the run. */
async function harness(): Promise<{ db: DatabaseSync; store: Store; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-branch-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = openDatabase(dataDir);
  cleanups.push(async () => db.close());
  return { db, store: new Store(db, new EventBus()), dataDir };
}

/**
 * A project on `workflowId` with its own registered scratch repo, a promoted
 * ticket claimed into a Run, and a real one-commit worktree for the phases to
 * write into. Returns the RunContext the engine executes against.
 */
function claimOn(store: Store, workflowId: number, tag: string): { ctx: RunContext } {
  const project = store.createProject({ name: `P-${tag}`, workflowId });
  const source = initScratchRepo("fixture");
  cleanups.push(() => rm(path.dirname(source), { recursive: true, force: true }));
  const repo = store.createRepo({
    projectId: project.id,
    path: source,
    githubRemote: `git@github.com:x/${tag}.git`,
  });
  const ticket = store.createTicket({
    projectId: project.id,
    title: "Ship the widget",
    acceptanceCriteria: [],
  });
  store.promoteTicket(ticket.id, { repoId: repo.id, provider: "claude-code" });
  const claim = store.claimNextTicket()!;
  const worktreePath = mkdtempSync(path.join(tmpdir(), "tracker-wt-"));
  cleanups.push(async () => rm(worktreePath, { recursive: true, force: true }));
  mkdirSync(path.join(worktreePath, "kb"), { recursive: true });
  return { ctx: { run: claim.run, ticket: claim.ticket, repo: claim.repo, worktreePath } };
}

function engineFor(store: Store, dataDir: string, provider: FakeProvider): WorkflowEngine {
  return new WorkflowEngine(
    store,
    { "claude-code": provider },
    new RunLogRegistry(),
    new PreviewManager(dataDir, store, previewPortBase()),
  );
}

describe("engine branch routing (ticket 46)", () => {
  // trigger → route(alpha|beta) → alpha|beta → merge (fan-in)
  const BRANCHED: { nodes: NodeSpec[]; edges: EdgeSpec[] } = {
    nodes: [
      { name: "ticketclaimed", type: "trigger" },
      { name: "route" },
      { name: "alpha" },
      { name: "beta" },
      { name: "merge" },
    ],
    edges: [
      { from: "ticketclaimed", to: "route" },
      { from: "route", to: "alpha", label: "alpha" },
      { from: "route", to: "beta", label: "beta" },
      { from: "alpha", to: "merge" },
      { from: "beta", to: "merge" },
    ],
  };

  test("a declared outcome runs its subtree; the other is skipped; fan-in runs once", async () => {
    const { db, store, dataDir } = await harness();

    for (const chosen of ["alpha", "beta"] as const) {
      const { workflowId } = seedWorkflow(db, `branchy-${chosen}`, BRANCHED.nodes, BRANCHED.edges);
      const provider = branchProvider(new Map(), (phase, cwd) =>
        writeContract(cwd, phase, phase === "route" ? `outcome: ${chosen}` : undefined),
      );
      const { ctx } = claimOn(store, workflowId, chosen);
      await engineFor(store, dataDir, provider).execute(ctx);

      const ran = store.listPhaseExecutions(ctx.run.id).map((p) => p.phase);
      const skipped = chosen === "alpha" ? "beta" : "alpha";
      expect(ran).toEqual(["route", chosen, "merge"]);
      expect(ran).not.toContain(skipped);
      // Fan-in ran exactly once.
      expect(ran.filter((p) => p === "merge")).toHaveLength(1);
    }
  });

  test("the branch node's labels arrive as template variables; the outcome is recorded", async () => {
    const { db, store, dataDir } = await harness();
    const { workflowId } = seedWorkflow(db, "branchy", BRANCHED.nodes, BRANCHED.edges);

    const prompts = new Map<string, string>();
    const provider = branchProvider(prompts, (phase, cwd) =>
      writeContract(cwd, phase, phase === "route" ? `outcome: beta` : undefined),
    );
    const { ctx } = claimOn(store, workflowId, "branchy");
    await engineFor(store, dataDir, provider).execute(ctx);

    // The branch node saw its choices; the merge node (single edge) saw "none".
    expect(prompts.get("route")).toContain("pick from alpha, beta");
    expect(prompts.get("merge")).toContain("pick from none");

    const byPhase = new Map(store.listPhaseExecutions(ctx.run.id).map((p) => [p.phase, p]));
    expect(byPhase.get("route")!.outcome).toBe("beta");
    // A single-edge node records no outcome, even though its template offered one.
    expect(byPhase.get("merge")!.outcome).toBeNull();
    expect(byPhase.get("beta")!.outcome).toBeNull();
  });

  test.each([
    ["no outcome", undefined, "declared no outcome"],
    ["an unrecognized outcome", "outcome: gamma", 'declared outcome "gamma"'],
    ["malformed frontmatter", "outcome: alpha", "declared no outcome"], // no closing fence, injected below
  ])("%s fails the branch phase, naming the expected labels", async (label, fm, reasonPart) => {
    const { db, store, dataDir } = await harness();
    const { workflowId } = seedWorkflow(db, `bad-${label}`, BRANCHED.nodes, BRANCHED.edges);

    const malformed = label === "malformed frontmatter";
    const provider = branchProvider(new Map(), (phase, cwd) => {
      if (phase !== "route") return writeContract(cwd, phase);
      if (malformed) {
        // An opening fence with no closing one — not a parseable block.
        writeFileSync(path.join(cwd, "kb", "route.md"), `---\noutcome: alpha\n# route\n`);
      } else {
        writeContract(cwd, phase, fm);
      }
    });
    const { ctx } = claimOn(store, workflowId, "bad");

    await expect(engineFor(store, dataDir, provider).execute(ctx)).rejects.toBeInstanceOf(
      PhaseFailedError,
    );
    const route = store.listPhaseExecutions(ctx.run.id).find((p) => p.phase === "route")!;
    expect(route.state).toBe("failed");
    expect(route.failureReason).toContain(reasonPart);
    // The reason always names the available labels.
    expect(route.failureReason).toContain("alpha, beta");
    // Nothing past the failed branch ran.
    expect(store.listPhaseExecutions(ctx.run.id).map((p) => p.phase)).toEqual(["route"]);
  });

  test("a single-unlabeled-edge node ignores a stray declared outcome", async () => {
    const { db, store, dataDir } = await harness();
    const { workflowId } = seedWorkflow(
      db,
      "linear",
      [
        { name: "ticketclaimed", type: "trigger" },
        { name: "only" },
        { name: "last" },
      ],
      [
        { from: "ticketclaimed", to: "only" },
        { from: "only", to: "last" },
      ],
    );

    // `only` declares a stray outcome though its node has one plain edge.
    const provider = branchProvider(new Map(), (phase, cwd) =>
      writeContract(cwd, phase, phase === "only" ? "outcome: whatever" : undefined),
    );
    const { ctx } = claimOn(store, workflowId, "linear");
    await engineFor(store, dataDir, provider).execute(ctx);

    const phases = store.listPhaseExecutions(ctx.run.id);
    expect(phases.map((p) => p.phase)).toEqual(["only", "last"]);
    expect(phases.every((p) => p.state === "completed")).toBe(true);
    expect(phases.every((p) => p.outcome === null)).toBe(true);
  });

  test("the gate battery is identical whichever path executed", async () => {
    const { db, store, dataDir } = await harness();
    // A branched workflow whose fan-in owes the same evidence on either path:
    // dogfood before the branch, document (recap) after it.
    const nodes: NodeSpec[] = [
      { name: "ticketclaimed", type: "trigger" },
      {
        name: "dogfood",
        gateRequirements: ["kb/dogfood-report.md", "kb/dogfood-results.json"],
      },
      { name: "route" },
      { name: "alpha" },
      { name: "beta" },
      { name: "document", gateRequirements: ["kb/recap.html"] },
    ];
    const edges: EdgeSpec[] = [
      { from: "ticketclaimed", to: "dogfood" },
      { from: "dogfood", to: "route" },
      { from: "route", to: "alpha", label: "alpha" },
      { from: "route", to: "beta", label: "beta" },
      { from: "alpha", to: "document" },
      { from: "beta", to: "document" },
    ];

    const battery = new GateBattery(store, new NullGitHub());
    const statusesFor = async (chosen: "alpha" | "beta"): Promise<Record<string, string>> => {
      const { workflowId } = seedWorkflow(db, `ev-${chosen}`, nodes, edges);
      const provider = branchProvider(new Map(), (phase, cwd) => {
        writeContract(cwd, phase, phase === "route" ? `outcome: ${chosen}` : undefined);
        if (phase === "dogfood") writeDogfood(cwd);
        if (phase === "document") writeRecap(cwd);
      });
      const { ctx } = claimOn(store, workflowId, chosen);
      await engineFor(store, dataDir, provider).execute(ctx);
      store.finishRun(ctx.run.id, "completed");
      await battery.run(ctx);
      return Object.fromEntries(
        store
          .listGateResults(ctx.run.id)
          .filter((r) => r.acId === null)
          .map((r) => [r.gate, r.status]),
      );
    };

    const viaAlpha = await statusesFor("alpha");
    const viaBeta = await statusesFor("beta");
    expect(viaAlpha).toEqual(viaBeta);
    // The evidence-driven gates greened on both paths — the fan-in ran either way.
    expect(viaAlpha["artifact"]).toBe("pass");
    expect(viaAlpha["artifact-lint"]).toBe("pass");
    expect(viaAlpha["dogfood-green"]).toBe("pass");
  });
});
