// PROTOTYPE — throwaway (wayfinder ticket 12). Shared atoms + wizard step CONTENT.
// Step content shape is already decided (tickets 10/11); variants differ in the
// chrome around it — layout, hierarchy, navigation — never in step content.
import React, { useMemo, useState } from "react";
import type { AcRow, TicketSnapshot } from "./events";
import {
  AuditEvent,
  PROVIDER_LABELS,
  PROVIDERS,
  RunFixture,
  acRows,
  auditEvents,
  bounceReportMarkdown,
  dogfoodMarkdown,
  recapHtml,
  runs,
  tickets as ticketsFixture,
} from "./fixtures";
import type { OpenBlock } from "./fakeStream";

export const stateColor: Record<string, string> = {
  backlog: "#8b93a7",
  todo: "#60a5fa",
  in_progress: "#c084fc",
  verifying: "#eab308",
  human_review: "#fb923c",
  done: "#4ade80",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className="badge" style={{ color: stateColor[state], borderColor: stateColor[state] }}>
      {state.replace("_", " ")}
    </span>
  );
}

export function GateChip({ gate, result }: { gate: string; result: "pass" | "fail" | "skip" }) {
  const c = result === "pass" ? "#4ade80" : result === "fail" ? "#f87171" : "#8b93a7";
  return (
    <span className="badge" style={{ color: c, borderColor: c }} title={result}>
      {result === "pass" ? "✓" : result === "fail" ? "✗" : "–"} {gate}
    </span>
  );
}

export function AcStatusDot({ status }: { status: AcRow["status"] }) {
  const c = { pending: "#8b93a7", verified: "#4ade80", failed: "#f87171", waived: "#eab308" }[status];
  return <span className="acdot" style={{ background: c }} title={status} />;
}

export function AcList({ ticketId, checklist, onSet }: {
  ticketId: string;
  checklist?: boolean;
  onSet?: (id: string, status: AcRow["status"]) => void;
}) {
  const rows = acRows.filter((a) => a.ticketId === ticketId);
  if (!rows.length) return <p className="dim">No acceptance criteria.</p>;
  return (
    <ul className="aclist">
      {rows.map((a) => (
        <li key={a.id}>
          <AcStatusDot status={a.status} />
          <span>
            {a.text}
            {a.followUpOf && <em className="dim"> · follow-up</em>}
            {a.provenance && <em className="dim"> · {a.provenance}-verified</em>}
          </span>
          {checklist && a.status === "pending" && (
            <span className="acactions">
              <button onClick={() => onSet?.(a.id, "verified")}>verify</button>
              <button onClick={() => onSet?.(a.id, "failed")}>fail</button>
              <button onClick={() => onSet?.(a.id, "waived")}>waive</button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProviderPicker({ value, onChange }: { value: string | null; onChange?: (p: string) => void }) {
  return (
    <select className="providerpick" value={value ?? ""} onChange={(e) => onChange?.(e.target.value)}>
      <option value="" disabled>pick provider…</option>
      {PROVIDERS.map((p) => (
        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
      ))}
    </select>
  );
}

export function LogBlockView({ b }: { b: OpenBlock }) {
  const k = b.block.kind;
  const label = { prompt: "PROMPT", thinking: "THINKING", text: "AGENT", tool_call: "TOOL →", tool_result: "← RESULT" }[k];
  const body =
    k === "tool_call" ? `${b.block.tool}(${b.block.input})`
    : k === "tool_result" ? `${b.block.tool}: ${b.block.output}`
    : b.block.text;
  return (
    <div className={`logblock lb-${k} ${"isError" in b.block && b.block.isError ? "lb-err" : ""}`}>
      <span className="lb-label">{label}</span>
      <span className="lb-body">{body}{b.open && <span className="cursor">▋</span>}</span>
    </div>
  );
}

export function AuditFeed({ ticketId }: { ticketId: string }) {
  const evs = auditEvents.filter((e) => e.ticketId === ticketId);
  if (!evs.length) return <p className="dim">No activity yet.</p>;
  return (
    <ul className="audit">
      {evs.map((e) => (
        <li key={e.seq}>
          <span className="dim">{e.at.slice(5, 16).replace("T", " ")}</span>
          <b>{e.eventType}</b>
          <span>{e.detail}</span>
          <em className="dim">{e.actor}</em>
        </li>
      ))}
    </ul>
  );
}

// Naive markdown-ish renderer — prototype only, never ship.
export function Markdownish({ text }: { text: string }) {
  const html = useMemo(() => {
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h2>$1</h2>")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/^\|(.+)\|$/gm, (row) => `<div class="mdrow">${row.replace(/\|/g, "<span class='mdcell'></span>")}</div>`)
      .replace(/^- (.*)$/gm, "<li>$1</li>")
      .replace(/\n\n/g, "<br/><br/>");
  }, [text]);
  return <div className="mdish" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- Review wizard state + step content ----------

export const WIZARD_STEPS = [
  "Visual Recap",
  "Dogfood Report",
  "Pull Request",
  "Documentation & Artifacts",
  "Manual Walkthrough",
  "Final Verdict",
] as const;

export type StepOutcome = "pass" | "fail" | "skip" | null;

export interface WizardState {
  step: number;
  outcomes: StepOutcome[];
  notes: string[];
  setStep: (i: number) => void;
  decide: (i: number, o: StepOutcome) => void;
  setNote: (i: number, note: string) => void;
  canAdvance: (i: number) => boolean;
}

export function useWizard(): WizardState {
  const [step, setStep] = useState(0);
  const [outcomes, setOutcomes] = useState<StepOutcome[]>(Array(6).fill(null));
  const [notes, setNotes] = useState<string[]>(Array(6).fill(""));
  return {
    step,
    outcomes,
    notes,
    setStep,
    decide: (i, o) => setOutcomes((prev) => prev.map((x, j) => (j === i ? o : x))),
    setNote: (i, n) => setNotes((prev) => prev.map((x, j) => (j === i ? n : x))),
    // fail requires a written reviewer note (workflow engine decision, ticket 07)
    canAdvance: (i) => outcomes[i] !== null && (outcomes[i] !== "fail" || notes[i].trim().length > 0),
  };
}

export function StepDecision({ w, i }: { w: WizardState; i: number }) {
  const o = w.outcomes[i];
  return (
    <div className="stepdecision">
      <div className="pfs">
        {(["pass", "fail", "skip"] as const).map((k) => (
          <button key={k} className={`pfs-${k} ${o === k ? "on" : ""}`} onClick={() => w.decide(i, k)}>
            {k}
          </button>
        ))}
      </div>
      {o === "fail" && (
        <textarea
          className="failnote"
          placeholder="Reviewer note (required) — lands verbatim in the follow-up AC and the Bounce Report"
          value={w.notes[i]}
          onChange={(e) => w.setNote(i, e.target.value)}
        />
      )}
    </div>
  );
}

export function WizardMeta({ ticket, run }: { ticket: TicketSnapshot; run: RunFixture }) {
  return (
    <div className="wizmeta">
      <b>{ticket.id}</b> {ticket.title} · {PROVIDER_LABELS[run.provider]} · run {run.id} · branch feat/{ticket.id.toLowerCase()} @ {run.artifacts[0]?.sha ?? "—"}
      <div className="wizbadges">
        {run.gateResults.map((g) => <GateChip key={g.gate} gate={g.gate} result={g.result} />)}
      </div>
    </div>
  );
}

export function StepBody({ i, ticket, run, onAcSet }: {
  i: number;
  ticket: TicketSnapshot;
  run: RunFixture;
  onAcSet?: (id: string, s: AcRow["status"]) => void;
}) {
  switch (i) {
    case 0:
      return (
        <iframe className="recapframe" sandbox="allow-scripts" srcDoc={recapHtml} title="Visual Recap" />
      );
    case 1:
      return (
        <div>
          <Markdownish text={dogfoodMarkdown} />
          <div className="decisionbox">
            <b>Decisions for a human</b>
            <p>Should note history rows be visible to adjusters, or admin-only?</p>
            <input placeholder="Answer feeds the audit trail…" />
          </div>
        </div>
      );
    case 2:
      return (
        <div>
          <p><a href={run.prUrl ?? "#"} target="_blank" rel="noreferrer">PR #{run.prNumber} ↗</a> — feat/{ticket.id.toLowerCase()} → main · mergeable · pr-fresh ✓</p>
          <p className="dim">Diff summary: 3 files, +181 −15. Open on GitHub for line comments.</p>
        </div>
      );
    case 3:
      return (
        <ul className="artifacts">
          {run.artifacts.filter((a) => a.name !== "dogfood-report.md").map((a) => (
            <li key={a.name}><b>{a.name}</b> <span className="dim">{a.kind} · @{a.sha}</span></li>
          ))}
        </ul>
      );
    case 4:
      return (
        <div>
          <div className="previewbar">
            <span className="badge" style={{ color: "#4ade80", borderColor: "#4ade80" }}>preview: ready</span>
            <a href="#" onClick={(e) => e.preventDefault()}>localhost:4231 ↗ (system browser)</a>
            <button>restart</button>
          </div>
          <p className="dim">Demo video: demo.webm · 1:42</p>
          <h4>Walk the acceptance criteria</h4>
          <AcList ticketId={ticket.id} checklist onSet={onAcSet} />
        </div>
      );
    case 5:
      return null; // verdict body is chrome-specific (summarizes the other steps)
    default:
      return null;
  }
}

export function VerdictSummary({ w }: { w: WizardState }) {
  const fails = w.outcomes.filter((o) => o === "fail").length;
  return (
    <div>
      <ul className="verdictlist">
        {WIZARD_STEPS.slice(0, 5).map((s, i) => (
          <li key={s}>
            <span className={`vd vd-${w.outcomes[i] ?? "todo"}`}>{w.outcomes[i] ?? "—"}</span> {s}
            {w.outcomes[i] === "fail" && <em className="dim"> — {w.notes[i] || "(note required)"}</em>}
          </li>
        ))}
      </ul>
      <p className="dim">Freshness re-check at verdict: pr-fresh ✓ · mergeable ✓</p>
      <div className="verdictactions">
        <button className="merge" disabled={fails > 0}>Merge PR & move to Done</button>
        <button className="bounce" disabled={fails === 0}>Bounce with {fails} follow-up {fails === 1 ? "criterion" : "criteria"}</button>
      </div>
    </div>
  );
}

export function ticketRun(t: TicketSnapshot): RunFixture | undefined {
  return runs.find((r) => r.id === t.currentRunId);
}

// Local mutable ticket list so create/promote are exercisable. In-memory only.
export function useTickets() {
  const [list, setList] = useState<TicketSnapshot[]>(() => [...ticketsFixture]);
  const create = (title: string) => {
    if (!title.trim()) return;
    setList((l) => [
      { id: `TRK-${33 + l.length}`, projectId: "p1", repoId: null, title: title.trim(), state: "backlog", provider: null, currentRunId: null },
      ...l,
    ]);
  };
  const promote = (id: string, provider: string) =>
    setList((l) => l.map((t) => (t.id === id ? { ...t, state: "todo", provider: provider as TicketSnapshot["provider"], repoId: "r1" } : t)));
  return { list, create, promote };
}

export { bounceReportMarkdown };
