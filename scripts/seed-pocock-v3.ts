/**
 * Publish the agent-drivable Pocock workflow (v3) against a RUNNING Tracker
 * server: `npx tsx scripts/seed-pocock-v3.ts [baseUrl]` (default
 * http://localhost:4400 — the dev server; point it at the packaged app's port
 * to seed the real library).
 *
 * Why v3 is linear: Pocock's front half (grill-with-docs → prototype →
 * to-spec → to-tickets) is HITL and lives in the AI intake flow — the engine
 * has no mid-run human channel, so v2's trigger-level branch and interview
 * phases could never execute (the REV-1 dead-graph incident). The workflow
 * keeps only the agent-drivable back half: implement → code-review. The
 * ticket description IS the spec; intake writes it that way.
 */

import type { DraftGraph } from "../src/server/types.ts";

const BASE = process.argv[2] ?? "http://localhost:4400";
const NAME = "Pocock";

const DESCRIPTION =
  "Matt Pocock's flow, split at the tickets line: grilling, prototyping, spec, " +
  "and slicing happen in the AI intake (HITL); the workflow runs the " +
  "agent-drivable back half — implement (TDD at the seams, emits AC checks) " +
  "then code-review (Standards + Spec axes, never merged). The ticket " +
  "description is the spec.";

const IMPLEMENT_PROMPT = `You are the implement phase for {{displayKey}}: {{title}}.

THE TICKET DESCRIPTION IS THE SPEC — the grilling, spec synthesis, and slicing happened at intake; you never see that conversation, so the description below is authoritative. Speak the repo's CONTEXT.md glossary and respect the ADRs in the area.

{{description}}

Acceptance criteria:
{{acceptanceCriteria}}

Knowledge from earlier phases: {{priorKb}}
Follow-up criteria from prior cycles: {{followUps}}
Bounce report: {{bounceReportPath}}

Drive the build test-first on branch {{branch}} (target {{targetBranch}}): red before green, one vertical slice at a time, behavior through public interfaces only. Choose the highest seam possible and prefer seams that already exist — the ideal number is one. Typecheck regularly; run single test files as you go; run the FULL suite once, at the end. Refactoring belongs to review, not the TDD loop.

For every pending acceptance criterion (numbered AC-<id> above): if it is machine-checkable, write an executable script checks/ac-<id>.sh that exits 0 when the criterion holds — the description's "## Suggested checks" section sketches most of them; otherwise route it to a human. Then write checks/manifest.json mapping every pending AC id to its script path or to {"human": "<one-line reason>"} — for example {"3": "checks/ac-3.sh", "4": {"human": "needs visual judgment"}}.

Commit to the current branch as you go. Before finishing, write kb/{{phase}}.md: what you built, the seams you tested at, and any decision the ticket left open that you had to make.`;

const REVIEW_PROMPT = `You are the code-review phase for {{displayKey}}: {{title}}.

Review the diff on two axes that are NEVER merged or reranked:
- Standards: does the change follow this repo's rules? Repo standards sources first (CONTEXT.md, docs/adr/, lint and style config), the classic code-smell baseline second; repo standards override.
- Spec: does it do what was asked? The ticket description below IS the spec — there is no separate PRD.

{{description}}

Acceptance criteria:
{{acceptanceCriteria}}

Knowledge from earlier phases: {{priorKb}}

Pin the fixed point first: the three-dot diff against the merge-base with {{targetBranch}}, plus the commit list; the diff must be non-empty. Keep each axis under 400 words, worst issue first. Write kb/review.md with both axes' findings verbatim under "## Standards" and "## Spec" — two reports side by side, never a single winner. Fix nothing yourself.

Before finishing, write kb/{{phase}}.md summarizing the review outcome and the risks a human should weigh.`;

const GRAPH: DraftGraph = {
  nodes: [
    {
      key: "trigger",
      type: "trigger",
      name: "ticket-claimed",
      promptTemplate: null,
      emitsChecks: false,
      bootsPreview: false,
      gateRequirements: [],
      steps: [],
    },
    {
      key: "implement",
      type: "agent_phase",
      name: "implement",
      promptTemplate: IMPLEMENT_PROMPT,
      emitsChecks: true,
      bootsPreview: false,
      gateRequirements: [],
      steps: [
        {
          type: "search-code",
          title: "Read the spec",
          prompt: "The ticket description is the spec — read it and the code it names before touching anything.",
        },
        {
          type: "action",
          title: "TDD the slice",
          prompt: "Red before green, one vertical slice at a time, behavior through public interfaces only.",
        },
        {
          type: "action",
          title: "Emit AC checks",
          prompt: "checks/ac-<id>.sh per machine-checkable AC, checks/manifest.json covering every pending AC.",
        },
        {
          type: "author",
          title: "Contract",
          prompt: "kb/implement.md: what was built, the seams tested at, decisions the ticket left open.",
        },
      ],
    },
    {
      key: "code-review",
      type: "agent_phase",
      name: "code-review",
      promptTemplate: REVIEW_PROMPT,
      emitsChecks: false,
      bootsPreview: false,
      gateRequirements: ["kb/review.md"],
      steps: [
        {
          type: "action",
          title: "Pin the fixed point",
          prompt: "Three-dot diff against the merge-base; the diff must be non-empty.",
        },
        {
          type: "action",
          title: "Two parallel axes",
          prompt: "Standards and Spec, reviewed independently, never merged or reranked.",
        },
        {
          type: "author",
          title: "Aggregate report",
          prompt: "kb/review.md with ## Standards and ## Spec verbatim; kb/code-review.md as the contract.",
        },
      ],
    },
  ],
  edges: [
    { from: "trigger", to: "implement", conditionLabel: null },
    { from: "implement", to: "code-review", conditionLabel: null },
  ],
};

async function call(method: string, route: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

const workflows: Array<{ id: number; name: string }> = await call("GET", "/api/workflows");
let workflow = workflows.find((w) => w.name === NAME);
if (workflow) {
  console.log(`Found workflow "${NAME}" (id ${workflow.id}); updating description.`);
  await call("PATCH", `/api/workflows/${workflow.id}`, { description: DESCRIPTION });
} else {
  workflow = await call("POST", "/api/workflows", {
    name: NAME,
    description: DESCRIPTION,
    color: "#d85a30",
  });
  console.log(`Created workflow "${NAME}" (id ${workflow!.id}).`);
}

await call("PUT", `/api/workflows/${workflow!.id}/draft`, GRAPH);
const { violations } = await call("POST", `/api/workflows/${workflow!.id}/draft/validate`);
if (violations.length > 0) {
  console.error("Draft is invalid; not publishing:");
  for (const v of violations) console.error(`  - [${v.rule}] ${v.message}`);
  process.exit(1);
}
const published = await call("POST", `/api/workflows/${workflow!.id}/draft/publish`);
console.log(
  `Published "${NAME}" v${published.version} (phases: ${published.phases.join(" → ")}).`,
);
