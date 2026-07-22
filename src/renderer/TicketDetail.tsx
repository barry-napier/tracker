import { useEffect, useState, type ReactNode } from "react";
import type {
  AcceptanceCriterion,
  AcStatus,
  AuditEvent,
  GateResult,
  Repo,
  RunWithPhases,
  TicketWithAcs,
} from "../server/types.ts";
import { apiBase, apiPatch, apiPost, errorMessage } from "./api.ts";
import { waiveWithPrompt } from "./acActions.ts";
import { GATE_MARKS, PROVIDER_LABELS, repoName, timeAgo } from "./format.ts";
import { Icon } from "./icons.tsx";
import { STATE_LABELS } from "./ticketStates.ts";

const ORIGIN_LABELS: Record<AcceptanceCriterion["origin"], string | null> = {
  original: null,
  "gate-fail": "follow-up · gate",
  "review-fail": "follow-up · review",
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

/** Humanized activity phrasing (v1's activityText): event rows read as
    sentences, with the payload detail folded in where it matters. */
function activityText(event: AuditEvent): string {
  const d = event.detail;
  const str = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : null);
  switch (event.type) {
    case "ticket.created":
      return "created the ticket";
    case "ticket.updated":
      return "updated the ticket";
    case "ticket.promoted":
      return "promoted to the board";
    case "ticket.claimed":
      return "claimed the ticket";
    case "run.failed":
      return str("reason") ? `run setup failed — ${str("reason")}` : "run setup failed";
    case "run.crashed":
      return str("reason") ? `run crashed — ${str("reason")}` : "run crashed";
    case "worktree.created":
      return "created the worktree";
    case "worktree.reused":
      return "reused the worktree";
    case "phase.started":
      return str("phase") ? `started phase ${str("phase")}` : "started a phase";
    case "phase.crashed":
      return str("phase") ? `phase ${str("phase")} crashed` : "phase crashed";
    case "phase.completed":
      return str("phase") ? `phase ${str("phase")} completed` : "phase completed";
    case "run.completed":
      return "run completed";
    case "gates.failed":
      return "gate battery failed";
    case "gate.result":
      return str("gate") ? `gate ${str("gate")} · ${str("status") ?? ""}` : "recorded a gate result";
    case "pr.recorded":
      return "pull request opened";
    case "artifacts.persisted":
      return "persisted run artifacts";
    case "checks.registered":
      return "registered AC checks";
    case "ticket.bounced":
      return str("reason") ? `bounced — ${str("reason")}` : "bounced for another attempt";
    case "ticket.parked":
      return str("reason") ? `parked — ${str("reason")}` : "parked for human attention";
    case "ticket.retried":
      return "sent back to Todo for another attempt";
    case "ticket.merged":
      return "merged";
    case "verdict.recorded":
      return str("outcome") ? `review verdict: ${str("outcome")}` : "review verdict recorded";
    case "ac.waived":
      return "waived a criterion";
    case "dogfood.decision_answered":
      return "answered a dogfood decision";
    case "worktree.reaped":
      return "worktree reaped";
    case "automation.fired":
      return "automation fired";
    default:
      return event.type;
  }
}

/** Long payload reasons (git stderr, crash traces) get one line, not a wall. */
function clip(text: string, max = 110): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The machine churn inside one agent attempt, folded behind a summary row. */
const ATTEMPT_TYPES = new Set([
  "worktree.created",
  "worktree.reused",
  "phase.started",
  "phase.completed",
  "phase.crashed",
  "gate.result",
  "gates.failed",
  "artifacts.persisted",
  "checks.registered",
  "run.completed",
  "run.crashed",
  "run.failed",
]);

type FeedItem =
  | { kind: "event"; event: AuditEvent }
  | { kind: "attempt"; number: number; events: AuditEvent[] };

/**
 * Fold each claim-to-terminal stretch of agent events into one attempt group:
 * the default feed reads as milestones (created, promoted, attempts, parked,
 * verdicts), and the per-phase churn is one click away instead of 80 rows.
 */
function groupFeed(audit: AuditEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  let open: { kind: "attempt"; number: number; events: AuditEvent[] } | null = null;
  let attempts = 0;
  for (const event of audit) {
    if (event.type === "ticket.claimed") {
      attempts += 1;
      open = { kind: "attempt", number: attempts, events: [event] };
      items.push(open);
    } else if (open && event.actor === "agent" && ATTEMPT_TYPES.has(event.type)) {
      open.events.push(event);
    } else {
      open = null;
      items.push({ kind: "event", event });
    }
  }
  return items;
}

/** One line for a folded attempt: its terminal event tells the story. */
function attemptSummary(events: AuditEvent[]): string {
  const terminal = [...events]
    .reverse()
    .find((e) => e.type.startsWith("run.") || e.type === "gates.failed");
  if (!terminal) return "in progress";
  return clip(activityText(terminal), 90);
}

/** Sidebar group: uppercase label above a stack of rows (v1's aside groups). */
function RailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rail-group">
      <span className="rail-label">{title}</span>
      {children}
    </div>
  );
}

/** Titled block in the main column. */
function Panel({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string | number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="panel-count dim">{count}</span>}
        {action}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * Ticket detail, v1 layout: three panes under the breadcrumb — description
 * left, artifacts + activity middle, properties/project/actions rail right.
 * The agent log lives on its own full-screen view (the Agent Logs button).
 */
export function TicketDetail({
  ticket,
  projectName,
  repos,
  audit,
  runs,
  loadAudit,
  loadRuns,
  onClose,
  onOpenLogs,
  onOpenReview,
}: {
  ticket: TicketWithAcs;
  projectName: string;
  repos: Repo[];
  audit: AuditEvent[];
  runs: RunWithPhases[];
  loadAudit: (ticketId: number) => void;
  loadRuns: (ticketId: number) => void;
  onClose: () => void;
  onOpenLogs: () => void;
  onOpenReview: () => void;
}) {
  const repo = repos.find((r) => r.id === ticket.repoId);
  const latestRun = runs[0];

  const [editingDesc, setEditingDesc] = useState(false);
  const [openAttempts, setOpenAttempts] = useState<Set<number>>(new Set());
  const [draftDesc, setDraftDesc] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    loadAudit(ticket.id);
    loadRuns(ticket.id);
  }, [ticket.id, loadAudit, loadRuns]);

  // Esc returns to the board, matching the back button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editingDesc) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editingDesc]);

  const gateResults = latestRun?.gateResults ?? [];
  const artifacts = latestRun?.artifacts ?? [];
  const settled = ticket.acceptanceCriteria.filter(
    (c) => c.status === "verified" || c.status === "waived",
  ).length;

  const saveTitle = (title: string) => {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === ticket.title) return;
    void apiPatch(`/api/tickets/${ticket.id}`, { title: trimmed }).catch((e) =>
      setActionError(errorMessage(e)),
    );
  };

  const saveDescription = () => {
    setEditingDesc(false);
    if (draftDesc === ticket.description) return;
    void apiPatch(`/api/tickets/${ticket.id}`, { description: draftDesc }).catch((e) =>
      setActionError(errorMessage(e)),
    );
  };

  const retry = () => {
    setActionError(null);
    void apiPost(`/api/tickets/${ticket.id}/retry`, {}).catch((e) =>
      setActionError(errorMessage(e)),
    );
  };

  const copyBranch = () => {
    if (ticket.branch) void navigator.clipboard.writeText(ticket.branch);
  };

  return (
    <div className="detail-page detail-v2">
      <header className="detail-head">
        <button type="button" className="btn btn-ghost crumb-back" onClick={onClose}>
          <Icon name="chevron-left" size={14} />
          Board
        </button>
        <span className="crumb-sep dim">/</span>
        <span className="crumb dim">{projectName}</span>
        <span className="crumb-sep dim">/</span>
        <span className="crumb">{ticket.displayKey}</span>
        <span className={`badge badge-${ticket.state}`}>{STATE_LABELS[ticket.state]}</span>
      </header>

      <div className="detail-panes">
        {/* -- left: title, description, ACs, gates -- */}
        <div className="detail-main">
          <input
            className="detail-title-input"
            key={`${ticket.id}-${ticket.title}`}
            defaultValue={ticket.title}
            onBlur={(e) => saveTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />

          <Panel
            title="Description"
            action={
              !editingDesc ? (
                <button
                  type="button"
                  className="btn btn-sm panel-action"
                  onClick={() => {
                    setDraftDesc(ticket.description);
                    setEditingDesc(true);
                  }}
                >
                  Edit
                </button>
              ) : undefined
            }
          >
            {editingDesc ? (
              <div className="desc-edit">
                <textarea
                  className="desc-editor"
                  value={draftDesc}
                  rows={Math.min(24, Math.max(6, draftDesc.split("\n").length + 2))}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  autoFocus
                />
                <div className="desc-edit-actions">
                  <button type="button" className="btn btn-sm panel-action" onClick={saveDescription}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm panel-action dim"
                    onClick={() => setEditingDesc(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : ticket.description ? (
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
                            className="btn btn-warn waivebtn"
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
        </div>

        {/* -- middle: artifacts strip + activity feed -- */}
        <div className="detail-activity">
          <div className="activity-head">
            <span className="rail-label">Activity</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!latestRun}
              title={latestRun ? "Open the run's conversation" : "No run yet"}
              onClick={onOpenLogs}
            >
              ▸ Agent Logs
            </button>
          </div>

          {artifacts.length > 0 && (
            <div className="artifact-strip">
              <span className="rail-label">Artifacts</span>
              <div className="artifact-chips">
                {artifacts.map((artifact) => (
                  <a
                    key={artifact.id}
                    className="artifact-chip"
                    href={`${apiBase}/api/artifacts/${artifact.id}/content`}
                    target="_blank"
                    rel="noreferrer"
                    title={`${artifact.kind} · ${artifact.name}`}
                  >
                    <span className="artifactkind dim">{artifact.kind}</span>
                    {artifact.name}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="activity-feed">
            {audit.length === 0 && <p className="dim">No activity yet.</p>}
            {groupFeed(audit).map((item) => {
              if (item.kind === "event") {
                const { event } = item;
                return (
                  <div className="activity-row" key={event.id}>
                    <span className={`activity-dot actor-${event.actor}`} title={event.actor} />
                    <span className="activity-text">
                      <span
                        className={
                          event.actor === "agent" ? "activity-actor agent" : "activity-actor"
                        }
                      >
                        {event.actor}
                      </span>{" "}
                      {clip(activityText(event))}
                    </span>
                    <span
                      className="activity-time dim"
                      title={new Date(event.createdAt).toLocaleString()}
                    >
                      {timeAgo(event.createdAt)}
                    </span>
                  </div>
                );
              }
              const last = item.events[item.events.length - 1]!;
              const expanded = openAttempts.has(item.number);
              return (
                <div className="activity-attempt" key={`attempt-${item.number}`}>
                  <button
                    type="button"
                    className="activity-row activity-attempt-head"
                    onClick={() =>
                      setOpenAttempts((current) => {
                        const next = new Set(current);
                        if (next.has(item.number)) next.delete(item.number);
                        else next.add(item.number);
                        return next;
                      })
                    }
                  >
                    <Icon
                      name={expanded ? "chevron-down" : "chevron-right"}
                      size={12}
                      className="activity-chevron"
                    />
                    <span className="activity-text">
                      <span className="activity-actor agent">agent</span> attempt #{item.number} —{" "}
                      {attemptSummary(item.events)}
                      <span className="dim"> · {item.events.length} steps</span>
                    </span>
                    <span
                      className="activity-time dim"
                      title={new Date(last.createdAt).toLocaleString()}
                    >
                      {timeAgo(last.createdAt)}
                    </span>
                  </button>
                  {expanded &&
                    item.events.map((event) => (
                      <div className="activity-row activity-substep" key={event.id}>
                        <span className="activity-dot actor-agent" />
                        <span className="activity-text">{clip(activityText(event))}</span>
                        <span
                          className="activity-time dim"
                          title={new Date(event.createdAt).toLocaleString()}
                        >
                          {timeAgo(event.createdAt)}
                        </span>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* -- right: properties / project / actions rail -- */}
        <aside className="detail-rail">
          <RailGroup title="Properties">
            <div className="rail-row">
              <span className="rail-key dim">State</span>
              <span className={`badge badge-${ticket.state}`}>{STATE_LABELS[ticket.state]}</span>
            </div>
            <div className="rail-row">
              <span className="rail-key dim">Provider</span>
              <span>{ticket.provider ? PROVIDER_LABELS[ticket.provider] : "—"}</span>
            </div>
            {ticket.externalRef && (
              <div className="rail-row">
                <span className="rail-key dim">External</span>
                <span>{ticket.externalRef}</span>
              </div>
            )}
            {ticket.bounceCount > 0 && (
              <div className="rail-row">
                <span className="rail-key dim">Bounces</span>
                <span>
                  {ticket.bounceCount}
                  {ticket.arrivedByCap && " · parked by cap"}
                </span>
              </div>
            )}
          </RailGroup>

          <RailGroup title="Project">
            <div className="rail-row">
              <span className="rail-key dim">Repo</span>
              <span>{repo ? repoName(repo) : "—"}</span>
            </div>
            {ticket.branch && (
              <button
                type="button"
                className="rail-row rail-click mono"
                title="Click to copy"
                onClick={copyBranch}
              >
                {ticket.branch}
              </button>
            )}
            {ticket.prUrl && (
              <a className="rail-row rail-click" href={ticket.prUrl} target="_blank" rel="noreferrer">
                Pull request #{ticket.prNumber}
              </a>
            )}
            {latestRun && (
              <div className="rail-row">
                <span className="rail-key dim">Run</span>
                <span>
                  #{latestRun.id} · {latestRun.state}
                  {runs.length > 1 && ` · ${runs.length} attempts`}
                </span>
              </div>
            )}
            {latestRun?.crashReason && <p className="error rail-error">{latestRun.crashReason}</p>}
          </RailGroup>

          <RailGroup title="Actions">
            {(ticket.state === "human_review" || ticket.state === "done") && (
              <button type="button" className="btn btn-primary rail-action" onClick={onOpenReview}>
                Start Review Wizard
              </button>
            )}
            {ticket.state === "human_review" && (
              <button type="button" className="btn rail-action" onClick={retry}>
                Retry — back to Todo
              </button>
            )}
            <button type="button" className="btn rail-action" disabled={!latestRun} onClick={onOpenLogs}>
              Agent Logs
            </button>
            {actionError && <p className="error rail-error">{actionError}</p>}
          </RailGroup>
        </aside>
      </div>
    </div>
  );
}
