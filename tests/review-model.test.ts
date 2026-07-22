import { describe, expect, test } from "vitest";
import { parseMarkdown } from "../src/renderer/markdown.ts";
import {
  badgeRow,
  demoTranscriptArtifact,
  demoVideoArtifact,
  docsArtifacts,
  DOGFOOD_REPORT_NAME,
  failVerdictProblems,
  findArtifact,
  MARKABLE_STEPS,
  mergeProblems,
  missingArtifactLabel,
  parseDogfoodDecisions,
  unmetAcs,
  verdictSteps,
  walkthroughItems,
  WIZARD_STEPS,
  type ReviewMarks,
} from "../src/renderer/reviewModel.ts";
import type {
  AcceptanceCriterion,
  Artifact,
  GateResult,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
} from "../src/server/types.ts";

function artifact(id: number, name: string): Artifact {
  return { id, runId: 1, kind: "kb", name, path: `artifacts/run-1/${name}`, contentHash: "x", worktreeHeadSha: "abc", createdAt: "" };
}

function run(artifacts: Artifact[], gateResults: GateResult[] = []): RunWithPhases {
  return { id: 1, ticketId: 1, state: "completed", workflowVersionId: 1, worktreePath: null, crashReason: null, createdAt: "", endedAt: null, phases: [], artifacts, gateResults, expectedPhases: [] };
}

function gate(id: number, gateName: string, status: GateResult["status"], acId: number | null = null): GateResult {
  return { id, runId: 1, gate: gateName, status, detail: {}, acId, createdAt: "" };
}

function criterion(id: number, overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { id, ticketId: 1, text: `AC ${id}`, position: id, status: "pending", origin: "original", provenance: null, waiveReason: null, check: null, createdAt: "", updatedAt: "", ...overrides };
}

describe("wizard step roster", () => {
  test("the six steps, in prototype Variant A order", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual([
      "Visual Recap",
      "Dogfood Report",
      "Pull Request",
      "Documentation & Artifacts",
      "Manual Walkthrough",
      "Final Verdict",
    ]);
  });
});

describe("step artifact selection", () => {
  const recap = artifact(1, "recap.html");
  const dogfood = artifact(2, DOGFOOD_REPORT_NAME);
  const research = artifact(3, "research.md");
  const bounce = artifact(4, "bounce-report.md");

  test("finds a named artifact on the latest run only", () => {
    expect(findArtifact(run([recap, research]), "recap.html")).toEqual(recap);
    expect(findArtifact(run([research]), "recap.html")).toBeNull();
    expect(findArtifact(null, "recap.html")).toBeNull();
  });

  test("docs step excludes the dogfood report and the demo — each shows elsewhere", () => {
    const video = { ...artifact(6, "demo.webm"), kind: "demo" };
    expect(docsArtifacts(run([recap, dogfood, research, bounce, video])).map((a) => a.name)).toEqual([
      "recap.html",
      "research.md",
      "bounce-report.md",
    ]);
    expect(docsArtifacts(null)).toEqual([]);
  });

  test("the api walkthrough's transcript is the demo-kind artifact, by kind not name", () => {
    const transcript = { ...artifact(5, "curl-transcript.txt"), kind: "demo" };
    expect(demoTranscriptArtifact(run([recap, transcript]))).toEqual(transcript);
    expect(demoTranscriptArtifact(run([recap]))).toBeNull();
    expect(demoTranscriptArtifact(null)).toBeNull();
  });

  test("the ui walkthrough's video is the webm demo artifact; the transcript never claims it", () => {
    const video = { ...artifact(6, "demo.webm"), kind: "demo" };
    expect(demoVideoArtifact(run([recap, video]))).toEqual(video);
    expect(demoVideoArtifact(run([recap]))).toBeNull();
    expect(demoVideoArtifact(null)).toBeNull();
    expect(demoTranscriptArtifact(run([recap, video]))).toBeNull();
  });
});

describe("graceful degradation", () => {
  test("a park-by-cap arrival names the cap, never a blank panel", () => {
    const parked = { arrivedByCap: true } as Ticket;
    expect(missingArtifactLabel(parked, "recap.html")).toBe(
      "recap.html missing — arrived via bounce cap",
    );
  });

  test("an ordinary absence is stated plainly", () => {
    const normal = { arrivedByCap: false } as Ticket;
    expect(missingArtifactLabel(normal, "dogfood-report.md")).toBe(
      "dogfood-report.md was not produced by this run",
    );
  });
});

describe("dogfood decisions parsing (ticket 37)", () => {
  test("well-formed decisions parse with options and recommendation", () => {
    const decisions = parseDogfoodDecisions(
      JSON.stringify({
        scenarios: [],
        decisions: [
          {
            id: "D1",
            observed: "Dates reformat without warning",
            options: [
              { label: "Keep US order", cost: "surprises non-US users" },
              { label: "Match locale", cost: "one config read" },
            ],
            recommendation: "Match locale",
          },
        ],
      }),
    );
    expect(decisions).toEqual([
      {
        id: "D1",
        observed: "Dates reformat without warning",
        options: [
          { label: "Keep US order", cost: "surprises non-US users" },
          { label: "Match locale", cost: "one config read" },
        ],
        recommendation: "Match locale",
      },
    ]);
  });

  test("a broken, decision-less, or non-JSON file degrades to an empty list", () => {
    expect(parseDogfoodDecisions("{not json")).toEqual([]);
    expect(parseDogfoodDecisions(JSON.stringify({ scenarios: [] }))).toEqual([]);
    expect(parseDogfoodDecisions(JSON.stringify({ decisions: [{ observed: "no id" }] }))).toEqual([]);
  });

  test("missing option/recommendation fields fall back to empty strings", () => {
    const [decision] = parseDogfoodDecisions(
      JSON.stringify({ decisions: [{ id: "D2", options: [{ cost: "no label" }] }] }),
    );
    expect(decision).toEqual({ id: "D2", observed: "", options: [], recommendation: "" });
  });
});

describe("verification badge row", () => {
  test("one badge per named gate in battery order, AC checks aggregated", () => {
    const results = [
      gate(1, "artifact", "pass"),
      gate(2, "suite", "fail"),
      gate(3, "demo-fresh", "skip"),
      gate(4, "ac-check", "pass", 11),
      gate(5, "ac-check", "fail", 12),
      gate(6, "ac-check", "skip", 13),
    ];
    expect(badgeRow(run([], results))).toEqual([
      { gate: "artifact", status: "pass", summary: "" },
      { gate: "suite", status: "fail", summary: "" },
      { gate: "demo-fresh", status: "skip", summary: "" },
      { gate: "ac-checks", status: "fail", summary: "1 pass · 1 fail · 1 skip" },
    ]);
  });

  test("AC checks all passing or skipped roll up honestly", () => {
    expect(badgeRow(run([], [gate(1, "ac-check", "pass", 1), gate(2, "ac-check", "skip", 2)]))).toEqual([
      { gate: "ac-checks", status: "pass", summary: "1 pass · 1 skip" },
    ]);
    expect(badgeRow(run([], [gate(1, "ac-check", "skip", 1)]))).toEqual([
      { gate: "ac-checks", status: "skip", summary: "1 skip" },
    ]);
    expect(badgeRow(null)).toEqual([]);
  });
});

describe("walkthrough checklist", () => {
  test("every AC appears; human-routed ones carry the plan's reason", () => {
    const ticket = {
      acceptanceCriteria: [
        criterion(1),
        criterion(2, {
          check: { id: 9, acId: 2, runId: 1, kind: "human", scriptPath: null, reason: "needs eyes", createdAt: "", updatedAt: "" },
        }),
      ],
    } as TicketWithAcs;
    expect(walkthroughItems(ticket)).toEqual([
      { criterion: ticket.acceptanceCriteria[0], humanReason: null },
      { criterion: ticket.acceptanceCriteria[1], humanReason: "needs eyes" },
    ]);
  });
});

describe("verdict marks (ticket 33)", () => {
  test("every step except the verdict itself is markable", () => {
    expect(MARKABLE_STEPS.map((s) => s.key)).toEqual([
      "recap",
      "dogfood",
      "pr",
      "docs",
      "walkthrough",
    ]);
  });

  test("fail without a note is impossible; a noted fail enables the verdict", () => {
    const settled = { acceptanceCriteria: [criterion(1, { status: "verified" })] } as TicketWithAcs;
    const noGrounds = "no step is marked as failed and no acceptance criterion is failed";
    expect(failVerdictProblems({}, settled)).toEqual([noGrounds]);
    expect(failVerdictProblems({ recap: { status: "pass", note: "" } }, settled)).toEqual([
      noGrounds,
    ]);
    expect(failVerdictProblems({ recap: { status: "fail", note: "  " } }, settled)).toEqual([
      '"Visual Recap" is failed without a note',
    ]);
    expect(
      failVerdictProblems({ recap: { status: "fail", note: "hides the error path" } }, settled),
    ).toEqual([]);
  });

  test("a failed walkthrough is grounds on its own — no step mark needed", () => {
    const failedAc = {
      acceptanceCriteria: [criterion(1, { status: "failed" })],
    } as TicketWithAcs;
    expect(failVerdictProblems({}, failedAc)).toEqual([]);
  });

  test("the payload keeps marks in step order and only fails carry notes", () => {
    const marks: ReviewMarks = {
      walkthrough: { status: "skip", note: "stray draft note" },
      recap: { status: "fail", note: "hides the error path" },
      dogfood: { status: "pass", note: "" },
    };
    expect(verdictSteps(marks)).toEqual([
      { step: "recap", status: "fail", note: "hides the error path" },
      { step: "dogfood", status: "pass" },
      { step: "walkthrough", status: "skip" },
    ]);
  });

  test("unmet ACs and failed marks both block the merge, visibly", () => {
    const ticket = {
      acceptanceCriteria: [
        criterion(1, { status: "verified" }),
        criterion(2, { status: "waived" }),
        criterion(3, { status: "pending" }),
        criterion(4, { status: "failed" }),
      ],
    } as TicketWithAcs;
    expect(unmetAcs(ticket).map((ac) => ac.id)).toEqual([3, 4]);
    expect(mergeProblems(ticket, { pr: { status: "fail", note: "stale diff" } })).toEqual([
      "AC-3 is pending",
      "AC-4 is failed",
      'step "Pull Request" is marked as failed',
    ]);
    const settled = {
      acceptanceCriteria: [criterion(1, { status: "verified" })],
    } as TicketWithAcs;
    expect(mergeProblems(settled, { pr: { status: "pass", note: "" } })).toEqual([]);
  });
});

describe("naive markdown", () => {
  test("headings, paragraphs, lists, fences", () => {
    const blocks = parseMarkdown(
      "# Title\n\nSome **bold** and `code` text.\n\n- one\n- two\n\n1. first\n2. second\n\n```\nraw < & >\n```\n",
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inlines: [{ kind: "text", text: "Title" }] },
      {
        kind: "paragraph",
        inlines: [
          { kind: "text", text: "Some " },
          { kind: "strong", text: "bold" },
          { kind: "text", text: " and " },
          { kind: "code", text: "code" },
          { kind: "text", text: " text." },
        ],
      },
      { kind: "list", ordered: false, items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]] },
      { kind: "list", ordered: true, items: [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]] },
      { kind: "code", text: "raw < & >" },
    ]);
  });

  test("pipe tables — the dogfood matrix renders as rows, not soup", () => {
    const blocks = parseMarkdown(
      "| Journey | Status |\n| --- | --- |\n| Login | pass |\n| Logout | *fail* |\n",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        header: [[{ kind: "text", text: "Journey" }], [{ kind: "text", text: "Status" }]],
        rows: [
          [[{ kind: "text", text: "Login" }], [{ kind: "text", text: "pass" }]],
          [[{ kind: "text", text: "Logout" }], [{ kind: "em", text: "fail" }]],
        ],
      },
    ]);
  });

  test("multi-line paragraphs join; links keep their href", () => {
    const blocks = parseMarkdown("See [the PR](https://github.test/pr/1)\nfor details.\n");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "text", text: "See " },
          { kind: "link", text: "the PR", href: "https://github.test/pr/1" },
          { kind: "text", text: " for details." },
        ],
      },
    ]);
  });

  test("an unclosed fence still captures its tail", () => {
    expect(parseMarkdown("```sh\necho hi\n")).toEqual([{ kind: "code", text: "echo hi" }]);
  });
});
