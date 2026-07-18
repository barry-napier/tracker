import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { TrackerServer } from "../src/server/index.ts";
import type { AgentEvent, PhaseContext } from "../src/server/provider.ts";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { commit } from "./git-helpers.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

async function promoteTicket(
  server: TrackerServer,
  overrides: Record<string, unknown> = {},
): Promise<{ ticket: any; repo: any; project: any }> {
  const { project, repo } = await seedWorkspace(server);
  const ticket = (
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "Ship the widget",
      description: "The widget must ship.",
      acceptanceCriteria: ["Widget renders"],
      ...overrides,
    })
  ).json;
  await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
    repoId: repo.id,
    provider: "claude-code",
  });
  return { ticket, repo, project };
}

async function waitForTicketState(
  server: TrackerServer,
  ticketId: number,
  state: string,
  timeoutMs = 10_000,
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

/** The full conversation, block by block: all five kinds, text streamed as a delta. */
function* conversation(prompt: string): Generator<AgentEvent> {
  yield { type: "block.open", blockId: "b1", block: { kind: "prompt", text: prompt } };
  yield { type: "block.close", blockId: "b1" };
  yield { type: "block.open", blockId: "b2", block: { kind: "thinking", text: "Widget first." } };
  yield { type: "block.close", blockId: "b2" };
  yield { type: "block.open", blockId: "b3", block: { kind: "text", text: "Shipping " } };
  yield { type: "block.delta", blockId: "b3", textDelta: "the widget." };
  yield { type: "block.close", blockId: "b3" };
  yield {
    type: "block.open",
    blockId: "b4",
    block: { kind: "tool_call", tool: "write_file", input: '{"path":"widget.ts"}' },
  };
  yield { type: "block.close", blockId: "b4" };
  yield {
    type: "block.open",
    blockId: "b5",
    block: { kind: "tool_result", tool: "write_file", output: "ok", isError: false },
  };
  yield { type: "block.close", blockId: "b5" };
}

/** Writes the Phase Contract file and a real commit, like a well-behaved agent. */
function writeContract(cwd: string, phase: string): void {
  mkdirSync(path.join(cwd, "kb"), { recursive: true });
  writeFileSync(path.join(cwd, "kb", `${phase}.md`), `# ${phase}\n\nDid the thing.\n`);
}

describe("one phase runs through the FakeProvider", () => {
  test("a claimed ticket runs the seeded phase and reaches Verifying", async () => {
    const calls: PhaseContext[] = [];
    const provider = new FakeProvider(async function* (ctx) {
      calls.push(ctx);
      yield* conversation(ctx.prompt);
      writeContract(ctx.cwd, "implement");
      commit(ctx.cwd, "widget.ts", "export const widget = true;\n", "feat: widget");
      return { outcome: "completed" as const };
    });
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": provider },
    });
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    const { ticket } = await promoteTicket(server);
    const verifying = await waitForTicketState(server, ticket.id, "verifying");
    expect(verifying.state).toBe("verifying");

    // Fresh session per phase: exactly one call, cwd = the run's worktree.
    expect(calls).toHaveLength(1);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[0].endedAt).not.toBeNull();
    expect(calls[0]!.cwd).toBe(runs[0].worktreePath);

    // The prompt is rendered from the node template with the ticket's context.
    expect(calls[0]!.prompt).toContain("Ship the widget");
    expect(calls[0]!.prompt).toContain("Widget renders");
    expect(calls[0]!.prompt).toContain("kb/implement.md");

    // Phase executions recorded on the run.
    expect(runs[0].phases).toHaveLength(1);
    expect(runs[0].phases[0]).toMatchObject({ phase: "implement", state: "completed" });

    // Audit trail carries the phase transitions and the run's end.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: { type: string }) => event.type);
    expect(types).toContain("phase.started");
    expect(types).toContain("phase.completed");
    expect(types).toContain("run.completed");

    // The board saw the transition live.
    const updates = client.messages.filter((m) => m.event === "ticket.updated");
    expect(updates.some((m) => m.data.state === "verifying")).toBe(true);
    const phaseEvents = client.messages.filter((m) => m.event === "run.phase_changed");
    expect(phaseEvents.map((m) => m.data.status)).toEqual(["started", "completed"]);
    expect(phaseEvents[0]!.data).toMatchObject({ phase: "implement", ticketId: ticket.id });
  });

  test("the per-run log stream replays the full conversation, block by block", async () => {
    const provider = new FakeProvider(async function* (ctx) {
      yield* conversation(ctx.prompt);
      writeContract(ctx.cwd, "implement");
      return { outcome: "completed" as const };
    });
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": provider },
    });
    const { ticket } = await promoteTicket(server);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const log = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`);
    cleanups.push(async () => log.close());

    const opens = await log.waitFor("block.open", 5);
    expect(opens.map((m) => m.data.block.kind)).toEqual([
      "prompt",
      "thinking",
      "text",
      "tool_call",
      "tool_result",
    ]);
    // Every block is tagged with the phase that produced it.
    expect(opens.every((m) => m.data.phase === "implement")).toBe(true);

    const deltas = await log.waitFor("block.delta", 1);
    expect(deltas[0]!.data).toMatchObject({ blockId: "b3", textDelta: "the widget." });
    await log.waitFor("block.close", 5);

    // Resume from the middle: Last-Event-ID replays only what follows.
    const resumeFrom = opens[2]!.id;
    const resumed = await SseClient.connect(`${server.url}/api/runs/${runs[0].id}/log`, resumeFrom);
    cleanups.push(async () => resumed.close());
    const resumedOpens = await resumed.waitFor("block.open", 2);
    expect(resumedOpens.map((m) => m.data.block.kind)).toEqual(["tool_call", "tool_result"]);
  });

  test("a provider that never writes the contract file fails the phase", async () => {
    let attempt = 0;
    const provider = new FakeProvider(async function* (ctx) {
      attempt += 1;
      yield* conversation(ctx.prompt);
      // First attempt is hollow: provider claims success, no kb/implement.md.
      if (attempt > 1) writeContract(ctx.cwd, "implement");
      return { outcome: "completed" as const };
    });
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": provider },
    });
    const { ticket } = await promoteTicket(server);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    // Newest first: the retry completed, the hollow attempt failed.
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "failed" });
    expect(runs[1].phases[0]).toMatchObject({ phase: "implement", state: "failed" });
    expect(runs[1].phases[0].failureReason).toContain("kb/implement.md");

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: { type: string }) => event.type);
    expect(types).toContain("phase.failed");
    expect(types).toContain("run.failed");
  });

  test("a crashing provider crashes the run; the re-claim recovers", async () => {
    let attempt = 0;
    const provider = new FakeProvider(async function* (ctx) {
      attempt += 1;
      if (attempt === 1) throw new Error("provider fell over");
      yield* conversation(ctx.prompt);
      writeContract(ctx.cwd, "implement");
      return { outcome: "completed" as const };
    });
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": provider },
    });
    const { ticket } = await promoteTicket(server);
    await waitForTicketState(server, ticket.id, "verifying");

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "completed" });
    expect(runs[1]).toMatchObject({ state: "crashed" });
    expect(runs[1].crashReason).toContain("provider fell over");
    // Infrastructure death is recorded as crashed, not blamed on the work.
    expect(runs[1].phases[0]).toMatchObject({ phase: "implement", state: "crashed" });

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(audit.map((event: { type: string }) => event.type)).toContain("run.crashed");
  });
});
