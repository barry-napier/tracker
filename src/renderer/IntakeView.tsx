import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  PROVIDERS,
  type IntakeAcDraft,
  type IntakeBreakdown,
  type IntakeDraft,
  type IntakeKind,
  type IntakeSession,
  type IntakeTicketDraft,
  type IntakeTurn,
  type Project,
  type ProviderName,
  type RepoListItem,
  type TicketWithAcs,
} from "../server/types.ts";
import { ApiError, apiBase, apiDelete, apiGet, apiPost, errorMessage } from "./api.ts";
import { KIND_LABELS, type LogBlockView } from "./AgentLog.tsx";
import { PROVIDER_LABELS, repoName } from "./format.ts";
import { KindIcon } from "./kindIcons.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { Markdown } from "./Markdown.tsx";

const INTAKE_KIND_CARDS: Array<{ key: IntakeKind; label: string; blurb: string; hint: string }> = [
  {
    key: "bug",
    label: "Bug",
    blurb: "Something is broken. The agent pins down observed vs. expected, repro steps, and a suspected cause.",
    hint: "What's broken? One line is fine — the agent will grill you.",
  },
  {
    key: "feature",
    label: "Feature",
    blurb: "New behavior. The agent nails the why, the what, and what's out of scope.",
    hint: "What do you want done? One line is fine — the agent will grill you.",
  },
  {
    key: "initiative",
    label: "Large initiative",
    blurb:
      "A big, foggy goal. Wayfinder-style: name the destination, grill breadth-first, and file only the feature/bug tickets that are sharp — the board never sees an initiative.",
    hint: "What's the destination? The agent will chart the way with you.",
  },
];

/**
 * The full-page intake composer: what is this ticket about (kind), the
 * intent, and provider/repo — then straight into the grilling session.
 */
export function IntakeNew({ project, repos }: { project: Project; repos: RepoListItem[] }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<IntakeKind>("feature");
  const [intent, setIntent] = useState("");
  const [repoId, setRepoId] = useState<number | null>(null);
  const [provider, setProvider] = useState<string>(project.defaultProvider);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pickedRepo = repoId ?? repos[0]?.id ?? null;
  const card = INTAKE_KIND_CARDS.find((c) => c.key === kind)!;

  const submit = async () => {
    if (intent.trim() === "" || pickedRepo === null || starting) return;
    setStarting(true);
    try {
      const session = await apiPost<IntakeSession>("/api/intake", {
        projectId: project.id,
        repoId: pickedRepo,
        provider,
        kind,
        intent: intent.trim(),
      });
      navigate(`/projects/${project.id}/intake/${session.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setStarting(false);
    }
  };

  return (
    <div className="intake">
      <header className="intake-header">
        <div className="intake-header-side">
          <button type="button" className="linklike" onClick={() => navigate(`/projects/${project.id}`)}>
            ← Board
          </button>
        </div>
        <div className="intake-header-center">
          <h2>New ticket</h2>
        </div>
        <div className="intake-header-side intake-header-actions" />
      </header>
      <div className="intake-scroll">
        <form
          className="intake-new"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section>
            <h3 className="intake-new-label">What is this ticket about?</h3>
            <div className="intake-kind-cards" role="radiogroup" aria-label="What is this ticket about?">
              {INTAKE_KIND_CARDS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={
                    kind === option.key ? "intake-kind-card intake-kind-card-on" : "intake-kind-card"
                  }
                  onClick={() => setKind(option.key)}
                >
                  <strong>
                    <KindIcon kind={option.key} />
                    {option.label}
                  </strong>
                  <span>{option.blurb}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="intake-new-label">Intent</h3>
            <textarea
              autoFocus
              className="intake-new-intent"
              placeholder={card.hint}
              rows={5}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
            <p className="dim intake-new-note">
              The agent researches the repo first (DESIGN.md, ADRs, the code this touches), asks only
              the decisions the repo can't answer, then drafts the ticket for your approval.
            </p>
          </section>

          <section className="intake-new-row">
            <div className="intake-field">
              <span className="dim">Provider</span>
              <ProviderPicker value={provider} onChange={setProvider} />
            </div>
            {repos.length > 1 && (
              <label className="intake-field">
                <span className="dim">Repo</span>
                <select value={pickedRepo ?? ""} onChange={(e) => setRepoId(Number(e.target.value))}>
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repoName(repo)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>

          {error && <p className="error">{error}</p>}
          <div className="intake-new-actions">
            <button type="submit" className="intake-approve" disabled={intent.trim() === "" || starting}>
              {starting ? "Starting…" : "Start intake"}
            </button>
            <button
              type="button"
              className="intake-discard"
              onClick={() => navigate(`/projects/${project.id}`)}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * The intake session surface: the grilling transcript on the left, the live
 * agent activity and (once drafted) the editable ticket draft on the right.
 * Approve materializes the draft into a Backlog ticket; the card arrives on
 * the board over SSE like any other creation.
 */

/** The session's live agent activity over its per-session SSE log stream. */
function useIntakeLog(sessionId: number, active: boolean): LogBlockView[] {
  const [blocks, setBlocks] = useState<LogBlockView[]>([]);

  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`${apiBase}/api/intake/${sessionId}/log`);
    const fromOpen = (event: {
      blockId: string;
      phase: string;
      block: { kind: LogBlockView["kind"]; text?: string; input?: string; output?: string; tool?: string; isError?: boolean };
    }): LogBlockView => ({
      blockId: event.blockId,
      phase: event.phase,
      kind: event.block.kind,
      body: event.block.text ?? event.block.input ?? event.block.output ?? "",
      tool: event.block.tool,
      isError: event.block.isError,
      open: true,
    });
    source.addEventListener("block.open", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) => [...state.filter((b) => b.blockId !== event.blockId), fromOpen(event)]);
    });
    source.addEventListener("block.delta", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) =>
        state.map((b) => (b.blockId === event.blockId ? { ...b, body: b.body + event.textDelta } : b)),
      );
    });
    source.addEventListener("block.close", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) => state.map((b) => (b.blockId === event.blockId ? { ...b, open: false } : b)));
    });
    return () => source.close();
  }, [sessionId, active]);

  return blocks;
}

function lastAgentTurn(session: IntakeSession): (IntakeTurn & { role: "agent" }) | null {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const turn = session.transcript[i];
    if (turn?.role === "agent") return turn;
  }
  return null;
}

function TranscriptTurn({ turn }: { turn: IntakeTurn }) {
  if (turn.role === "user") {
    return <div className="intake-turn intake-turn-user">{turn.text}</div>;
  }
  if ("question" in turn) {
    return (
      <div className="intake-turn intake-turn-agent">
        <p>{turn.question.text}</p>
        {turn.question.options && (
          <ol className="intake-options-list">
            {turn.question.options.map((option, i) => (
              <li key={i}>{option}</li>
            ))}
          </ol>
        )}
        <p className="dim intake-why">why this is yours to answer: {turn.question.why}</p>
      </div>
    );
  }
  if ("breakdown" in turn) {
    const b = turn.breakdown;
    return (
      <div className="intake-turn intake-turn-agent">
        <p>
          Charted <strong>{b.destination}</strong> — {b.tickets.length} ticket
          {b.tickets.length === 1 ? "" : "s"}
          {b.notYetSpecified.length > 0 && `, ${b.notYetSpecified.length} still in the fog`}.
          {turn.note ? ` ${turn.note}` : ""}
        </p>
      </div>
    );
  }
  return (
    <div className="intake-turn intake-turn-agent">
      <p>
        Drafted <strong>{turn.draft.title}</strong> — {turn.draft.acs.length} AC
        {turn.draft.acs.length === 1 ? "" : "s"}.{turn.note ? ` ${turn.note}` : ""}
      </p>
    </div>
  );
}

/** One breakdown ticket, read-mode: collapsed to its title row, zoomable. */
function BreakdownTicket({
  ticket,
  onRemove,
}: {
  ticket: IntakeTicketDraft;
  onRemove: () => void;
}) {
  return (
    <details className="intake-bd-ticket">
      <summary>
        <KindIcon kind={ticket.kind} size={14} />
        <span className="intake-bd-title">{ticket.title}</span>
        <span className="dim">
          {ticket.acs.length} AC{ticket.acs.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="intake-ac-remove"
          title="Drop from this batch (it will not be filed)"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          ✕
        </button>
      </summary>
      <div className="intake-bd-body">
        <Markdown text={ticket.description} />
        <ol className="intake-ac-list">
          {ticket.acs.map((ac, i) => (
            <li key={i} className="intake-ac-item">
              <div className="intake-ac-row">
                <span className="intake-ac-n dim">AC {i + 1}</span>
                <span className="intake-ac-text">{ac.text}</span>
                <span className={ac.route === "check" ? "chip chip-ok" : "chip chip-warn"}>
                  {ac.route === "check" ? "✓ scripted check" : "human judgment"}
                </span>
              </div>
              {ac.route === "check" && ac.checkSketch && (
                <details className="intake-ac-sketch">
                  <summary className="dim">check sketch</summary>
                  <pre>{ac.checkSketch}</pre>
                </details>
              )}
              {ac.route === "human" && ac.humanReason && (
                <p className="dim intake-ac-reason">why human: {ac.humanReason}</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function AcEditor({
  ac,
  onChange,
  onRemove,
}: {
  ac: IntakeAcDraft;
  onChange: (next: IntakeAcDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="intake-ac">
      <div className="intake-ac-head">
        <textarea
          rows={2}
          value={ac.text}
          onChange={(e) => onChange({ ...ac, text: e.target.value })}
        />
        <select
          value={ac.route}
          onChange={(e) => onChange({ ...ac, route: e.target.value as IntakeAcDraft["route"] })}
        >
          <option value="check">check</option>
          <option value="human">human</option>
        </select>
        <button type="button" className="intake-ac-remove" onClick={onRemove} title="Remove AC">
          ✕
        </button>
      </div>
      {ac.route === "check" ? (
        <textarea
          rows={3}
          className="intake-sketch"
          placeholder="Check sketch (shell) — should fail on the current tree"
          value={ac.checkSketch ?? ""}
          onChange={(e) => onChange({ ...ac, checkSketch: e.target.value })}
        />
      ) : (
        <input
          placeholder="Why this needs human judgment"
          value={ac.humanReason ?? ""}
          onChange={(e) => onChange({ ...ac, humanReason: e.target.value })}
        />
      )}
    </div>
  );
}

export function IntakeView({
  sessionId,
  projectId,
}: {
  sessionId: number;
  projectId: number;
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<IntakeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [breakdown, setBreakdown] = useState<IntakeBreakdown | null>(null);
  const [filedNote, setFiledNote] = useState<string | null>(null);
  // Agent activity is a peek, not the point — collapsed unless asked for.
  const [showActivity, setShowActivity] = useState(false);
  // The draft reads as a ticket by default; the form is opt-in.
  const [editing, setEditing] = useState(false);
  const kicked = useRef(false);
  const polling = useRef(false);
  const log = useIntakeLog(sessionId, busy);
  const logEnd = useRef<HTMLDivElement>(null);

  const apply = (next: IntakeSession) => {
    setSession(next);
    setDraft(next.draft);
    setBreakdown(next.breakdown);
  };

  /**
   * Re-attach to a turn this view didn't start (a reload mid-research, or a
   * 409 from a double-fire): hold the busy state and poll until the server
   * says the turn ended, then render whatever it persisted.
   */
  const pollUntilIdle = async () => {
    if (polling.current) return;
    polling.current = true;
    setBusy(true);
    setError(null);
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const live = await apiGet<IntakeSession & { turnInFlight?: boolean }>(
            `/api/intake/${sessionId}`,
          );
          if (!live.turnInFlight) {
            apply(live);
            return;
          }
        } catch {
          // Transient fetch failure — keep polling; the turn owns the truth.
        }
      }
    } finally {
      polling.current = false;
      setBusy(false);
    }
  };

  const runTurn = async (route: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      apply(await apiPost<IntakeSession>(route, body));
      setAnswer("");
      setBusy(false);
    } catch (e) {
      // Another turn already running (double-fire, second window): attach
      // to it instead of surfacing a scary error.
      if (e instanceof ApiError && e.status === 409) {
        void pollUntilIdle();
        return;
      }
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  // Load; re-attach to a running turn, or kick the first research turn
  // exactly once for a fresh session.
  useEffect(() => {
    void apiGet<IntakeSession & { turnInFlight?: boolean }>(`/api/intake/${sessionId}`)
      .then((loaded) => {
        apply(loaded);
        if (loaded.turnInFlight) {
          void pollUntilIdle();
          return;
        }
        const needsKick = loaded.status === "active" && !loaded.transcript.some((t) => t.role === "agent");
        if (needsKick && !kicked.current) {
          kicked.current = true;
          void runTurn(`/api/intake/${sessionId}/retry`, {});
        }
      })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [log.length]);

  if (!session) return <p className="dim">{error ?? "Loading…"}</p>;

  const open = session.status === "active" || session.status === "drafted";
  const last = lastAgentTurn(session);
  // A follow-up question can arrive after a draft exists — the question wins
  // the input surface; the draft panel stays for reference either way.
  const asking = !busy && open && last !== null && "question" in last;
  const drafted = !busy && open && draft !== null && !asking;
  const charted = !busy && open && breakdown !== null && !asking;

  const approve = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost<{ ticket: TicketWithAcs }>(`/api/intake/${sessionId}/approve`, { draft });
      navigate(`/projects/${projectId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  /** Initiative approval: file the batch; fog keeps the session open. */
  const approveBreakdown = async () => {
    if (!breakdown || breakdown.tickets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ session: IntakeSession; tickets: TicketWithAcs[] }>(
        `/api/intake/${sessionId}/approve`,
        { breakdown },
      );
      if (result.session.status === "approved") {
        navigate(`/projects/${projectId}`);
        return;
      }
      apply(result.session);
      setFiledNote(
        `Filed ${result.tickets.map((t) => t.displayKey).join(", ")} to Backlog — the fog below stays open here.`,
      );
      setBusy(false);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const discard = async () => {
    try {
      await apiDelete(`/api/intake/${sessionId}`);
    } catch {
      // Already gone is fine — we're leaving either way.
    }
    navigate(`/projects/${projectId}`);
  };

  return (
    <div className="intake">
      <header className="intake-header">
        <div className="intake-header-side">
          <button type="button" className="linklike" onClick={() => navigate(`/projects/${projectId}`)}>
            ← Board
          </button>
        </div>
        <div className="intake-header-center">
          <h2>New ticket</h2>
          <span className="intake-kind-badge">
            <KindIcon kind={session.kind} size={13} />
            {session.kind}
          </span>
          <span className={`intake-status intake-status-${session.status}`}>{session.status}</span>
        </div>
        <div className="intake-header-side intake-header-actions">
          <button type="button" className="intake-discard" onClick={() => void discard()}>
            Discard
          </button>
        </div>
      </header>

      <div className="intake-scroll">
        <section className="intake-chat">
          <div className="intake-turn intake-turn-user">{session.intent}</div>
          {session.transcript.map((turn, i) => (
            <TranscriptTurn key={i} turn={turn} />
          ))}

          {busy && (
            <div className="intake-working">
              <button
                type="button"
                className="intake-working-head"
                onClick={() => setShowActivity((open) => !open)}
                aria-expanded={showActivity}
              >
                <span className="intake-pulse" aria-hidden="true" />
                Researching the repo…
                <span className="intake-working-toggle dim">
                  {showActivity ? "Hide details ▴" : "Show details ▾"}
                </span>
              </button>
              {showActivity && (
                <>
                  <ol className="agentlog intake-log">
                    {log.slice(-8).map((block) => (
                      <li key={block.blockId} className={`logblock logblock-${block.kind}`}>
                        <span className="logkind dim">
                          {KIND_LABELS[block.kind]}
                          {block.tool && ` ${block.tool}`}
                        </span>
                        <pre className={block.isError ? "logbody error" : "logbody"}>{block.body}</pre>
                      </li>
                    ))}
                  </ol>
                  <div ref={logEnd} />
                </>
              )}
            </div>
          )}
          {error && (
            <div className="intake-turn intake-turn-agent">
              <p className="error">{error}</p>
              <button type="button" onClick={() => void runTurn(`/api/intake/${sessionId}/retry`, {})}>
                Retry
              </button>
            </div>
          )}

          {drafted && draft && !editing && (
            <div className="intake-draft">
              <div className="intake-draft-head">
                <h3>Ticket draft</h3>
                <button type="button" className="linklike" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </div>
              <h2 className="intake-draft-title">
                <KindIcon kind={session.kind} />
                {draft.title}
              </h2>
              <div className="intake-draft-desc">
                <Markdown text={draft.description} />
              </div>
              <h4 className="dim">Acceptance criteria</h4>
              <ol className="intake-ac-list">
                {draft.acs.map((ac, i) => (
                  <li key={i} className="intake-ac-item">
                    <div className="intake-ac-row">
                      <span className="intake-ac-n dim">AC {i + 1}</span>
                      <span className="intake-ac-text">{ac.text}</span>
                      <span className={ac.route === "check" ? "chip chip-ok" : "chip chip-warn"}>
                        {ac.route === "check" ? "✓ scripted check" : "human judgment"}
                      </span>
                    </div>
                    {ac.route === "check" && ac.checkSketch && (
                      <details className="intake-ac-sketch">
                        <summary className="dim">check sketch</summary>
                        <pre>{ac.checkSketch}</pre>
                      </details>
                    )}
                    {ac.route === "human" && ac.humanReason && (
                      <p className="dim intake-ac-reason">why human: {ac.humanReason}</p>
                    )}
                  </li>
                ))}
              </ol>
              <div className="intake-approve-row">
                <button
                  type="button"
                  className="intake-approve"
                  disabled={draft.title.trim() === "" || draft.acs.length === 0}
                  onClick={() => void approve()}
                >
                  Approve → Backlog
                </button>
              </div>
            </div>
          )}

          {charted && breakdown && (
            <div className="intake-draft">
              <div className="intake-draft-head">
                <h3>Initiative breakdown</h3>
                <span className="dim">only features and bugs reach the board</span>
              </div>
              <p className="intake-bd-dest">
                <span className="dim">Destination:</span> {breakdown.destination}
              </p>
              {filedNote && <p className="intake-bd-filed">{filedNote}</p>}
              {breakdown.tickets.length > 0 && (
                <>
                  <h4 className="dim">Tickets ready to file</h4>
                  {breakdown.tickets.map((ticket, i) => (
                    <BreakdownTicket
                      key={i}
                      ticket={ticket}
                      onRemove={() =>
                        setBreakdown({
                          ...breakdown,
                          tickets: breakdown.tickets.filter((_, j) => j !== i),
                        })
                      }
                    />
                  ))}
                </>
              )}
              {breakdown.notYetSpecified.length > 0 && (
                <>
                  <h4 className="dim">Not yet specified — the fog</h4>
                  <ul className="intake-bd-fog">
                    {breakdown.notYetSpecified.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                  <p className="dim intake-bd-hint">
                    Deliberately not ticketed — keep answering below to clear it, then more
                    tickets graduate out.
                  </p>
                </>
              )}
              {breakdown.outOfScope.length > 0 && (
                <>
                  <h4 className="dim">Out of scope</h4>
                  <ul className="intake-bd-fog">
                    {breakdown.outOfScope.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="intake-approve-row">
                <button
                  type="button"
                  className="intake-approve"
                  disabled={breakdown.tickets.length === 0}
                  onClick={() => void approveBreakdown()}
                >
                  File {breakdown.tickets.length} ticket
                  {breakdown.tickets.length === 1 ? "" : "s"} → Backlog
                </button>
              </div>
            </div>
          )}

          {drafted && draft && editing && (
            <div className="intake-draft">
              <div className="intake-draft-head">
                <h3>Edit draft</h3>
                <button type="button" className="linklike" onClick={() => setEditing(false)}>
                  Done
                </button>
              </div>
              <label className="intake-field">
                <span className="dim">Title</span>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="intake-field">
                <span className="dim">Description (markdown)</span>
                <textarea
                  rows={14}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <h4 className="dim">Acceptance criteria</h4>
              {draft.acs.map((ac, i) => (
                <AcEditor
                  key={i}
                  ac={ac}
                  onChange={(next) => setDraft({ ...draft, acs: draft.acs.map((a, j) => (j === i ? next : a)) })}
                  onRemove={() => setDraft({ ...draft, acs: draft.acs.filter((_, j) => j !== i) })}
                />
              ))}
              <button
                type="button"
                className="linklike intake-add-ac"
                onClick={() => setDraft({ ...draft, acs: [...draft.acs, { text: "", route: "check" }] })}
              >
                + Add AC
              </button>
              <div className="intake-approve-row">
                <button
                  type="button"
                  className="intake-approve"
                  disabled={draft.title.trim() === "" || draft.acs.length === 0 || draft.acs.some((ac) => ac.text.trim() === "")}
                  onClick={() => setEditing(false)}
                >
                  Done editing
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {(asking || drafted || charted) && last && (
        <form
          className="intake-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim() === "") return;
            void runTurn(`/api/intake/${sessionId}/reply`, { message: answer.trim() });
          }}
        >
          {asking && "question" in last && last.question.options && (
            <div className="intake-options">
              {last.question.options.map((option, i) => (
                <button
                  key={i}
                  type="button"
                  className="intake-chip"
                  onClick={() => void runTurn(`/api/intake/${sessionId}/reply`, { message: option })}
                >
                  <span className="intake-chip-n">{i + 1}</span>
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="intake-composer-row">
            <input
              autoFocus={asking}
              placeholder={
                asking
                  ? "Answer, or pick an option above…"
                  : charted
                    ? "Feedback, or answer toward the fog…"
                    : "Feedback on the draft…"
              }
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button type="submit" disabled={answer.trim() === ""}>
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
