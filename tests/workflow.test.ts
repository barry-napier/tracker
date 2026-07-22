import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups, cleanups } from "./server-helpers.ts";
import { SseClient } from "./sse-client.ts";
import {
  bootWorkspace,
  PHASES,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

// "verifying" is transient in a NullGitHub workspace: pr-fresh and
// branch-recorded are doomed, the battery bounces, and any assertion made
// after the wait races the re-claim (CI's first Linux run lost exactly that
// race in plan-checks.test.ts). Every full-workflow test here pushes to a
// FakeGitHub so the battery lands green and "human_review" is stable.

afterEach(runCleanups);

describe("the full seeded workflow", () => {
  test("five phases run in order with fresh sessions and kb handoff", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const { dataDir, server, ticket } = await bootWorkspace(
      scriptedProvider(calls, { onPhase: pushesToGitHub(github) }),
      { github },
    );
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    await waitForTicketState(server, ticket.id, "human_review");

    // Every phase ran once, in graph order, in the run's worktree — then the
    // review agent's digest session (TRK-3) before Human Review.
    expect(calls.map((c) => c.phase)).toEqual([...PHASES, "review-digest"]);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(1);
    expect(calls.every((c) => c.cwd === runs[0].worktreePath)).toBe(true);

    // The fixed template variable set is the only context injection.
    const acId = ticket.acceptanceCriteria[0].id;
    const research = calls[0]!.prompt;
    expect(research).toContain("Ship the widget");
    expect(research).toContain(`[pending] AC-${acId}: Widget renders`);
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

    // kb/* persisted to app data: kind, content hash, worktree HEAD SHA. Five
    // phase contracts, the recap, the dogfood phase's report + results, and
    // the review agent's digest (TRK-3, its own kind).
    const headSha = git(runs[0].worktreePath, "rev-parse", "HEAD");
    expect(runs[0].artifacts).toHaveLength(9);
    for (const artifact of runs[0].artifacts) {
      expect(artifact.kind).toBe(artifact.name === "review-digest.json" ? "review-digest" : "kb");
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.worktreeHeadSha).toBe(headSha);
      expect(existsSync(path.join(dataDir, artifact.path))).toBe(true);
    }
    expect(runs[0].artifacts.map((a: any) => a.name).sort()).toEqual(
      [
        ...[...PHASES].map((p) => `${p}.md`),
        "recap.html",
        "dogfood-report.md",
        "dogfood-results.json",
        "review-digest.json",
      ].sort(),
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
    expect(runUpdates.at(-1)!.data.artifacts.length).toBeGreaterThanOrEqual(8);

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: { type: string }) => event.type);
    expect(types.filter((t: string) => t === "phase.started")).toHaveLength(5);
    expect(types).toContain("artifacts.persisted");
  }, 20_000);

  // Failure paths — phase deaths, the one retry, the crash cap, and the
  // startup orphan sweep — live in crash-policy.test.ts (ticket 41).

  test("the per-run log stream carries every phase's blocks with unique ids", async () => {
    const calls: PhaseCall[] = [];
    const github = new FakeGitHub();
    const { server, ticket } = await bootWorkspace(
      scriptedProvider(calls, { onPhase: pushesToGitHub(github) }),
      { github },
    );
    await waitForTicketState(server, ticket.id, "human_review");

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
