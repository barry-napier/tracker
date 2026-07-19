import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/**
 * A green path to Human Review: every phase behaves, every check passes, and
 * implement lands a real commit so the eventual squash merge has content.
 */
function wellBehavedWorkspace(acceptanceCriteria: string[]) {
  const github = new FakeGitHub();
  const calls: PhaseCall[] = [];
  const provider = scriptedProvider(calls, {
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
    boot: () =>
      bootWorkspace(provider, { github, acceptanceCriteria, repo: { testCommand: "true" } }),
  };
}

describe("wizard verdicts (ticket 33)", () => {
  test("a failed review bounces with the reviewer's notes verbatim; the next run converges", async () => {
    const { github, calls, boot } = wellBehavedWorkspace([
      "Widget renders",
      "Error copy reads well",
    ]);
    void github;
    const { dataDir, server, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");
    const copyAcId = ticket.acceptanceCriteria[1].id;

    // Fail without a note is impossible — at the API seam, not just the UI.
    const noNote = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [{ step: "recap", status: "fail" }],
    });
    expect(noNote.status).toBe(400);
    expect(noNote.json.error).toContain("note");
    const noFails = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [{ step: "recap", status: "pass" }],
    });
    expect(noFails.status).toBe(400);

    // The walkthrough's human fail lands on the row before the verdict.
    const failedAc = await api(server, "POST", `/api/acs/${copyAcId}/fail`, {});
    expect(failedAc.status).toBe(200);
    expect(failedAc.json).toMatchObject({ status: "failed", provenance: "human" });

    const NOTE =
      "The recap hides the error path — show the failing state, not just the happy one.";
    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [
        { step: "recap", status: "fail", note: NOTE },
        { step: "dogfood", status: "pass" },
        { step: "walkthrough", status: "skip" },
      ],
    });
    expect(verdict.status).toBe(200);

    // The bounce is on the audit trail as the human's act, whole batch in one
    // event: the marks as submitted plus the follow-up born from the note.
    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced");
    expect(bounced.actor).toBe("human");
    expect(bounced.detail).toMatchObject({ reason: "review-fail", bounceCount: 1 });
    expect(bounced.detail.followUpAcIds).toHaveLength(1);

    // Slice-30 machinery from here: re-claim, converge, back to Human Review.
    const detail = await waitForTicketState(server, ticket.id, "human_review");
    expect(detail).toMatchObject({ state: "human_review", bounceCount: 1, arrivedByCap: false });
    expect(detail.acceptanceCriteria).toHaveLength(3);
    const followUp = detail.acceptanceCriteria[2];
    expect(followUp).toMatchObject({
      origin: "review-fail",
      text: NOTE,
      status: "verified",
      provenance: "machine",
    });
    expect(bounced.detail.followUpAcIds).toEqual([followUp.id]);
    // The human-failed AC reset to pending on the re-claim and re-earned its
    // green mark by machine — human provenance never persists a failure.
    expect(detail.acceptanceCriteria[1]).toMatchObject({
      id: copyAcId,
      status: "verified",
      provenance: "machine",
    });

    // Run 1's Bounce Report carries the reviewer's feedback verbatim and the
    // human-failed criterion, and the next run's sessions received the note.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    const firstRun = runs[1];
    const reportArtifact = firstRun.artifacts.find((a: any) => a.kind === "bounce-report");
    expect(reportArtifact).toBeDefined();
    const report = readFileSync(path.join(dataDir, reportArtifact.path), "utf8");
    expect(report).toContain("Reviewer feedback");
    expect(report).toContain(NOTE);
    expect(report).toContain(`AC-${copyAcId}`);
    expect(report).toContain("review-fail");
    const run2Research = calls.find((c) => c.phase === "research" && c.attempt === 2);
    expect(run2Research!.prompt).toContain(NOTE);
    expect(run2Research!.prompt).toContain("kb/bounce-report.md");
  }, 30_000);

  test("a failed walkthrough alone bounces: failed ACs need no fabricated step mark", async () => {
    const { boot } = wellBehavedWorkspace(["Widget renders"]);
    const { server, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");
    const acId = ticket.acceptanceCriteria[0].id;

    // Nothing failed anywhere → no grounds to fail the review.
    const noGrounds = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [],
    });
    expect(noGrounds.status).toBe(400);

    await api(server, "POST", `/api/acs/${acId}/fail`, {});
    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [],
    });
    expect(verdict.status).toBe(200);

    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced");
    expect(bounced.detail).toMatchObject({ reason: "review-fail", followUpAcIds: [] });

    // The failed AC reset to pending on re-claim and re-earned green.
    const detail = await waitForTicketState(server, ticket.id, "human_review");
    expect(detail).toMatchObject({ bounceCount: 1 });
    expect(detail.acceptanceCriteria).toHaveLength(1);
    expect(detail.acceptanceCriteria[0]).toMatchObject({
      status: "verified",
      provenance: "machine",
    });
  }, 30_000);

  test("the walkthrough settles ACs with human provenance, and only from real rows", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Walkthrough fodder",
        acceptanceCriteria: ["Looks right", "Feels right"],
      })
    ).json;
    const [first, second] = ticket.acceptanceCriteria;

    const verified = await api(server, "POST", `/api/acs/${first.id}/verify`, {});
    expect(verified.status).toBe(200);
    expect(verified.json).toMatchObject({ status: "verified", provenance: "human" });

    const failed = await api(server, "POST", `/api/acs/${second.id}/fail`, {});
    expect(failed.json).toMatchObject({ status: "failed", provenance: "human" });

    // A later human verify clears an earlier waive's reason: one status, one story.
    await api(server, "POST", `/api/acs/${second.id}/waive`, { reason: "not for launch" });
    const unWaived = await api(server, "POST", `/api/acs/${second.id}/verify`, {});
    expect(unWaived.json).toMatchObject({ status: "verified", provenance: "human", waiveReason: null });

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(audit.filter((e: any) => e.type === "ac.verified" && e.actor === "human")).toHaveLength(2);
    expect(audit.filter((e: any) => e.type === "ac.failed" && e.actor === "human")).toHaveLength(1);

    const missing = await api(server, "POST", "/api/acs/9999/verify", {});
    expect(missing.status).toBe(404);
  });

  test("drift at Final Verdict blocks the merge; force-merge is a waive-equivalent, audited", async () => {
    const { boot } = wellBehavedWorkspace(["Widget renders"]);
    const { server, repo, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");

    // The branch moves on the remote after the evidence persisted: drift.
    const { branch } = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    const tree = git(repo.path, "rev-parse", `${branch}^{tree}`);
    const newTip = git(repo.path, "commit-tree", tree, "-p", branch, "-m", "later commit");
    git(repo.path, "update-ref", `refs/heads/${branch}`, newTip);

    const blocked = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.drift).toBeInstanceOf(Array);
    expect(blocked.json.drift.join(" ")).toContain(newTip.slice(0, 7));
    // Blocked means blocked: nothing moved, nothing merged.
    const still = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(still.state).toBe("human_review");

    const forced = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "pass",
      force: true,
    });
    expect(forced.status).toBe(200);
    expect(forced.json.state).toBe("done");
    expect(git(repo.path, "show", "main:widget.txt", "--")).toBeDefined();

    // The waive-equivalent event: the verdict records exactly what was waived.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const recorded = audit.find((e: any) => e.type === "verdict.recorded");
    expect(recorded.actor).toBe("human");
    expect(recorded.detail.freshnessWaived).toBeInstanceOf(Array);
    expect(recorded.detail.freshnessWaived.join(" ")).toContain(newTip.slice(0, 7));
  }, 30_000);

  test("re-verify bounces for a fresh battery run, audited as the reviewer's choice", async () => {
    const { boot } = wellBehavedWorkspace(["Widget renders"]);
    const { dataDir, server, ticket } = await boot();
    await waitForTicketState(server, ticket.id, "human_review");

    const reverify = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "reverify",
    });
    expect(reverify.status).toBe(200);

    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced");
    expect(bounced.actor).toBe("human");
    expect(bounced.detail).toMatchObject({ reason: "stale-evidence", bounceCount: 1 });
    expect(bounced.detail.followUpAcIds).toEqual([]);

    // No follow-ups — the next run just re-earns the evidence.
    const detail = await waitForTicketState(server, ticket.id, "human_review");
    expect(detail).toMatchObject({ bounceCount: 1, arrivedByCap: false });
    expect(detail.acceptanceCriteria).toHaveLength(1);
    expect(detail.acceptanceCriteria[0]).toMatchObject({ status: "verified", provenance: "machine" });

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    const reportArtifact = runs[1].artifacts.find((a: any) => a.kind === "bounce-report");
    const report = readFileSync(path.join(dataDir, reportArtifact.path), "utf8");
    expect(report).toContain("Re-verify");
  }, 30_000);

  test("verdicts on the wrong state or shape are refused", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Still in backlog",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const badOutcome = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "maybe",
    });
    expect(badOutcome.status).toBe(400);

    // Step marks are validated against the wizard's roster — the API can't
    // mint follow-ups under a step name the wizard never shows.
    const badStep = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [{ step: "banana", status: "fail", note: "not a step" }],
    });
    expect(badStep.status).toBe(400);
    expect(badStep.json.error).toContain("banana");

    const wrongState = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [{ step: "recap", status: "fail", note: "not even claimed yet" }],
    });
    expect(wrongState.status).toBe(409);
    expect(wrongState.json.error).toContain("backlog");

    const reverifyWrongState = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "reverify",
    });
    expect(reverifyWrongState.status).toBe(409);
  });
});
