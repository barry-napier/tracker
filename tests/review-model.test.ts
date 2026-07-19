import { describe, expect, test } from "vitest";
import { parseMarkdown } from "../src/renderer/markdown.ts";
import {
  badgeRow,
  docsArtifacts,
  DOGFOOD_REPORT_NAME,
  findArtifact,
  missingArtifactLabel,
  walkthroughItems,
  WIZARD_STEPS,
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
  return { id: 1, ticketId: 1, state: "completed", worktreePath: null, crashReason: null, createdAt: "", endedAt: null, phases: [], artifacts, gateResults };
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

  test("docs step excludes the dogfood report — it has its own step", () => {
    expect(docsArtifacts(run([recap, dogfood, research, bounce])).map((a) => a.name)).toEqual([
      "recap.html",
      "research.md",
      "bounce-report.md",
    ]);
    expect(docsArtifacts(null)).toEqual([]);
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
