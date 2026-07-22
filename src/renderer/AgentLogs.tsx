import { useEffect, useMemo, useRef, useState } from "react";
import type { PhaseExecution, RunWithPhases, TicketWithAcs } from "../server/types.ts";
import { KIND_LABELS, useRunLog, type LogBlockView } from "./AgentLog.tsx";
import { Icon } from "./icons.tsx";

const PHASE_MARKS: Record<PhaseExecution["state"], string> = {
  running: "…",
  completed: "✓",
  failed: "✗",
  crashed: "✗",
};

function phaseDuration(phase: PhaseExecution): string {
  const end = phase.endedAt ? Date.parse(phase.endedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(phase.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function isTool(block: LogBlockView): boolean {
  return block.kind === "tool_call" || block.kind === "tool_result";
}

/**
 * The sidebar's roster: executed phases in execution order (retries collapse
 * to the latest attempt), then the pinned workflow's remaining phases as
 * dimmed "upcoming" rows — so the whole journey is visible, not just the
 * part that already happened. A branch path not taken never lights up.
 */
function phaseRoster(run: RunWithPhases): Array<
  { name: string; execution: PhaseExecution | null }
> {
  const latest = new Map<string, PhaseExecution>();
  for (const phase of run.phases) latest.set(phase.phase, phase); // rows are append-only; last wins
  const roster = [...latest.values()].map((execution) => ({
    name: execution.phase,
    execution: execution as PhaseExecution | null,
  }));
  // Defensive ?? []: a snapshot cached before the field existed still renders.
  for (const name of run.expectedPhases ?? []) {
    if (!latest.has(name)) roster.push({ name, execution: null });
  }
  return roster;
}

/**
 * Full-screen agent-log view (v1's LogsView): always-dark terminal surface,
 * phase sidebar filtering the conversation, run picker across attempts,
 * tools toggle, and auto-scroll that follows the live stream.
 */
export function AgentLogs({
  ticket,
  runs,
  loadRuns,
  onBack,
}: {
  ticket: TicketWithAcs;
  runs: RunWithPhases[];
  loadRuns: (ticketId: number) => void;
  onBack: () => void;
}) {
  const [runId, setRunId] = useState<number | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activePhase, setActivePhase] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadRuns(ticket.id);
  }, [ticket.id, loadRuns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const blocks = useRunLog(run?.id ?? 0);

  const visible = useMemo(
    () =>
      blocks.filter(
        (b) =>
          (showTools || !isTool(b)) && (activePhase === null || b.phase === activePhase),
      ),
    [blocks, showTools, activePhase],
  );

  // Follow the stream: jump to the bottom whenever content grows.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  const live = run?.state === "running";
  const roster = run ? phaseRoster(run) : [];

  return (
    <div className="logs-view">
      <header className="logs-head">
        <button type="button" className="logs-back" onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          {ticket.displayKey}
        </button>
        <span className="logs-title">{ticket.title}</span>
        <div className="logs-controls">
          {runs.length > 1 && (
            <select
              className="logs-runpick"
              value={run?.id ?? ""}
              onChange={(e) => {
                setRunId(Number(e.target.value));
                setActivePhase(null);
              }}
            >
              {runs.map((r, i) => (
                <option key={r.id} value={r.id}>
                  Run #{r.id} · {r.state}
                  {i === 0 ? " · latest" : ""}
                </option>
              ))}
            </select>
          )}
          <label className="logs-toggle">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => setShowTools(e.target.checked)}
            />
            Tools
          </label>
          <label className="logs-toggle">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        </div>
      </header>

      {!run ? (
        <p className="logs-empty">No run yet — promote the ticket to start one.</p>
      ) : (
        <div className="logs-body">
          {roster.length > 0 && (
            <aside className="logs-phases">
              <span className="logs-phases-label">
                Phases
                {roster.length > 1 && (
                  <span className="logs-phases-progress">
                    {roster.filter((r) => r.execution?.state === "completed").length}/
                    {roster.length}
                  </span>
                )}
              </span>
              <button
                type="button"
                className={activePhase === null ? "logs-phase active" : "logs-phase"}
                onClick={() => setActivePhase(null)}
              >
                All
              </button>
              {roster.map(({ name, execution }) =>
                execution ? (
                  <button
                    type="button"
                    key={name}
                    className={activePhase === name ? "logs-phase active" : "logs-phase"}
                    onClick={() => setActivePhase(activePhase === name ? null : name)}
                  >
                    <span className={`logs-phase-mark phase-${execution.state}`}>
                      {PHASE_MARKS[execution.state]}
                    </span>
                    <span className="logs-phase-name">{name}</span>
                    <span className="logs-phase-time">{phaseDuration(execution)}</span>
                  </button>
                ) : (
                  // Upcoming: no log blocks exist yet, so there's nothing to
                  // filter to — render inert, not clickable.
                  <span key={name} className="logs-phase logs-phase-upcoming">
                    <span className="logs-phase-mark phase-upcoming">○</span>
                    <span className="logs-phase-name">{name}</span>
                  </span>
                ),
              )}
            </aside>
          )}

          <div className="logs-scroll" ref={scrollRef}>
            {visible.length === 0 && (
              <p className="logs-empty">
                {blocks.length === 0
                  ? "No conversation yet."
                  : "Nothing to show — tool blocks are hidden."}
              </p>
            )}
            <ol className="logs-stream">
              {visible.map((block) => (
                <li key={block.blockId} className={`logmsg logmsg-${block.kind}`}>
                  <span className="logmsg-kind">
                    {KIND_LABELS[block.kind]}
                    {block.tool && ` ${block.tool}`}
                    {block.phase && <em className="logmsg-phase">{block.phase}</em>}
                  </span>
                  {/* Claude Code redacts thinking text in -p mode (empty
                      deltas + a signature) — an empty thinking block is the
                      provider withholding, not a rendering bug. */}
                  {block.kind === "thinking" && block.body === "" && !block.open ? (
                    <pre className="logmsg-body logmsg-redacted">(redacted by provider)</pre>
                  ) : (
                    <pre className={block.isError ? "logmsg-body error" : "logmsg-body"}>
                      {block.body}
                      {block.open && <span className="cursor">▋</span>}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      <footer className="logs-status">
        {live ? (
          <span className="logs-live">
            <span className="logs-pulse" /> Live — streaming
          </span>
        ) : (
          <span>{run ? `Run ${run.state}` : "Idle"}</span>
        )}
        <span className="logs-count">
          {visible.length} of {blocks.length} blocks
        </span>
      </footer>
    </div>
  );
}
