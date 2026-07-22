import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { lintReviewDigest } from "../src/server/review-agent.ts";
import { digestForAc, parseReviewDigest } from "../src/renderer/reviewModel.ts";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** A green board: every phase behaves, implement lands a real commit. */
function greenWorkspace(hooks: Parameters<typeof scriptedProvider>[1] = {}) {
  const github = new FakeGitHub();
  const calls: PhaseCall[] = [];
  const provider = scriptedProvider(calls, {
    ...hooks,
    onPhase: async (ctx) => {
      if (ctx.phase === "implement" && ctx.attempt === 1) {
        writeFileSync(path.join(ctx.cwd, "widget.txt"), "the widget\n");
        git(ctx.cwd, "add", "widget.txt");
        git(ctx.cwd, "commit", "-m", "add widget");
      }
      await pushesToGitHub(github)(ctx);
    },
  });
  return {
    github,
    calls,
    boot: () => bootWorkspace(provider, { github, repo: { testCommand: "true" } }),
  };
}

describe("the review agent's pre-digest (TRK-3)", () => {
  test("after green gates a digest session runs before Human Review; findings persist as evidence (AC-39, AC-40)", async () => {
    const { calls, boot } = greenWorkspace();
    const { server, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");

    // The digest session ran once, dead last — after every workflow phase,
    // in the run's worktree, its brief naming the diff and the ACs.
    expect(calls.at(-1)!.phase).toBe("review-digest");
    expect(calls.at(-1)!.prompt).toContain("git diff main...HEAD");
    expect(calls.at(-1)!.prompt).toContain(`AC-${ticket.acceptanceCriteria[0].id}`);

    // Persisted as Run evidence with its own kind, stamped at the HEAD the
    // agent read — the raw material for staleness (AC-43).
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];
    const artifact = run.artifacts.find((a: any) => a.kind === "review-digest");
    expect(artifact).toMatchObject({ name: "review-digest.json" });
    expect(artifact.worktreeHeadSha).toBe(git(run.worktreePath, "rev-parse", "HEAD"));

    // The wizard's read model points straight at it, fresh, unflagged.
    const review = (await api(server, "GET", `/api/tickets/${ticket.id}/review`)).json;
    expect(review.digest).toMatchObject({ artifactId: artifact.id, freshness: "fresh" });
    expect(review.digestFailure).toBeNull();

    // On the audit trail as produced — the digest's provenance record.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(
      audit.find((event: any) => event.type === "review.digest")?.detail,
    ).toMatchObject({ runId: run.id, status: "produced" });
  }, 20_000);

  test("a dead digest degrades gracefully: raw-diff wizard, flagged, ticket lands anyway (AC-42)", async () => {
    const { boot } = greenWorkspace({
      // The agent writes garbage: the lint refuses it, the wizard opens raw.
      reviewDigest: (ctx) => {
        writeFileSync(path.join(ctx.cwd, "kb", "review-digest.json"), "not json at all");
      },
    });
    const { server, ticket } = await boot();

    const arrived = await waitForTicketState(server, ticket.id, "human_review");
    expect(arrived).toMatchObject({ bounceCount: 0, arrivedByCap: false });

    const review = (await api(server, "GET", `/api/tickets/${ticket.id}/review`)).json;
    expect(review.digest).toBeNull();
    expect(review.digestFailure).toContain("not valid JSON");

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(
      audit.find((event: any) => event.type === "review.digest")?.detail,
    ).toMatchObject({ status: "failed" });
  }, 20_000);

  test("commits landing after the digest invalidate it (AC-43)", async () => {
    const { boot } = greenWorkspace();
    const { server, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");
    const run = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json[0];

    // Someone moves the branch after the agent read it.
    writeFileSync(path.join(run.worktreePath, "hotfix.txt"), "surprise\n");
    git(run.worktreePath, "add", "hotfix.txt");
    git(run.worktreePath, "commit", "-m", "hotfix after digest");
    git(run.worktreePath, "push", "--quiet", "origin", git(run.worktreePath, "branch", "--show-current"));

    const review = (await api(server, "GET", `/api/tickets/${ticket.id}/review`)).json;
    expect(review.digest.freshness).toBe("stale");
  }, 20_000);
});

describe("lintReviewDigest", () => {
  test("a well-formed digest passes; empty arrays are honest answers", () => {
    expect(
      lintReviewDigest(
        JSON.stringify({
          walkthrough: [{ file: "a.ts", note: "start here" }],
          risks: [],
          acMap: [{ acId: 3, note: "covered", files: ["a.ts"] }],
        }),
      ),
    ).toEqual([]);
  });

  test("missing sections and malformed entries are named", () => {
    expect(lintReviewDigest("nope")).toEqual(["not valid JSON"]);
    expect(lintReviewDigest(JSON.stringify({ walkthrough: [{}], risks: "x", acMap: [{ acId: "3" }] }))).toEqual([
      "walkthrough[0] needs string file and note",
      "risks must be an array",
      "acMap[0] needs a numeric acId and a string note",
    ]);
  });
});

describe("parseReviewDigest (wizard side)", () => {
  test("parses defensively and maps ACs to entries", () => {
    const digest = parseReviewDigest(
      JSON.stringify({
        walkthrough: [{ file: "a.ts", note: "start" }, { file: 7 }],
        risks: [{ note: "careful", severity: "high" }, { note: "meh", severity: "spicy" }],
        acMap: [{ acId: 5, note: "here", files: ["a.ts", 9] }],
      }),
    );
    expect(digest.walkthrough).toEqual([{ file: "a.ts", note: "start" }]);
    expect(digest.risks).toEqual([
      { note: "careful", severity: "high" },
      { note: "meh", severity: null },
    ]);
    expect(digestForAc(digest, 5)).toEqual({ acId: 5, note: "here", files: ["a.ts"] });
    expect(digestForAc(digest, 6)).toBeNull();
    expect(parseReviewDigest("garbage")).toEqual({ walkthrough: [], risks: [], acMap: [] });
  });
});
