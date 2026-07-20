import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitHubPort } from "../src/server/github.ts";
import type { TrackerServer } from "../src/server/index.ts";
import type { AgentEvent, PhaseContext } from "../src/server/provider.ts";
import type { Project } from "../src/server/types.ts";
import { FakeProvider, phaseFromPrompt, writePlanChecks } from "../src/server/providers/fake.ts";
import { git } from "./git-helpers.ts";
import type { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, cleanups, FIXTURE_REMOTE, seedWorkspace } from "./server-helpers.ts";

export { pendingAcIdsFromPrompt, writePlanChecks } from "../src/server/providers/fake.ts";

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

/** A recap that satisfies both hard lint rules (self-contained + review notes). */
export const CLEAN_RECAP =
  "<style>body { font: 14px sans-serif; }</style>\n" +
  "<h1>Visual Recap</h1>\n<p>The widget shipped.</p>\n" +
  '<h2>What to review</h2>\n<ol><li>Nothing surprising.</li></ol>\n';

export function writeRecap(cwd: string, html: string = CLEAN_RECAP): void {
  mkdirSync(path.join(cwd, "kb"), { recursive: true });
  writeFileSync(path.join(cwd, "kb", "recap.html"), html);
}

/**
 * What a well-behaved dogfood phase authors (ticket 36): the machine-readable
 * results file (one scenario, schema-conforming) and the five-section report.
 * `status: "fail"` proves the honest-red path — the phase still completes with
 * both artifacts present; the teeth belong to slice 37's dogfood-green gate.
 */
export function writeDogfood(
  cwd: string,
  opts: { status?: "pass" | "fail"; append?: string } = {},
): void {
  const status = opts.status ?? "pass";
  mkdirSync(path.join(cwd, "kb"), { recursive: true });
  const results = {
    ticket: "TRK-1",
    frozen_sha: "HEAD",
    base: "main",
    scenarios: [
      {
        id: "S1",
        journey: "Use the widget end to end and confirm the far-end proof",
        kind: "browser",
        branch: "happy",
        status,
        flow_ref: "AC-1",
      },
    ],
  };
  writeFileSync(path.join(cwd, "kb", "dogfood-results.json"), JSON.stringify(results, null, 2));
  const verdict = status === "pass" ? "READY" : "BLOCKED (human decision)";
  writeFileSync(
    path.join(cwd, "kb", "dogfood-report.md"),
    [
      "# Dogfood report — TRK-1: Ship the widget",
      "",
      `> Verdict: **${verdict}**`,
      "",
      "## Matrix",
      "",
      "| # | Journey | Kind | Functional | Experiential | Evidence | Fix |",
      "|---|---|---|---|---|---|---|",
      `| S1 | Use the widget | browser | ${status} | — | — | — |`,
      "",
      "**Cut from the matrix**: nothing.",
      "",
      "## Paper cuts",
      "",
      "None.",
      "",
      "## Decisions for a human",
      "",
      "None.",
      "",
      "## Instruments",
      "",
      "- Suite: skipped in the fixture.",
      opts.append ?? "",
      "",
    ].join("\n"),
  );
}

/**
 * A well-behaved agent for every phase — misbehaves only where the test's
 * `sabotage` hook says so (return false → skip the contract file and every
 * other side effect; return "hang" → go silent forever, for the watchdog and
 * orphan paths; throw → crash). The `planChecks` hook can replace the
 * default check-writing behavior (write scripts + full manifest); `onPhase`
 * runs after a well-behaved phase's side effects, for test-specific extras
 * (a broken recap, a GitHub push).
 */
export function scriptedProvider(
  calls: PhaseCall[],
  hooks: {
    sabotage?: (phase: string, attempt: number) => void | false | "hang";
    planChecks?: (ctx: PhaseCall) => void;
    onPhase?: (ctx: PhaseCall) => void | Promise<void>;
  } = {},
): FakeProvider {
  const {
    sabotage = () => {},
    planChecks = (ctx: PhaseCall) => writePlanChecks(ctx.cwd, ctx.prompt),
    onPhase = () => {},
  } = hooks;
  const attempts = new Map<string, number>();
  return new FakeProvider(async function* (ctx) {
    const phase = phaseFromPrompt(ctx.prompt);
    const attempt = (attempts.get(phase) ?? 0) + 1;
    attempts.set(phase, attempt);
    const call = { ...ctx, phase, attempt };
    calls.push(call);
    yield* conversation(phase, ctx.prompt);
    const verdict = sabotage(phase, attempt);
    // A hung agent: no more output, no exit — only a kill ends it.
    if (verdict === "hang") await new Promise<never>(() => {});
    if (verdict !== false) {
      writeContract(ctx.cwd, phase);
      if (phase === "plan") planChecks(call);
      if (phase === "dogfood") writeDogfood(ctx.cwd);
      if (phase === "document") writeRecap(ctx.cwd);
      await onPhase(call);
    }
    return { outcome: "completed" as const, providerSessionId: `sess-${phase}-${attempt}` };
  });
}

export async function bootWorkspace(
  provider: FakeProvider,
  options: {
    acceptanceCriteria?: string[];
    /** Extra fields for the repo registration (testCommand, previewCommand…). */
    repo?: Record<string, unknown>;
    github?: GitHubPort;
    /** Watchdog overrides for the crash-policy tests (ticket 41). */
    phaseTimeouts?: { silenceMs?: number; wallClockMs?: number };
    /** Workspace surgery (e.g. re-pointing the project's workflow) before the promotion triggers claims. */
    beforePromote?: (server: TrackerServer, project: Project) => Promise<void>;
  } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-wf-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const server = await bootServer(dataDir, {
    workers: 3,
    providers: { "claude-code": provider },
    github: options.github,
    phaseTimeouts: options.phaseTimeouts,
  });
  const { project, repo } = await seedWorkspace(server, options.repo);
  await options.beforePromote?.(server, project);
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
  return { dataDir, server, ticket, repo };
}

/**
 * The agent's production job at the end of a run: really push the branch
 * (the worktree's origin is the repo standing in for GitHub's copy), then
 * open the PR through the port — or leave the existing one alone, its head
 * moved by the push, exactly as GitHub would (ticket 31: one Ticket = one
 * branch = one PR, stable across bounces).
 */
export function pushesToGitHub(github: FakeGitHub): (ctx: PhaseCall) => Promise<void> {
  return async (ctx) => {
    if (ctx.phase !== "document") return;
    const branch = git(ctx.cwd, "branch", "--show-current");
    github.registerRemote(FIXTURE_REMOTE, git(ctx.cwd, "remote", "get-url", "origin"));
    git(ctx.cwd, "push", "--quiet", "origin", branch);
    if ((await github.findPr(FIXTURE_REMOTE, branch)) === null) {
      await github.createPr(FIXTURE_REMOTE, {
        branch,
        targetBranch: "main",
        title: `Ship it: ${branch}`,
        body: "Opened by the scripted agent.",
      });
    }
  };
}

export async function waitForAudit(
  server: TrackerServer,
  ticketId: number,
  type: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(server, "GET", `/api/tickets/${ticketId}/audit`);
    const event = json.find((candidate: any) => candidate.type === type);
    if (event) return event;
    if (Date.now() > deadline) throw new Error(`timed out waiting for audit event ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait for a repeatedly-failing ticket to come to rest: `count` runs exist
 * and every one has settled. The crash cap (ticket 41) parks a ticket in
 * Human Review after 3 crashed runs, so this state — unlike the "todo"
 * between cycles, which a worker re-claims immediately — is stable to
 * assert against. Racing a transient state is exactly what made these tests
 * pass on one machine's timing and fail on another's.
 */
export async function waitForSettledRuns(
  server: TrackerServer,
  ticketId: number,
  count: number,
  timeoutMs = 20_000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(server, "GET", `/api/tickets/${ticketId}/runs`);
    if (json.length === count && json.every((run: any) => run.state !== "running")) return json;
    if (Date.now() > deadline) {
      const states = json.map((run: any) => run.state).join(", ");
      throw new Error(
        `timed out waiting for ${count} settled runs on ticket ${ticketId}; have [${states}]`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
