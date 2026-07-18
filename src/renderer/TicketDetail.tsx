import { useEffect } from "react";
import type {
  AcceptanceCriterion,
  AuditEvent,
  Repo,
  Run,
  TicketWithAcs,
} from "../server/types.ts";
import { PROVIDER_LABELS, repoName } from "./format.ts";
import { STATE_LABELS } from "./ticketStates.ts";

const ORIGIN_LABELS: Record<AcceptanceCriterion["origin"], string | null> = {
  original: null,
  "gate-fail": "follow-up · gate",
  "review-fail": "follow-up · review",
};

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
  runs: Run[];
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
              <span>{criterion.text}</span>
              <em className="dim">
                {criterion.status}
                {ORIGIN_LABELS[criterion.origin] && ` · ${ORIGIN_LABELS[criterion.origin]}`}
              </em>
            </li>
          ))}
        </ul>

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
