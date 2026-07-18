import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrackerServer } from "../src/server/index.ts";
import type { AgentEvent, PhaseContext } from "../src/server/provider.ts";
import { FakeProvider, pendingAcIdsFromPrompt, phaseFromPrompt } from "../src/server/providers/fake.ts";
import { api, bootServer, cleanups, seedWorkspace } from "./server-helpers.ts";

export const PHASES = ["research", "plan", "implement", "dogfood", "document"] as const;

export type PhaseCall = PhaseContext & { phase: string; attempt: number };

/** The full conversation, block by block: all five kinds, text streamed as a delta. */
export function* conversation(phase: string, prompt: string): Generator<AgentEvent> {
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

export function writeContract(cwd: string, phase: string): void {
  mkdirSync(path.join(cwd, "kb"), { recursive: true });
  writeFileSync(path.join(cwd, "kb", `${phase}.md`), `# ${phase}\n\nDid the ${phase} thing.\n`);
}

/** A well-behaved plan phase: one passing script per pending AC + the manifest. */
export function writePlanChecks(cwd: string, prompt: string): void {
  mkdirSync(path.join(cwd, "checks"), { recursive: true });
  const manifest: Record<string, string> = {};
  for (const acId of pendingAcIdsFromPrompt(prompt)) {
    const script = `checks/ac-${acId}.sh`;
    writeFileSync(path.join(cwd, script), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    manifest[String(acId)] = script;
  }
  writeFileSync(path.join(cwd, "checks", "manifest.json"), JSON.stringify(manifest));
}

/**
 * A well-behaved agent for every phase — misbehaves only where the test's
 * `sabotage` hook says so (return false → skip the contract file; throw →
 * crash) and the `planChecks` hook can replace the default check-writing
 * behavior (write scripts + full manifest).
 */
export function scriptedProvider(
  calls: PhaseCall[],
  sabotage: (phase: string, attempt: number) => void | false = () => {},
  planChecks: (ctx: PhaseCall) => void = (ctx) => writePlanChecks(ctx.cwd, ctx.prompt),
): FakeProvider {
  const attempts = new Map<string, number>();
  return new FakeProvider(async function* (ctx) {
    const phase = phaseFromPrompt(ctx.prompt);
    const attempt = (attempts.get(phase) ?? 0) + 1;
    attempts.set(phase, attempt);
    const call = { ...ctx, phase, attempt };
    calls.push(call);
    yield* conversation(phase, ctx.prompt);
    if (sabotage(phase, attempt) !== false) {
      writeContract(ctx.cwd, phase);
      if (phase === "plan") planChecks(call);
    }
    return { outcome: "completed" as const, providerSessionId: `sess-${phase}-${attempt}` };
  });
}

export async function bootWorkspace(
  provider: FakeProvider,
  options: { acceptanceCriteria?: string[] } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-wf-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const server = await bootServer(dataDir, { workers: 3, providers: { "claude-code": provider } });
  const { project, repo } = await seedWorkspace(server);
  const ticket = (
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "Ship the widget",
      description: "The widget must ship.",
      acceptanceCriteria: options.acceptanceCriteria ?? ["Widget renders"],
    })
  ).json;
  await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
    repoId: repo.id,
    provider: "claude-code",
  });
  return { dataDir, server, ticket };
}

export async function waitForTicketState(
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
