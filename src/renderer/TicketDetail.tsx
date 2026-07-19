import { useEffect } from "react";
import type {
  AcceptanceCriterion,
  AuditEvent,
  GateResult,
  PhaseExecution,
  Repo,
  RunWithPhases,
  TicketWithAcs,
} from "../server/types.ts";
import { AgentLog } from "./AgentLog.tsx";
import { waiveWithPrompt } from "./acActions.ts";
import { GATE_MARKS, PROVIDER_LABELS, repoName } from "./format.ts";
import { STATE_LABELS } from "./ticketStates.ts";

const ORIGIN_LABELS: Record<AcceptanceCriterion["origin"], string | null> = {
  original: null,
  "gate-fail": "follow-up · gate",
  "review-fail": "follow-up · review",
};

const PHASE_MARKS: Record<PhaseExecution["state"], string> = {
  running: "…",
  completed: "✓",
  failed: "✗",
  crashed: "✗",
};

function gateSummary(result: GateResult): string {
  const detail = result.detail;
  if (typeof detail.reason === "string") return detail.reason;
  if (Array.isArray(detail.problems)) return detail.problems.join("; ");
  if (typeof detail.exitCode === "number") return `exit ${detail.exitCode}`;
  if (Array.isArray(detail.missing) && detail.missing.length > 0) {
    return `missing ${detail.missing.join(", ")}`;
  }
  return "";
}

/** Ticket detail as a right slide-over over the board (ticket 12, Variant A). */
export function TicketDetail({
  ticket,
  repos,
  audit,
  runs,
  loadAudit,
  loadRuns,
  onClose,
}: {
  ticket: TicketWithAcs;
  repos: Repo[];
  audit: AuditEvent[];
  runs: RunWithPhases[];
  loadAudit: (ticketId: number) => void;
  loadRuns: (ticketId: number) => void;
  onClose: () => void;
}) {
  const repo = repos.find((r) => r.id === ticket.repoId);
  const latestRun = runs[0];
  useEffect(() => {
    loadAudit(ticket.id);
    loadRuns(ticket.id);
  }, [ticket.id, loadAudit, loadRuns]);

  return (
    <>
      <div className="veil" onClick={onClose} />
      <aside className="drawer">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h2>
          <span className="dim">{ticket.displayKey}</span> {ticket.title}
        </h2>
        <span className={`badge badge-${ticket.state}`}>{STATE_LABELS[ticket.state]}</span>

        <h4>Properties</h4>
        <div className="props dim">
          <span>Repo: {repo ? repoName(repo) : "—"}</span>
          <span>Provider: {ticket.provider ? PROVIDER_LABELS[ticket.provider] : "—"}</span>
          <span>Branch: {ticket.branch ?? "—"}</span>
          {ticket.externalRef && <span>External ref: {ticket.externalRef}</span>}
        </div>

        <h4>Run</h4>
        {!latestRun && <p className="dim">Not claimed yet.</p>}
        {latestRun && (
          <div className="props dim">
            <span>
              Run #{latestRun.id} · {latestRun.state}
              {runs.length > 1 && ` · ${runs.length} attempts`}
            </span>
            <span>Worktree: {latestRun.worktreePath ?? "setting up…"}</span>
            {latestRun.phases.length > 0 && (
              <span className="phases">
                {latestRun.phases.map((phase) => (
                  <span key={phase.id} className={`phase phase-${phase.state}`} title={phase.state}>
                    {PHASE_MARKS[phase.state]} {phase.phase}
                  </span>
                ))}
              </span>
            )}
            {latestRun.crashReason && <span className="error">{latestRun.crashReason}</span>}
          </div>
        )}

        <h4>Description</h4>
        {ticket.description ? (
          <p className="description">{ticket.description}</p>
        ) : (
          <p className="dim">No description.</p>
        )}

        <h4>Acceptance criteria</h4>
        {ticket.acceptanceCriteria.length === 0 && <p className="dim">None filed.</p>}
        <ul className="aclist">
          {ticket.acceptanceCriteria.map((criterion) => (
            <li key={criterion.id}>
              <span className={`dot dot-${criterion.status}`} title={criterion.status} />
              <span>
                {criterion.text}
                {criterion.status !== "waived" && (
                  <button
                    className="waivebtn"
                    title="Waive this criterion (requires a reason)"
                    onClick={() => waiveWithPrompt(criterion)}
                  >
                    waive
                  </button>
                )}
              </span>
              <em className="dim">
                {criterion.status}
                {criterion.provenance && ` · ${criterion.provenance}`}
                {criterion.waiveReason && ` · ${criterion.waiveReason}`}
                {ORIGIN_LABELS[criterion.origin] && ` · ${ORIGIN_LABELS[criterion.origin]}`}
                {criterion.check?.kind === "script" && ` · ${criterion.check.scriptPath}`}
                {criterion.check?.kind === "human" && ` · manual walkthrough: ${criterion.check.reason}`}
              </em>
            </li>
          ))}
        </ul>

        <h4>Gates</h4>
        {(!latestRun || latestRun.gateResults.length === 0) && (
          <p className="dim">No gate results yet — the battery runs at Verifying.</p>
        )}
        {latestRun && latestRun.gateResults.length > 0 && (
          <ul className="gatelist">
            {latestRun.gateResults.map((result) => (
              <li key={result.id}>
                <span className={`gatemark gate-${result.status}`} title={result.status}>
                  {GATE_MARKS[result.status]}
                </span>
                <span>
                  {result.gate}
                  {result.acId !== null && ` · AC-${result.acId}`}
                </span>
                <em className="dim">{gateSummary(result)}</em>
              </li>
            ))}
          </ul>
        )}

        <h4>Artifacts</h4>
        {(!latestRun || latestRun.artifacts.length === 0) && (
          <p className="dim">Nothing persisted yet.</p>
        )}
        {latestRun && latestRun.artifacts.length > 0 && (
          <ul className="artifacts">
            {latestRun.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className="artifactkind dim">{artifact.kind}</span>
                <span>{artifact.name}</span>
                <span className="dim" title={`worktree HEAD ${artifact.worktreeHeadSha}`}>
                  {artifact.contentHash.slice(0, 7)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h4>Agent log</h4>
        {!latestRun && <p className="dim">No run yet — promote the ticket to start one.</p>}
        {latestRun && <AgentLog runId={latestRun.id} />}

        <h4>Activity</h4>
        {audit.length === 0 && <p className="dim">No activity yet.</p>}
        <ul className="feed">
          {audit.map((event) => (
            <li key={event.id}>
              <span className="feedtype">{event.type}</span>
              <span className="dim">
                {event.actor} · {new Date(event.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
