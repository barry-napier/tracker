import { useEffect, type ReactNode } from "react";
import type {
  AcceptanceCriterion,
  AcStatus,
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
import { Icon } from "./icons.tsx";
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

/** Right-aligned status letter, file-tree style ("A" in a git changes list). */
const AC_BADGES: Record<AcStatus, { letter: string; tone: string }> = {
  pending: { letter: "P", tone: "faint" },
  verified: { letter: "V", tone: "ok" },
  failed: { letter: "F", tone: "danger" },
  waived: { letter: "W", tone: "warn" },
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

/** Titled block on the full-page detail — always open (the drawer's collapse
    chevrons were compensation for cramped 440px; the page has room). */
function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count?: string | number;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="panel-count dim">{count}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Ticket detail as a full page in place of the board (breadcrumb back to it). */
export function TicketDetail({
  ticket,
  projectName,
  repos,
  audit,
  runs,
  loadAudit,
  loadRuns,
  onClose,
}: {
  ticket: TicketWithAcs;
  projectName: string;
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

  // Esc returns to the board, matching the back button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const gateResults = latestRun?.gateResults ?? [];
  const artifacts = latestRun?.artifacts ?? [];

  const settled = ticket.acceptanceCriteria.filter(
    (c) => c.status === "verified" || c.status === "waived",
  ).length;

  return (
    <div className="detail-page">
      <header className="detail-head">
        <button type="button" className="crumb-back" onClick={onClose}>
          <Icon name="chevron-left" size={14} />
          Board
        </button>
        <span className="crumb-sep dim">/</span>
        <span className="crumb dim">{projectName}</span>
        <span className="crumb-sep dim">/</span>
        <span className="crumb">{ticket.displayKey}</span>
        <span className={`badge badge-${ticket.state}`}>{STATE_LABELS[ticket.state]}</span>
      </header>

      <div className="detail-body">
        <div className="detail-main">
          <h1 className="detail-title">{ticket.title}</h1>

          <Panel title="Description">
            {ticket.description ? (
              <p className="description">{ticket.description}</p>
            ) : (
              <p className="dim">No description.</p>
            )}
          </Panel>

          <Panel
            title="Acceptance criteria"
            count={`${settled}/${ticket.acceptanceCriteria.length}`}
          >
            {ticket.acceptanceCriteria.length === 0 && <p className="dim">None filed.</p>}
            <ul className="tlist">
              {ticket.acceptanceCriteria.map((criterion) => {
                const meta = [
                  criterion.provenance,
                  criterion.waiveReason,
                  ORIGIN_LABELS[criterion.origin],
                  criterion.check?.kind === "script" ? criterion.check.scriptPath : null,
                  criterion.check?.kind === "human"
                    ? `manual walkthrough: ${criterion.check.reason}`
                    : null,
                ].filter(Boolean);
                return (
                  <li className="trow" key={criterion.id}>
                    <span className={`dot dot-${criterion.status}`} title={criterion.status} />
                    <span className="rowmain">
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
                      {meta.length > 0 && <em className="rowmeta dim">{meta.join(" · ")}</em>}
                    </span>
                    <span
                      className={`rowbadge ${AC_BADGES[criterion.status].tone}`}
                      title={criterion.status}
                    >
                      {AC_BADGES[criterion.status].letter}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Gates" count={latestRun ? gateResults.length : undefined}>
            {(!latestRun || gateResults.length === 0) && (
              <p className="dim">No gate results yet — the battery runs at Verifying.</p>
            )}
            <ul className="tlist">
              {gateResults.map((result) => {
                const summary = gateSummary(result);
                return (
                  <li className="trow" key={result.id}>
                    <span className={`gatemark gate-${result.status}`} title={result.status}>
                      {GATE_MARKS[result.status]}
                    </span>
                    <span className="rowmain">
                      <span>
                        {result.gate}
                        {result.acId !== null && ` · AC-${result.acId}`}
                      </span>
                      {summary !== "" && <em className="rowmeta dim">{summary}</em>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Artifacts" count={latestRun ? artifacts.length : undefined}>
            {(!latestRun || artifacts.length === 0) && (
              <p className="dim">Nothing persisted yet.</p>
            )}
            <ul className="tlist">
              {artifacts.map((artifact) => (
                <li className="trow" key={artifact.id}>
                  <span className="artifactkind dim">{artifact.kind}</span>
                  <span className="rowmain">{artifact.name}</span>
                  <span className="rowhash dim" title={`worktree HEAD ${artifact.worktreeHeadSha}`}>
                    {artifact.contentHash.slice(0, 7)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <aside className="detail-rail">
          <Panel title="Properties">
            <div className="props dim">
              <span>Repo: {repo ? repoName(repo) : "—"}</span>
              <span>Provider: {ticket.provider ? PROVIDER_LABELS[ticket.provider] : "—"}</span>
              <span>Branch: {ticket.branch ?? "—"}</span>
              {ticket.externalRef && <span>External ref: {ticket.externalRef}</span>}
            </div>
          </Panel>

          <Panel title="Run">
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
                      <span
                        key={phase.id}
                        className={`phase phase-${phase.state}`}
                        title={phase.state}
                      >
                        {PHASE_MARKS[phase.state]} {phase.phase}
                      </span>
                    ))}
                  </span>
                )}
                {latestRun.crashReason && <span className="error">{latestRun.crashReason}</span>}
              </div>
            )}
          </Panel>

          <Panel title="Activity" count={audit.length}>
            {audit.length === 0 && <p className="dim">No activity yet.</p>}
            <ul className="tlist">
              {audit.map((event) => (
                <li className="trow" key={event.id}>
                  <span className="feedtype">{event.type}</span>
                  <span className="rowend dim">
                    {event.actor} · {new Date(event.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>

      <section className="conversation">
        <div className="panel-head">
          <h3>Agent log</h3>
          {latestRun && <span className="panel-count dim">run #{latestRun.id}</span>}
        </div>
        {!latestRun ? (
          <p className="dim conversation-empty">
            No run yet — promote the ticket to start one. The conversation appears live
            once the run begins.
          </p>
        ) : (
          <AgentLog runId={latestRun.id} />
        )}
      </section>
    </div>
  );
}
