import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Repo } from "./types.ts";

/**
 * The dogfood phase (ticket 36, per the ticket-11 formats): the seed
 * workflow's fourth node runs against a live Preview Environment and produces
 * the Dogfood Report and its machine-readable results file. The vendored
 * prompt assets below are adapted from the prototype's `dogfood/` skill
 * bundle for Tracker's model — fresh-session-per-phase, contract-file handoff,
 * no CLI, the preview booted by the orchestrator before the phase starts.
 *
 * The assets live in code (not the DB) so the migration stays small and so
 * the schema is importable — slice 37's `artifact-lint` validates the results
 * file against MATRIX_SCHEMA. The dogfood node's prompt template references
 * these through the engine's fixed template variable set (ticket 07).
 */

/** Worktree-relative outputs the dogfood phase owes beyond its contract file. */
export const DOGFOOD_REPORT_PATH = "kb/dogfood-report.md";
export const DOGFOOD_RESULTS_PATH = "kb/dogfood-results.json";

/** The governor's hard caps (ticket 11 §3), prompt-enforced in DOGFOOD_GOVERNOR. */
export const GOVERNOR_FIXES_PER_SCENARIO = 2;
export const GOVERNOR_FIXES_PER_RUN = 4;

/**
 * The verification playbook. Adapted from the prototype's dogfood SKILL: the
 * board/CLI mechanics (`tracker set …`, `$FEATURE_DIR`, record-demo.mjs) are
 * gone — this agent is a fresh session in the worktree whose only outputs are
 * the files it writes. The preview is already up at the base URL it's handed.
 */
export const DOGFOOD_GUIDE = `You are a verification agent. A builder finished this ticket; you never saw its
context — that is the point. Prove (or disprove) that the diff works by walking
user journeys against the running Preview Environment. You test the diff, never
the whole app, and you never review code — behavior only.

1. Scope. Compute the diff against the target branch and record the tip SHA.
   An empty diff → write a minimal report ("nothing to verify: empty diff") and
   finish; never test the target branch itself.
2. Analyze. Map every user-visible change — routes, components, endpoints, copy,
   config — and classify each browser-observable, http-observable, or not
   observable. Nothing observable → a minimal report ("no observable surface;
   the suite is the evidence") is honest and complete.
3. Flows then scenarios — never derive scenarios from pages. Source journeys
   from the acceptance criteria and description, then the diff for anything they
   missed. Carry every journey PAST its apparent endpoint (the far-end proof:
   "export works" means the downloaded file's rows match the filter, not that a
   button clicked). Include failure branches: validation errors, empty states,
   permission denials, and the side effects each action caused.
4. Walk each scenario against the preview. Functional judge — the instrument:
   for a browser journey drive it and assert the far-end proof; for http, curl
   it and assert status + body. A "pass" carrying a console error or a 5xx in
   the background is a FINDING, not a pass. Experiential judge — the persona: if
   one is supplied, re-read each walked scenario through that user's eyes and
   hunt paper cuts (confusing labels, surprise scrolling, copy that misfits how
   they think). Personas never override the instrument; no persona → skip this
   judge and say so.
5. Fix loop, under the governor (below), for every failed scenario and every
   sharp paper cut. Anything off the governor's green path is a Decision for a
   human, not a fix attempt.
6. Cap the matrix at 12 scenarios ranked by risk; if you cut any, list what and
   why — silent truncation is banned.`;

/** The fix-loop governor (ticket 11 §3), caps prompt-enforced. */
export const DOGFOOD_GOVERNOR = `Autonomous fix territory is deliberately narrow. Judge every fix against the
green path first; when in doubt, you are not on it.

The green path — ALL must hold:
- Clear bug, obvious correct fix. You can state the root cause in one sentence
  and you verified it (read the code, reproduced the failure).
- Few files touched. No schema, architecture, or dependency changes; no new
  packages, migrations, or restructuring.
- No product trade-off. Two reasonable fixes with different user-facing
  behavior is a Decision, not a fix.

On the green path, per fix, no exceptions:
1. One logical change per commit — never batch two fixes.
2. A regression test, red before and green after. Hollow tests (asserting
   nothing real, or passing against the broken code) are banned.
3. Re-run the fixed scenario AND its adjacent journeys — fixes love breaking
   neighbors.
4. Record the fix's commit SHA and test name in the scenario's matrix row.

Caps (hard): ${GOVERNOR_FIXES_PER_SCENARIO} fix attempts per scenario, then the
scenario stays failed — honestly. ${GOVERNOR_FIXES_PER_RUN} fix commits per run;
needing more means the ticket was not actually done, which is itself a finding.

Off the green path → do not attempt the fix. Add an entry to "Decisions for a
human": what happens (observed behavior + evidence), the options with their
costs, and your recommendation. A correctly parked scenario with a well-formed
question is a successful run, not a failure.`;

/** The five-section report structure (ticket 11 §2), followed heading-for-heading. */
export const DOGFOOD_REPORT_TEMPLATE = `# Dogfood report — <TICKET>: <title>

> Verdict: **READY | BLOCKED (human decision) | BLOCKED (needs human verify)**
> Frozen SHA: \`<sha>\` · Base: \`<target-branch>\` · Scenarios: N green / M total
> Fixes: K (each with SHA + regression test) · Paper cuts: S sharp / T total

## Matrix

| # | Journey (past the endpoint) | Kind | Functional | Experiential | Evidence | Fix |
|---|---|---|---|---|---|---|
| S1 | <journey, including the far-end proof> | browser | ✅ pass | — | <evidence> | — |

**Cut from the matrix** (cap is 12, ranked by risk): <what was cut and why — or "nothing">

## Paper cuts

- **sharp** — <where>: <what a user would stumble on> → fixed in \`<sha>\` / parked → Decisions
- **mild** — <where>: <friction worth knowing about, not blocking>

(No persona for this repo → experiential judge skipped — say so here if true.)

## Decisions for a human

<!-- Empty section = no open questions. Every entry follows the governor's shape. -->

## Instruments

- Suite: \`<command>\` → <result> at \`<final sha>\`
- Console/network harvest: <N console errors, M failed requests — or "clean">
- Preview: <base URL served / boot failure and what it blocked>
- Not covered: <anything unverifiable from the preview, and why>`;

/**
 * The results-file shape (ticket 11 §2): scenarios S<n> with flow_ref → AC ids,
 * kind, branch, status, fix, and the top-level cut log. Slice 37's artifact-lint
 * validates the emitted `dogfood-results.json` against this exact object.
 */
export const MATRIX_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Dogfood verification results",
  type: "object",
  required: ["ticket", "frozen_sha", "base", "scenarios"],
  properties: {
    ticket: { type: "string" },
    frozen_sha: { type: "string" },
    base: { type: "string" },
    cut: {
      description: "Scenarios cut by the 12-cap, with reasons — silent truncation is banned",
      type: "array",
      items: {
        type: "object",
        required: ["journey", "reason"],
        properties: { journey: { type: "string" }, reason: { type: "string" } },
      },
    },
    scenarios: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["id", "journey", "kind", "status"],
        properties: {
          id: { type: "string", pattern: "^S[0-9]+$" },
          journey: {
            type: "string",
            description: "The user journey, carried past its apparent endpoint (the email rule)",
          },
          flow_ref: {
            type: "string",
            description: "AC-id (or F-id) from the ticket this scenario derives from",
          },
          kind: { enum: ["browser", "http"] },
          branch: {
            enum: ["happy", "failure", "empty", "permission"],
            description: "Which branch of the journey this walks",
          },
          status: { enum: ["pending", "pass", "fail", "fixed", "parked", "waived"] },
          evidence: { type: "string", description: "Path to results JSON / transcript / screenshot" },
          fix: {
            type: "object",
            required: ["sha", "test"],
            properties: { sha: { type: "string" }, test: { type: "string" } },
          },
          paper_cuts: {
            type: "array",
            items: {
              type: "object",
              required: ["severity", "note"],
              properties: {
                severity: { enum: ["sharp", "mild"] },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
    decisions: {
      description:
        "Open questions for a human (ticket 37): observed behavior, options with costs, a recommendation. Never gate — the wizard surfaces each for the reviewer to answer, and the answer lands in the Audit Trail.",
      type: "array",
      items: {
        type: "object",
        required: ["id", "observed", "options", "recommendation"],
        properties: {
          id: { type: "string", pattern: "^D[0-9]+$" },
          observed: {
            type: "string",
            description: "What happens, with the evidence — the governor's first line",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "cost"],
              properties: { label: { type: "string" }, cost: { type: "string" } },
            },
          },
          recommendation: { type: "string" },
        },
      },
    },
  },
} as const;

/** The statuses the `dogfood-green` gate treats as green (ticket 37). */
export const DOGFOOD_GREEN_STATUSES = ["pass", "fixed", "waived"] as const;

/**
 * The scenario enums artifact-lint checks against — derived from MATRIX_SCHEMA
 * so the allowed values live in exactly one place (the schema is the authority).
 */
const SCENARIO_STATUSES: readonly string[] =
  MATRIX_SCHEMA.properties.scenarios.items.properties.status.enum;
const SCENARIO_KINDS: readonly string[] =
  MATRIX_SCHEMA.properties.scenarios.items.properties.kind.enum;

/**
 * artifact-lint's dogfood arm (ticket 37): the results file must be valid JSON,
 * carry the required top-level keys, and hold at least one well-formed scenario
 * (id like "S1", a known kind and status) within the 12-cap. The report itself
 * stays existence-only — its structure is enforced by the prompt template, not
 * re-parsed here. Returns the list of problems; empty = clean.
 */
export function lintDogfoodResults(raw: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return [`kb/dogfood-results.json is not valid JSON: ${messageOf(error)}`];
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return ["kb/dogfood-results.json must be a JSON object"];
  }
  const results = doc as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["ticket", "frozen_sha", "base"]) {
    if (typeof results[key] !== "string" || (results[key] as string) === "") {
      problems.push(`results missing required string "${key}"`);
    }
  }
  const scenarios = results.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    problems.push("results need at least one scenario");
    return problems;
  }
  if (scenarios.length > 12) {
    problems.push(`results carry ${scenarios.length} scenarios — the matrix cap is 12`);
  }
  scenarios.forEach((scenario, index) => {
    const where = `scenario ${index + 1}`;
    if (typeof scenario !== "object" || scenario === null) {
      problems.push(`${where} is not an object`);
      return;
    }
    const s = scenario as Record<string, unknown>;
    if (typeof s.id !== "string" || !/^S[0-9]+$/.test(s.id)) {
      problems.push(`${where} needs an id like "S1"`);
    }
    if (typeof s.journey !== "string" || s.journey === "") {
      problems.push(`${where} needs a journey`);
    }
    if (!SCENARIO_KINDS.includes(s.kind as string)) {
      problems.push(`${where} kind must be one of ${SCENARIO_KINDS.join(", ")}`);
    }
    if (!SCENARIO_STATUSES.includes(s.status as string)) {
      problems.push(`${where} status must be one of ${SCENARIO_STATUSES.join(", ")}`);
    }
  });
  return problems;
}

/** One scenario the `dogfood-green` gate found un-green, for the follow-up AC. */
export interface DogfoodScenarioOutcome {
  id: string;
  journey: string;
  status: string;
  flowRef: string | null;
}

export interface DogfoodGreenEvaluation {
  ok: boolean;
  failing: DogfoodScenarioOutcome[];
  total: number;
  /** Set when the file can't be read as scenarios at all — an honest fail. */
  error?: string;
}

/**
 * The `dogfood-green` gate's core (ticket 37): every scenario must have reached
 * pass, fixed, or waived. Anything else — pending, fail, parked — is a failing
 * row the bounce machinery turns into one follow-up AC. An unreadable or
 * empty-scenario file is a fail carrying its own reason (artifact-lint states
 * the structural detail; the gate need only refuse to green a file it can't read).
 */
export function evaluateDogfoodGreen(raw: string): DogfoodGreenEvaluation {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return { ok: false, failing: [], total: 0, error: `unreadable results file: ${messageOf(error)}` };
  }
  const scenarios = (doc as { scenarios?: unknown } | null)?.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return { ok: false, failing: [], total: 0, error: "results carry no scenarios to green" };
  }
  const green = DOGFOOD_GREEN_STATUSES as readonly string[];
  const failing = scenarios
    .map((scenario) => (typeof scenario === "object" && scenario !== null ? (scenario as Record<string, unknown>) : {}))
    .filter((scenario) => !green.includes(String(scenario.status)))
    .map((scenario) => ({
      id: typeof scenario.id === "string" ? scenario.id : "S?",
      journey: typeof scenario.journey === "string" ? scenario.journey : "",
      status: typeof scenario.status === "string" ? scenario.status : "unknown",
      flowRef: typeof scenario.flow_ref === "string" ? scenario.flow_ref : null,
    }));
  return { ok: failing.length === 0, failing, total: scenarios.length };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema as the agent sees it, pretty-printed into the prompt. */
export const MATRIX_SCHEMA_JSON = JSON.stringify(MATRIX_SCHEMA, null, 2);

/**
 * The experiential lens (ticket 11 §2, CONTEXT.md Persona): a per-Repo markdown
 * file read from the worktree. Absence is stated honestly and the judge skipped
 * — never faked. A configured-but-missing file is its own honest note, so a
 * lost persona can't silently pass as "no persona".
 */
export type PersonaResolution =
  | { applied: true; text: string }
  | { applied: false; note: string };

export function resolvePersona(
  repo: Pick<Repo, "personaPath">,
  worktreePath: string,
): PersonaResolution {
  if (repo.personaPath === null) {
    return {
      applied: false,
      note: "No persona configured for this repo — skip the experiential judge and say so in the report.",
    };
  }
  const file = path.join(worktreePath, repo.personaPath);
  if (!existsSync(file)) {
    return {
      applied: false,
      note: `Persona file ${repo.personaPath} is configured but missing from the worktree — state this honestly; do not fabricate an experiential judgment.`,
    };
  }
  return { applied: true, text: readFileSync(file, "utf8").trim() };
}

/**
 * How a preview boot ended, as the dogfood agent is told about it. A configured
 * preview that failed to boot does NOT strand the phase (ticket 36 AC5): the
 * agent still runs, told the base URL is unavailable and why, and writes an
 * honest report — the teeth belong to slice 37's gate, not the phase.
 */
export type PreviewHandoff =
  | { available: true; baseUrl: string }
  | { available: false; note: string };

/**
 * The dogfood-specific slice of the template variable set (ticket 36 AC1): the
 * live preview URL, the persona lens, and the vendored playbook assets. The
 * engine merges these with its fixed base variables before rendering the
 * dogfood node's prompt.
 */
export function dogfoodTemplateVars(
  preview: PreviewHandoff,
  persona: PersonaResolution,
): Record<string, string> {
  return {
    previewBaseUrl: preview.available
      ? preview.baseUrl
      : `unavailable — ${preview.note}`,
    persona: persona.applied ? persona.text : persona.note,
    dogfoodGuide: DOGFOOD_GUIDE,
    dogfoodGovernor: DOGFOOD_GOVERNOR,
    dogfoodReportTemplate: DOGFOOD_REPORT_TEMPLATE,
    matrixSchema: MATRIX_SCHEMA_JSON,
  };
}
