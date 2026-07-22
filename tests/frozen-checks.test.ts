import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForAudit,
  waitForTicketState,
  writeDogfood,
  writePlanChecks,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

/** A real referent: holds only once implement has produced widget.txt. */
const WIDGET_CHECK = "#!/bin/sh\ntest -f widget.txt\n";
/** writePlanChecks' default script body — also exactly what a cheat rigs. */
const DEFAULT_CHECK = "#!/bin/sh\nexit 0\n";
/** What a cheating implement session would swap the exam for. */
const RIGGED_CHECK = DEFAULT_CHECK;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("frozen ac-checks (TRK-2)", () => {
  test("scripts freeze at plan exit — hash on record before implement starts (AC-35)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    // What the ticket's checks look like the moment implement begins: the
    // fresh single-ticket DB makes /api/tickets/1 the ticket under test.
    const snapshots: any[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") {
          snapshots.push((await api(serverRef!, "GET", "/api/tickets/1")).json);
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    let serverRef: Awaited<ReturnType<typeof bootWorkspace>>["server"] | undefined;
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
      beforePromote: async (bootedServer) => {
        serverRef = bootedServer;
      },
    });
    await waitForTicketState(server, ticket.id, "human_review");

    // The implement session began with the exam already frozen: script
    // registered, sha256 recorded — the hash of the plan phase's exact bytes.
    expect(snapshots).toHaveLength(1);
    const check = snapshots[0].acceptanceCriteria[0].check;
    expect(check).toMatchObject({ kind: "script", contentHash: sha256(DEFAULT_CHECK) });
  }, 20_000);

  test("an implement session rewriting its exam fails the ac-check on drift — the script never runs (AC-36, AC-38)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      // A check with teeth: exits 0 only once the widget exists.
      planChecks: (ctx) => writePlanChecks(ctx.cwd, ctx.prompt, () => WIDGET_CHECK),
      onPhase: async (ctx) => {
        if (ctx.phase === "implement" && ctx.attempt === 1) {
          // The cheat: skip the work, rig the exam to exit 0 instead.
          const acId = Number(/checks\/ac-(\d+)\.sh/.exec(ctx.prompt)?.[1] ?? 1);
          writeFileSync(path.join(ctx.cwd, `checks/ac-${acId}.sh`), RIGGED_CHECK, { mode: 0o755 });
        }
        if (ctx.phase === "implement" && ctx.attempt === 2) {
          // The honest attempt: do the work, leave the exam alone.
          writeFileSync(path.join(ctx.cwd, "widget.txt"), "the widget\n");
          git(ctx.cwd, "add", "widget.txt");
          git(ctx.cwd, "commit", "-m", "add widget");
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      acceptanceCriteria: ["The widget file exists"],
    });
    const acId = ticket.acceptanceCriteria[0].id;

    await waitForTicketState(server, ticket.id, "human_review", 30_000);
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs).toHaveLength(2);
    const [secondRun, firstRun] = runs;

    // Run 1: the rigged script was refused on its hash, never executed —
    // exit 0 bought nothing, and the failure names the drift.
    const cheated = firstRun.gateResults.find((r: any) => r.acId === acId);
    expect(cheated).toMatchObject({
      status: "fail",
      detail: {
        reason: "check script drifted from its frozen hash — checks are read-only after registration",
        frozenHash: sha256(WIDGET_CHECK),
        actualHash: sha256(RIGGED_CHECK),
      },
    });
    expect(cheated.detail.exitCode).toBeUndefined();

    // Run 2: the plan re-froze the same honest exam; the real work passed it
    // (AC-38 — frozen script executed, per-AC verdict as always).
    const honest = secondRun.gateResults.find((r: any) => r.acId === acId);
    expect(honest).toMatchObject({ status: "pass", detail: { exitCode: 0 } });
    const detail = (await api(server, "GET", `/api/tickets/${ticket.id}`)).json;
    expect(detail).toMatchObject({ state: "human_review", bounceCount: 1, arrivedByCap: false });
    expect(detail.acceptanceCriteria[0]).toMatchObject({ status: "verified", provenance: "machine" });
  }, 30_000);

  test("a gate-fail follow-up gets its check authored at bounce time, outside the implementing session (AC-37)", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        // Honest-red dogfood on the first pass: one bounce, one follow-up AC.
        if (ctx.phase === "dogfood" && ctx.attempt === 1) {
          writeDogfood(ctx.cwd, { status: "fail" });
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });

    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced", 30_000);
    const followUpAcId = bounced.detail.followUpAcIds[0];
    await waitForTicketState(server, ticket.id, "human_review", 30_000);

    // The authoring session ran between the runs — after run 1's phases,
    // before any of run 2's — and its brief named the minted follow-up.
    const order = calls.map((call) => call.phase);
    const authorIndex = order.indexOf("author-checks");
    expect(authorIndex).toBeGreaterThan(order.indexOf("document"));
    expect(authorIndex).toBeLessThan(order.lastIndexOf("research"));
    expect(calls[authorIndex]!.prompt).toContain(`AC-${followUpAcId}`);

    // Registered and frozen against run 1 — a second checks.registered event
    // on the bounced run, alongside the plan phase's.
    const audit = (await api(server, "GET", `/api/tickets/${ticket.id}/audit`)).json;
    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    const firstRunId = runs.at(-1).id;
    const registrations = audit.filter(
      (event: any) => event.type === "checks.registered" && event.detail.runId === firstRunId,
    );
    expect(registrations).toHaveLength(2);
  }, 30_000);

  test("a review-fail follow-up gets its check authored at bounce time too (AC-37)", async () => {
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
    const { server, ticket } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });
    await waitForTicketState(server, ticket.id, "human_review");

    const NOTE = "The empty state renders blank — show the zero-items copy.";
    const verdict = await api(server, "POST", `/api/tickets/${ticket.id}/verdict`, {
      outcome: "fail",
      steps: [{ step: "recap", status: "fail", note: NOTE }],
    });
    expect(verdict.status).toBe(200);

    const bounced = await waitForAudit(server, ticket.id, "ticket.bounced");
    const followUpAcId = bounced.detail.followUpAcIds[0];
    const authoring = calls.find((call) => call.phase === "author-checks");
    expect(authoring?.prompt).toContain(`AC-${followUpAcId}`);
    expect(authoring?.prompt).toContain(NOTE);
  }, 30_000);
});
