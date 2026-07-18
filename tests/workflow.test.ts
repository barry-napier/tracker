import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { TrackerServer } from "../src/server/index.ts";
import type { AgentEvent, PhaseContext } from "../src/server/provider.ts";
import { FakeProvider, phaseFromPrompt } from "../src/server/providers/fake.ts";
import { git } from "./git-helpers.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

const PHASES = ["research", "plan", "implement", "dogfood", "document"] as const;

/** The full conversation, block by block: all five kinds, text streamed as a delta. */
function* conversation(phase: string, prompt: string): Generator<AgentEvent> {
  const id = (n: number) => `${phase}-b${n}`;
  yield { type: "block.open", blockId: id(1), block: { kind: "prompt", text: prompt } };
  yield { type: "block.close", blockId: id(1) };
  yield { type: "block.open", blockId: id(2), block: { kind: "thinking", text: `${phase} first.` } };
  yield { type: "block.close", blockId: id(2) };
  yield { type: "block.open", blockId: id(3), block: { kind: "text", text: "Working " } };
  yield { type: "block.delta", blockId: id(3), textDelta: `through ${phase}.` };
  yield { type: "block.close", blockId: id(3) };
  yield {
    type: "block.open",
    blockId: id(4),
    block: { kind: "tool_call", tool: "write_file", input: `{"path":"kb/${phase}.md"}` },
  };
  yield { type: "block.close", blockId: id(4) };
  yield {
    type: "block.open",
    blockId: id(5),
    block: { kind: "tool_result", tool: "write_file", output: "ok", isError: false },
  };
  yield { type: "block.close", blockId: id(5) };
}

function writeContract(cwd: string, phase: string): void {
  mkdirSync(path.join(cwd, "kb"), { recursive: true });
  writeFileSync(path.join(cwd, "kb", `${phase}.md`), `# ${phase}\n\nDid the ${phase} thing.\n`);
}

/**
 * A well-behaved agent for every phase — misbehaves only where the test's
 * `sabotage` hook says so (return false → skip the contract file; throw → crash).
 */
function scriptedProvider(
  calls: Array<PhaseContext & { phase: string; attempt: number }>,
  sabotage: (phase: string, attempt: number) => void | false = () => {},
): FakeProvider {
  const attempts = new Map<string, number>();
  return new FakeProvider(async function* (ctx) {
    const phase = phaseFromPrompt(ctx.prompt);
    const attempt = (attempts.get(phase) ?? 0) + 1;
    attempts.set(phase, attempt);
    calls.push({ ...ctx, phase, attempt });
    yield* conversation(phase, ctx.prompt);
    if (sabotage(phase, attempt) !== false) writeContract(ctx.cwd, phase);
    return { outcome: "completed" as const, providerSessionId: `sess-${phase}-${attempt}` };
  });
}

async function bootWorkspace(provider: FakeProvider) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-wf-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const server = await bootServer(dataDir, { workers: 3, providers: { "claude-code": provider } });
  const { project, repo } = await seedWorkspace(server);
  const ticket = (
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "Ship the widget",
      description: "The widget must ship.",
      acceptanceCriteria: ["Widget renders"],
    })
  ).json;
  await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
    repoId: repo.id,
    provider: "claude-code",
  });
  return { dataDir, server, ticket };
}

async function waitForTicketState(
  server: TrackerServer,
  ticketId: number,
  state: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(server, "GET", `/api/tickets/${ticketId}`);
    if (json.state === state) return json;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ticket ${ticketId} to reach ${state}; at ${json.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the full seeded workflow", () => {
  test("five phases run in order with fresh sessions and kb handoff", async () => {
    const calls: Array<PhaseContext & { phase: string; attempt: number }> = [];
    const { dataDir, server, ticket } = await bootWorkspace(scriptedProvider(calls));
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await waitForTicketState(server, ticket.id, "verifying");

    // Every phase ran once, in graph order, in the run's worktree.
    expect(calls.map((c) => c.phase)).toEqual([...PHASES]);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(calls.every((c) => c.cwd === runs[0].worktreePath)).toBe(true);

    // The fixed template variable set is the only context injection.
    const research = calls[0]!.prompt;
    expect(research).toContain("Ship the widget");
    expect(research).toContain("[pending] Widget renders");
    expect(research).toContain("none yet");
    const implement = calls[2]!.prompt;
    expect(implement).toContain("kb/research.md, kb/plan.md");

    // Phase executions carry outcome and provider session id per node.
    expect(runs[0].phases).toHaveLength(5);
    expect(runs[0].phases.map((p: any) => p.phase)).toEqual([...PHASES]);
    for (const phase of runs[0].phases) {
      expect(phase.state).toBe("completed");
      expect(phase.providerSessionId).toBe(`sess-${phase.phase}-1`);
    }

    // kb/* persisted to app data: kind, content hash, worktree HEAD SHA.
    const headSha = git(runs[0].worktreePath, "rev-parse", "HEAD");
    expect(runs[0].artifacts).toHaveLength(5);
    for (const artifact of runs[0].artifacts) {
      expect(artifact.kind).toBe("kb");
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.worktreeHeadSha).toBe(headSha);
      expect(existsSync(path.join(dataDir, artifact.path))).toBe(true);
    }
    expect(runs[0].artifacts.map((a: any) => a.name).sort()).toEqual(
      [...PHASES].map((p) => `${p}.md`).sort(),
    );

    // The board heard each phase start and finish, and the run end enriched.
    const phaseEvents = client.messages.filter((m) => m.event === "run.phase_changed");
    expect(phaseEvents.map((m) => m.data.phase)).toEqual(
      [...PHASES].flatMap((p) => [p, p]),
    );
    expect(phaseEvents.map((m) => m.data.status)).toEqual(
      [...PHASES].flatMap(() => ["started", "completed"]),
    );
    const runUpdates = client.messages.filter((m) => m.event === "run.updated");
    expect(runUpdates.at(-1)!.data.artifacts).toHaveLength(5);

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: { type: string }) => event.type);
    expect(types.filter((t: string) => t === "phase.started")).toHaveLength(5);
    expect(types).toContain("artifacts.persisted");
  }, 20_000);

  test("a hollow mid-workflow phase fails the run but its evidence survives", async () => {
    const calls: Array<PhaseContext & { phase: string; attempt: number }> = [];
    const provider = scriptedProvider(calls, (phase, attempt) =>
      phase === "implement" && attempt === 1 ? false : undefined,
    );
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "failed" });

    // The hollow attempt stopped at implement; nothing after it ran.
    expect(runs[1].phases.map((p: any) => [p.phase, p.state])).toEqual([
      ["research", "completed"],
      ["plan", "completed"],
      ["implement", "failed"],
    ]);
    expect(runs[1].phases[2].failureReason).toContain("kb/implement.md");

    // Pass, bounce, or crash: what the run did produce is persisted.
    expect(runs[1].artifacts.map((a: any) => a.name).sort()).toEqual(["plan.md", "research.md"]);
  }, 20_000);

  test("a crashing phase crashes the run; the re-claim recovers", async () => {
    const calls: Array<PhaseContext & { phase: string; attempt: number }> = [];
    const provider = scriptedProvider(calls, (phase, attempt) => {
      if (phase === "research" && attempt === 1) throw new Error("provider fell over");
    });
    const { server, ticket } = await bootWorkspace(provider);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "crashed" });
    expect(runs[1].crashReason).toContain("provider fell over");
    expect(runs[1].phases[0]).toMatchObject({ phase: "research", state: "crashed" });
    expect(runs[1].artifacts).toHaveLength(0);
  }, 20_000);

  test("the per-run log stream carries every phase's blocks with unique ids", async () => {
    const calls: Array<PhaseContext & { phase: string; attempt: number }> = [];
    const { server, ticket } = await bootWorkspace(scriptedProvider(calls));
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const log = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`);
    cleanups.push(async () => log.close());

    const opens = await log.waitFor("block.open", 25);
    expect(opens.map((m) => m.data.block.kind).slice(0, 5)).toEqual([
      "prompt",
      "thinking",
      "text",
      "tool_call",
      "tool_result",
    ]);
    // Opens are tagged with the phase that produced them, in graph order.
    expect(opens.map((m) => m.data.phase)).toEqual(
      [...PHASES].flatMap((p) => [p, p, p, p, p]),
    );
    const ids = opens.map((m) => m.data.blockId);
    expect(new Set(ids).size).toBe(ids.length);
    await log.waitFor("block.delta", 5);

    // Resume from the middle: Last-Event-ID replays only what follows.
    const resumeFrom = opens[22]!.id;
    const resumed = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`, resumeFrom);
    cleanups.push(async () => resumed.close());
    const resumedOpens = await resumed.waitFor("block.open", 2);
    expect(resumedOpens.map((m) => m.data.block.kind)).toEqual(["tool_call", "tool_result"]);
    expect(resumedOpens.every((m) => m.data.phase === "document")).toBe(true);
  }, 20_000);
});
