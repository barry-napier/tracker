import type {
  AcceptanceCriterion,
  Artifact,
  GateStatus,
  RunWithPhases,
  Ticket,
  TicketWithAcs,
} from "../server/types.ts";

/** Artifact names with dedicated wizard steps (ticket 11 formats). */
export const RECAP_NAME = "recap.html";
export const DOGFOOD_REPORT_NAME = "dogfood-report.md";

export type WizardStepKey = "recap" | "dogfood" | "pr" | "docs" | "walkthrough" | "verdict";

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

/** The Documentation & Artifacts step: everything except the dogfood report — it has its own step. */
export function docsArtifacts(run: RunWithPhases | null): Artifact[] {
  return run?.artifacts.filter((artifact) => artifact.name !== DOGFOOD_REPORT_NAME) ?? [];
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
