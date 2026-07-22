import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pendingAcIdsFromPrompt,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  writeDogfood,
  writePlanChecks,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/**
 * A check with a real referent: exits 0 only once the implement phase has
 * produced widget.txt. Written on the first plan, reused untouched on the
 * second — the convergence proof that scripts re-execute without re-authoring.
 */
const WIDGET_CHECK = "#!/bin/sh\ntest -f widget.txt\n";

function commitFile(cwd: string, name: string, content: string): void {
  writeFileSync(path.join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", `add ${name}`);
}

describe("the bounce machinery", () => {
  test("fail → bounce → converge-green across two Runs through the API seam", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      planChecks: (ctx) => {
        if (ctx.attempt === 1) {
          // A meaningful check that the first implement attempt won't satisfy.
          writePlanChecks(ctx.cwd, ctx.prompt, () => WIDGET_CHECK);
          return;
        }
        // Second plan: cover the follow-up ACs with fresh scripts but point
        // the original AC at the script already sitting in the reused
        // worktree — nothing re-authored, the battery just re-executes it.
        const [originalId, ...followUpIds] = pendingAcIdsFromPrompt(ctx.prompt).sort(
          (a, b) => a - b,
        );
        const manifest: Record<string, string> = {
          [String(originalId)]: `checks/ac-${originalId}.sh`,
        };
        for (const acId of followUpIds) {
          const script = `checks/ac-${acId}.sh`;
          writeFileSync(path.join(ctx.cwd, script), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          manifest[String(acId)] = script;
        }
        writeFileSync(
          path.join(ctx.cwd, "checks", "manifest.json"),
          JSON.stringify(manifest, null, 2),
        );
      },
      onPhase: async (ctx) => {
        if (ctx.phase === "implement" && ctx.attempt === 1) {
          // Real work lands (ahead-by 1) plus an uncommitted scratch file
          // (dirty 1) — but not the widget the check demands.
          commitFile(ctx.cwd, "feature.txt", "half the feature\n");
          writeFileSync(path.join(ctx.cwd, "notes.txt"), "scratch thoughts\n");
        }
        if (ctx.phase === "implement" && ctx.attempt === 2) {
          commitFile(ctx.cwd, "widget.txt", "the widget\n");
        }
        if (ctx.phase === "dogfood" && ctx.attempt === 1) {
          // Sabotage one gate: an honest-red scenario fails dogfood-green.
          // Schema-valid, so the phase boundary's lint (TRK-1) waves it
          // through — greenness is the battery's judgment alone.
          writeDogfood(ctx.cwd, { status: "fail" });
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { dataDir, server, ticket } = await bootWorkspace(provider, {
      github,
      acceptanceCriteria: ["The widget file exists"],
      repo: { testCommand: "true" },
    });
    const originalAcId = ticket.acceptanceCriteria[0].id;

    await waitForTicketState(server, ticket.id, "human_review");

    // Two Runs, one worktree: the re-claim reused the tree as-is.
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    const [secondRun, firstRun] = runs;
    expect(secondRun.worktreePath).toBe(firstRun.worktreePath);
    const worktree = firstRun.worktreePath;

    // Untouched means untouched: run 1's uncommitted scratch file survived,
    // and its check script was re-executed verbatim, never re-authored.
    expect(readFileSync(path.join(worktree, "notes.txt"), "utf8")).toBe("scratch thoughts\n");
    expect(readFileSync(path.join(worktree, `checks/ac-${originalAcId}.sh`), "utf8")).toBe(
      WIDGET_CHECK,
    );

    // One bounce event carried the whole batch, tree state included.
    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced");
    expect(bounced.detail).toMatchObject({
      runId: firstRun.id,
      bounceCount: 1,
      failed: ["dogfood-green", `ac-check:AC-${originalAcId}`],
      treeState: { branch: ticket.branch ?? expect.any(String), aheadBy: 1, dirtyCount: 1 },
    });
    expect(bounced.detail.followUpAcIds).toHaveLength(1);

    // The gate failure became a follow-up AC; both ACs converged green on
    // run 2 with machine provenance.
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail).toMatchObject({ state: "human_review", bounceCount: 1, arrivedByCap: false });
    expect(detail.acceptanceCriteria).toHaveLength(2);
    expect(detail.acceptanceCriteria[0]).toMatchObject({
      id: originalAcId,
      status: "verified",
      provenance: "machine",
      origin: "original",
    });
    const followUp = detail.acceptanceCriteria[1];
    expect(followUp).toMatchObject({ origin: "gate-fail", status: "verified" });
    expect(followUp.text).toContain("Dogfood scenario S1");
    expect(bounced.detail.followUpAcIds).toEqual([followUp.id]);

    // The Bounce Report: written into the persisting worktree, recorded as a
    // Run artifact, and deterministic — criterion, check, excerpt, tree state,
    // prior-run pointers. No LLM prose.
    expect(existsSync(path.join(worktree, "kb", "bounce-report.md"))).toBe(true);
    const reportArtifact = firstRun.artifacts.find((a: any) => a.kind === "bounce-report");
    expect(reportArtifact).toMatchObject({ name: "bounce-report.md" });
    const report = readFileSync(path.join(dataDir, reportArtifact.path), "utf8");
    expect(report).toContain("dogfood-green");
    expect(report).toContain(`AC-${originalAcId}: The widget file exists`);
    expect(report).toContain(`checks/ac-${originalAcId}.sh`);
    expect(report).toContain("Dogfood scenario S1 reaches pass, fixed, or waived (was fail)");
    expect(report).toContain(detail.branch);
    expect(report).toContain(`run ${firstRun.id}`);
    expect(report).toContain("Ahead of origin/main by: 1");
    expect(report).toContain("Dirty files: 1");

    // The bounce authored the follow-up's check before run 2 existed (TRK-2):
    // a dedicated session, recorded between the runs.
    const authoring = calls.find((call) => call.phase === "author-checks");
    expect(authoring?.prompt).toContain(`AC-${followUp.id}`);

    // Run 2's fresh sessions received the follow-ups and the report path,
    // and saw the failed AC reset to pending.
    const run2Research = calls.filter((call) => call.phase === "research")[1]!;
    expect(run2Research.phase).toBe("research");
    expect(run2Research.prompt).toContain("kb/bounce-report.md");
    expect(run2Research.prompt).toContain(followUp.text);
    expect(run2Research.prompt).toContain(`[pending] AC-${originalAcId}:`);

    // Convergence evidence: run 2 re-executed the original check and passed.
    const recheck = secondRun.gateResults.find((r: any) => r.acId === originalAcId);
    expect(recheck).toMatchObject({
      status: "pass",
      detail: { scriptPath: `checks/ac-${originalAcId}.sh`, exitCode: 0 },
    });

    // The PR belongs to the Ticket, stable across the bounce: run 2 pushed
    // to the same branch and found the same PR — recorded exactly once.
    expect(detail.prNumber).toBe(1);
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    expect(audit.filter((event: any) => event.type === "pr.recorded")).toHaveLength(1);
  }, 30_000);

  test("the third failed cycle parks the ticket in Human Review, flagged arrived-by-cap", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      // Every cycle green except the AC check: the failure is spec-shaped,
      // exactly what the cap exists to surface to a human.
      planChecks: (ctx) => writePlanChecks(ctx.cwd, ctx.prompt, () => "#!/bin/sh\nexit 1\n"),
      onPhase: pushesToGitHub(github),
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      acceptanceCriteria: ["Never satisfiable by machine", "Wins design awards"],
      repo: { testCommand: "true" },
    });

    // A pre-waived AC must ride through every cycle untouched.
    const waivedId = ticket.acceptanceCriteria[1].id;
    await api(server, "POST", `/api/acs/${waivedId}/waive`, { reason: "not a launch criterion" });

    await waitForTicketState(server, ticket.id, "human_review", 30_000);

    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail).toMatchObject({ state: "human_review", bounceCount: 3, arrivedByCap: true });
    expect(detail.acceptanceCriteria.find((ac: any) => ac.id === waivedId)).toMatchObject({
      status: "waived",
      waiveReason: "not a launch criterion",
    });

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(3);
    // Every failed cycle produced its Bounce Report — the park included, so
    // the wizard has evidence to show even for a by-cap arrival.
    for (const run of runs) {
      expect(run.artifacts.some((a: any) => a.kind === "bounce-report")).toBe(true);
    }

    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const types = audit.map((event: any) => event.type);
    expect(types.filter((t: string) => t === "ticket.bounced")).toHaveLength(2);
    const parked = audit.find((event: any) => event.type === "ticket.parked");
    expect(parked.detail).toMatchObject({ bounceCount: 3, reason: "bounce-cap" });

    // Parked means parked: no fourth claim ever happened.
    expect(calls.filter((c) => c.phase === "research")).toHaveLength(3);
  }, 40_000);
});
