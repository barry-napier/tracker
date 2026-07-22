import { PHASE_GATE_PREFIX } from "../server/types.ts";
import type {
  AcceptanceCriterion,
  Artifact,
  GateStatus,
  ReviewStepKey,
  ReviewStepMark,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
} from "../server/types.ts";

/** Artifact names with dedicated wizard steps (ticket 11 formats). */
export const RECAP_NAME = "recap.html";
export const DOGFOOD_REPORT_NAME = "dogfood-report.md";
/** The machine-readable results file the Dogfood step reads decisions from. */
export const DOGFOOD_RESULTS_NAME = "dogfood-results.json";

/** One open "Decision for a human" (ticket 37), as the Dogfood step renders it. */
export interface DogfoodDecisionOption {
  label: string;
  cost: string;
}
export interface DogfoodDecision {
  id: string;
  observed: string;
  options: DogfoodDecisionOption[];
  recommendation: string;
}

/**
 * The decisions in a dogfood results file, defensively parsed: malformed or
 * absent decisions yield an empty list rather than throwing — a broken results
 * file never breaks the wizard, and the report markdown remains the reviewer's
 * fallback. Only entries carrying an id survive.
 */
export function parseDogfoodDecisions(text: string): DogfoodDecision[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const decisions = (doc as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(decisions)) return [];
  return decisions.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string") return [];
    const options = Array.isArray(rec.options)
      ? rec.options.flatMap((option) => {
          const opt = option as Record<string, unknown>;
          return typeof opt?.label === "string"
            ? [{ label: opt.label, cost: typeof opt.cost === "string" ? opt.cost : "" }]
            : [];
        })
      : [];
    return [
      {
        id: rec.id,
        observed: typeof rec.observed === "string" ? rec.observed : "",
        options,
        recommendation: typeof rec.recommendation === "string" ? rec.recommendation : "",
      },
    ];
  });
}

/** The review agent's digest artifact (TRK-3). */
export const REVIEW_DIGEST_NAME = "review-digest.json";

export interface DigestWalkthroughEntry {
  file: string;
  note: string;
}
export interface DigestRisk {
  note: string;
  severity: "low" | "medium" | "high" | null;
}
export interface DigestAcEntry {
  acId: number;
  note: string;
  files: string[];
}
export interface ReviewDigestContent {
  walkthrough: DigestWalkthroughEntry[];
  risks: DigestRisk[];
  acMap: DigestAcEntry[];
}

/**
 * The digest, defensively parsed like the dogfood decisions: the server
 * linted the file before persisting, but a malformed entry still yields
 * empty sections rather than a broken wizard — raw evidence remains the
 * reviewer's fallback.
 */
export function parseReviewDigest(text: string): ReviewDigestContent {
  const empty: ReviewDigestContent = { walkthrough: [], risks: [], acMap: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof doc !== "object" || doc === null) return empty;
  const digest = doc as Record<string, unknown>;
  const walkthrough = Array.isArray(digest.walkthrough)
    ? digest.walkthrough.flatMap((entry) => {
        const item = entry as Record<string, unknown>;
        return typeof item?.file === "string" && typeof item?.note === "string"
          ? [{ file: item.file, note: item.note }]
          : [];
      })
    : [];
  const risks = Array.isArray(digest.risks)
    ? digest.risks.flatMap((entry) => {
        const item = entry as Record<string, unknown>;
        if (typeof item?.note !== "string") return [];
        const raw = item.severity;
        const severity: DigestRisk["severity"] =
          raw === "low" || raw === "medium" || raw === "high" ? raw : null;
        return [{ note: item.note, severity }];
      })
    : [];
  const acMap = Array.isArray(digest.acMap)
    ? digest.acMap.flatMap((entry) => {
        const item = entry as Record<string, unknown>;
        if (typeof item?.acId !== "number" || typeof item?.note !== "string") return [];
        const files = Array.isArray(item.files)
          ? item.files.filter((file): file is string => typeof file === "string")
          : [];
        return [{ acId: item.acId, note: item.note, files }];
      })
    : [];
  return { walkthrough, risks, acMap };
}

/** The digest's entry for one criterion — the walkthrough item's pre-fill. */
export function digestForAc(
  digest: ReviewDigestContent | null,
  acId: number,
): DigestAcEntry | null {
  return digest?.acMap.find((entry) => entry.acId === acId) ?? null;
}

/** The wizard's step vocabulary is the server's — verdicts validate against it. */
export type WizardStepKey = ReviewStepKey;

/** The six steps, in prototype Variant A order (ticket 12). */
export const WIZARD_STEPS: ReadonlyArray<{ key: WizardStepKey; label: string }> = [
  { key: "recap", label: "Visual Recap" },
  { key: "dogfood", label: "Dogfood Report" },
  { key: "pr", label: "Pull Request" },
  { key: "docs", label: "Documentation & Artifacts" },
  { key: "walkthrough", label: "Manual Walkthrough" },
  { key: "verdict", label: "Final Verdict" },
];

export function findArtifact(run: RunWithPhases | null, name: string): Artifact | null {
  return run?.artifacts.find((artifact) => artifact.name === name) ?? null;
}

/** The Documentation & Artifacts step: everything except the dogfood report
 * and the demo — each has its own presentation elsewhere in the wizard. */
export function docsArtifacts(run: RunWithPhases | null): Artifact[] {
  return (
    run?.artifacts.filter(
      (artifact) => artifact.name !== DOGFOOD_REPORT_NAME && artifact.kind !== "demo",
    ) ?? []
  );
}

/**
 * The api-kind walkthrough's transcript (ticket 10): for `api` repos the
 * demo artifact IS the curl transcript, so the walkthrough presents it
 * beside the base URL.
 */
export function demoTranscriptArtifact(run: RunWithPhases | null): Artifact | null {
  return (
    run?.artifacts.find(
      (artifact) => artifact.kind === "demo" && !artifact.name.endsWith(".webm"),
    ) ?? null
  );
}

/** The ui-kind walkthrough's demo video (ticket 35), by kind and extension. */
export function demoVideoArtifact(run: RunWithPhases | null): Artifact | null {
  return (
    run?.artifacts.find(
      (artifact) => artifact.kind === "demo" && artifact.name.endsWith(".webm"),
    ) ?? null
  );
}

/**
 * Absent evidence never renders a blank panel (ticket 32): a park-by-cap
 * arrival says exactly why it is missing; ordinary absence stays plain.
 */
export function absenceLabel(
  ticket: Pick<Ticket, "arrivedByCap">,
  missing: string,
  normal: string,
): string {
  return ticket.arrivedByCap ? `${missing} — arrived via bounce cap` : normal;
}

export function missingArtifactLabel(ticket: Ticket, name: string): string {
  return absenceLabel(ticket, `${name} missing`, `${name} was not produced by this run`);
}

export interface GateBadge {
  gate: string;
  status: GateStatus;
  /** Roll-up counts for the aggregated ac-checks badge; empty for named gates. */
  summary: string;
}

/**
 * The chrome's verification badge row, drawn from recorded gate results —
 * never from agent-authored content. Named gates keep battery order; the
 * per-AC checks roll up into one badge whose status is honest: any fail
 * fails it, and all-skip stays skip rather than masquerading as green.
 */
export function badgeRow(run: RunWithPhases | null): GateBadge[] {
  if (!run) return [];
  const badges: GateBadge[] = [];
  const indexByGate = new Map<string, number>();
  const acCounts: Record<GateStatus, number> = { pass: 0, fail: 0, skip: 0 };
  let acSeen = false;
  for (const result of run.gateResults) {
    // In-phase gate rows (TRK-1) are the engine's retry history, not the
    // battery's verdict — the badge row stays Verifying-scoped.
    if (result.gate.startsWith(PHASE_GATE_PREFIX)) continue;
    if (result.gate === "ac-check") {
      acSeen = true;
      acCounts[result.status] += 1;
      continue;
    }
    const badge = { gate: result.gate, status: result.status, summary: "" };
    const index = indexByGate.get(result.gate);
    if (index === undefined) {
      indexByGate.set(result.gate, badges.length);
      badges.push(badge);
    } else {
      badges[index] = badge;
    }
  }
  if (acSeen) {
    const status: GateStatus = acCounts.fail > 0 ? "fail" : acCounts.pass > 0 ? "pass" : "skip";
    const summary = (["pass", "fail", "skip"] as const)
      .filter((key) => acCounts[key] > 0)
      .map((key) => `${acCounts[key]} ${key}`)
      .join(" · ");
    badges.push({ gate: "ac-checks", status, summary });
  }
  return badges;
}

/** One wizard step's mark as the reviewer works (ticket 33), note included. */
export interface StepMark {
  status: GateStatus;
  note: string;
}

/** The reviewer's marks so far, keyed by step; unmarked steps are absent. */
export type ReviewMarks = Partial<Record<WizardStepKey, StepMark>>;

/** The steps a reviewer marks — every step except the verdict itself. */
export const MARKABLE_STEPS = WIZARD_STEPS.filter(({ key }) => key !== "verdict");

/** The fail verdict's payload: every mark as made, notes riding the fails. */
export function verdictSteps(marks: ReviewMarks): ReviewStepMark[] {
  return MARKABLE_STEPS.flatMap(({ key }) => {
    const mark = marks[key];
    if (!mark) return [];
    return [
      mark.status === "fail"
        ? { step: key, status: mark.status, note: mark.note }
        : { step: key, status: mark.status },
    ];
  });
}

/**
 * Why "Fail review" is not yet possible; empty = enabled. Fail without a
 * note is impossible — the note becomes a Follow-up Criterion verbatim. A
 * walkthrough that failed ACs is grounds enough on its own: failing any AC
 * bounces the Ticket, no step mark needed.
 */
export function failVerdictProblems(marks: ReviewMarks, ticket: TicketWithAcs): string[] {
  const failed = MARKABLE_STEPS.filter(({ key }) => marks[key]?.status === "fail");
  if (failed.length === 0) {
    return ticket.acceptanceCriteria.some((ac) => ac.status === "failed")
      ? []
      : ["no step is marked as failed and no acceptance criterion is failed"];
  }
  return failed
    .filter(({ key }) => marks[key]!.note.trim() === "")
    .map(({ label }) => `"${label}" is failed without a note`);
}

/** ACs Done cannot swallow: neither verified nor waived — visible before merge. */
export function unmetAcs(ticket: TicketWithAcs): AcceptanceCriterion[] {
  return ticket.acceptanceCriteria.filter(
    (ac) => ac.status !== "verified" && ac.status !== "waived",
  );
}

/** Why "Merge & Done" is not yet possible; empty = enabled. */
export function mergeProblems(ticket: TicketWithAcs, marks: ReviewMarks): string[] {
  const problems = unmetAcs(ticket).map((ac) => `AC-${ac.id} is ${ac.status}`);
  for (const { key, label } of MARKABLE_STEPS) {
    if (marks[key]?.status === "fail") problems.push(`step "${label}" is marked as failed`);
  }
  return problems;
}

export interface WalkthroughItem {
  criterion: AcceptanceCriterion;
  /** The plan manifest's reason when this AC is routed to a human. */
  humanReason: string | null;
}

/** The Manual Walkthrough checklist is the AC list, human routings surfaced. */
export function walkthroughItems(ticket: TicketWithAcs): WalkthroughItem[] {
  return ticket.acceptanceCriteria.map((criterion) => ({
    criterion,
    humanReason: criterion.check?.kind === "human" ? criterion.check.reason : null,
  }));
}
