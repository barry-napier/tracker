import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewView } from "../server/previews.ts";
import type { ReviewPayload } from "../server/reviews.ts";
import type {
  AcStatus,
  Artifact,
  AuditEvent,
  GateStatus,
  RunWithPhases,
  TicketWithAcs,
} from "../server/types.ts";
import { settleAc, waiveWithPrompt } from "./acActions.ts";
import { ApiError, apiBase, apiGet, apiPost } from "./api.ts";
import { GATE_MARKS } from "./format.ts";
import { Markdown } from "./Markdown.tsx";
import {
  absenceLabel,
  badgeRow,
  demoTranscriptArtifact,
  demoVideoArtifact,
  digestForAc,
  docsArtifacts,
  DOGFOOD_REPORT_NAME,
  DOGFOOD_RESULTS_NAME,
  failVerdictProblems,
  findArtifact,
  MARKABLE_STEPS,
  mergeProblems,
  missingArtifactLabel,
  parseDogfoodDecisions,
  parseReviewDigest,
  RECAP_NAME,
  verdictSteps,
  walkthroughItems,
  WIZARD_STEPS,
  type DogfoodDecision,
  type ReviewDigestContent,
  type ReviewMarks,
  type StepMark,
} from "./reviewModel.ts";

/**
 * The six-step review wizard as a centered modal (ticket 12, Variant A) —
 * the veto point since ticket 33. Chrome (meta header, badge row, stale
 * banner) renders live from ticket/run/gate data; only the step bodies show
 * agent-authored artifacts. The reviewer marks each step pass/fail/skip (a
 * fail demands a written note), settles ACs in the Manual Walkthrough, and
 * ends at the Final Verdict: merge to Done, or bounce with the notes.
 */
export function ReviewWizard({ ticket, onClose }: { ticket: TicketWithAcs; onClose: () => void }) {
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [marks, setMarks] = useState<ReviewMarks>({});
  const [drift, setDrift] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Lives at wizard level so the process starts on wizard open (ticket 34).
  const [previewError, setPreviewError] = useState<string | null>(null);
  const preview = usePreview(ticket.id, setPreviewError);

  const refetch = useCallback(() => {
    apiGet<ReviewPayload>(`/api/tickets/${ticket.id}/review`)
      .then((data) => {
        setPayload(data);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [ticket.id]);

  // Refetch whenever the board's live ticket row moves (waives, gate
  // results, bounces all bump updatedAt) so chrome stays drawn from the DB.
  useEffect(refetch, [refetch, ticket.updatedAt]);

  const stepKey = WIZARD_STEPS[step]!.key;
  // The Final Verdict re-runs the cheap freshness subset before offering
  // merge (ticket 06 §7): arriving on the step refetches PR mergeability and
  // the branch tip live; the server re-checks again inside the verdict.
  useEffect(() => {
    if (stepKey === "verdict") refetch();
  }, [stepKey, refetch]);

  const run = payload?.run ?? null;
  const badges = badgeRow(run);
  // The review agent's pre-digest (TRK-3). Stale findings are invalidated
  // (AC-43): the recap panel states it and the walkthrough stops pre-filling
  // from them — the branch moved under what the agent read.
  const digest = useReviewDigest(payload);
  const digestFresh = payload?.digest?.freshness === "stale" ? null : digest;

  const submitVerdict = async (body: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiPost(`/api/tickets/${ticket.id}/verdict`, body);
      onClose();
    } catch (e: unknown) {
      // Drift is a fork in the road, not a failure: offer the two honest
      // ways out. Anything else surfaces as the server said it.
      if (e instanceof ApiError && Array.isArray(e.body.drift)) {
        setDrift(e.body.drift as string[]);
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="veil" onClick={onClose} />
      <div className="wizard" role="dialog" aria-label={`Review ${ticket.displayKey}`}>
        <button className="icon-btn close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <header className="wizmeta">
          <h2>
            <span className="dim">{ticket.displayKey}</span> {ticket.title}
          </h2>
          <div className="props dim">
            <span>Run {run ? `#${run.id}` : "—"}</span>
            <span>Branch: {ticket.branch ?? "—"}</span>
            <span title={payload?.artifactSha ?? "no evidence persisted"}>
              Evidence at: {payload?.artifactSha?.slice(0, 7) ?? "—"}
            </span>
            {ticket.arrivedByCap && <span className="capflag">arrived via bounce cap</span>}
          </div>
          {badges.length > 0 && (
            <div className="badges">
              {badges.map((badge) => (
                <span
                  key={badge.gate}
                  className={`gatebadge gate-${badge.status}`}
                  title={badge.summary === "" ? badge.status : badge.summary}
                >
                  {GATE_MARKS[badge.status]} {badge.gate}
                  {badge.summary !== "" && <span className="dim"> · {badge.summary}</span>}
                </span>
              ))}
            </div>
          )}
        </header>

        {payload?.freshness === "stale" && (
          <p className="stalebanner">
            Evidence may be out of date: the branch tip is {payload.branchTip!.slice(0, 7)}, but the
            run's artifacts were persisted at {payload.artifactSha!.slice(0, 7)}.
          </p>
        )}
        {error && <p className="banner error">Can't load the review: {error}</p>}

        <nav className="stepper">
          {WIZARD_STEPS.map(({ key, label }, index) => (
            <button
              key={key}
              className={`stepchip${index === step ? " active" : ""}`}
              onClick={() => setStep(index)}
            >
              <span className="stepnum">{index + 1}</span> {label}
              {marks[key] && (
                <span className={`stepmarkchip mark-${marks[key].status}`}>
                  {GATE_MARKS[marks[key].status]}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="stepbody">
          {!payload && !error && <p className="dim">Loading review…</p>}
          {payload && stepKey === "recap" && (
            <RecapStep ticket={ticket} run={run} payload={payload} digest={digest} />
          )}
          {payload && stepKey === "dogfood" && <DogfoodStep ticket={ticket} run={run} />}
          {payload && stepKey === "pr" && <PrStep ticket={ticket} payload={payload} />}
          {payload && stepKey === "docs" && <DocsStep ticket={ticket} run={run} />}
          {payload && stepKey === "walkthrough" && (
            <WalkthroughStep
              ticket={ticket}
              run={run}
              digest={digestFresh}
              preview={preview}
              previewError={previewError}
              onSettled={refetch}
            />
          )}
          {payload && stepKey === "verdict" && (
            <VerdictStep
              ticket={ticket}
              payload={payload}
              marks={marks}
              busy={busy}
              drift={drift}
              actionError={actionError}
              onMerge={() => submitVerdict({ outcome: "pass" })}
              onForceMerge={() => submitVerdict({ outcome: "pass", force: true })}
              onReverify={() => submitVerdict({ outcome: "reverify" })}
              onFailReview={() => submitVerdict({ outcome: "fail", steps: verdictSteps(marks) })}
            />
          )}
        </div>

        {stepKey !== "verdict" && (
          <MarkBar
            mark={marks[stepKey]}
            onChange={(mark) => setMarks({ ...marks, [stepKey]: mark })}
          />
        )}

        <footer className="wizfoot">
          <button className="btn" onClick={() => setStep(step - 1)} disabled={step === 0}>
            ← Back
          </button>
          <span className="dim">
            Step {step + 1} of {WIZARD_STEPS.length}
          </span>
          <button
            className="btn"
            onClick={() => setStep(step + 1)}
            disabled={step === WIZARD_STEPS.length - 1}
          >
            Next →
          </button>
        </footer>
      </div>
    </>
  );
}

const MARK_LABELS: Record<GateStatus, string> = { pass: "Pass", fail: "Fail", skip: "Skip" };

/**
 * The reviewer's mark for the current step. Failing opens the note field —
 * the note becomes a Follow-up Criterion verbatim, so it is required, and
 * the Final Verdict refuses a fail verdict until it is written.
 */
function MarkBar({
  mark,
  onChange,
}: {
  mark: StepMark | undefined;
  onChange: (mark: StepMark) => void;
}) {
  return (
    <div className="markbar">
      <span className="dim">Mark this step:</span>
      {(["pass", "fail", "skip"] as const).map((status) => (
        <button
          key={status}
          className={`btn btn-sm markbtn mark-${status}${mark?.status === status ? " active" : ""}`}
          onClick={() => onChange({ status, note: mark?.note ?? "" })}
        >
          {GATE_MARKS[status]} {MARK_LABELS[status]}
        </button>
      ))}
      {mark?.status === "fail" && (
        <input
          className="marknote"
          type="text"
          value={mark.note}
          placeholder="Why this fails — becomes a follow-up criterion verbatim (required)"
          onChange={(event) => onChange({ status: "fail", note: event.target.value })}
        />
      )}
    </div>
  );
}

/** Fetch one artifact's raw content from the blob-store serving endpoint. */
function useArtifactText(artifactId: number): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({
    text: null,
    error: null,
  });
  useEffect(() => {
    let disposed = false;
    setState({ text: null, error: null });
    fetch(`${apiBase}/api/artifacts/${artifactId}/content`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET artifact content → ${res.status}`);
        const text = await res.text();
        if (!disposed) setState({ text, error: null });
      })
      .catch((e: unknown) => {
        if (!disposed) setState({ text: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      disposed = true;
    };
  }, [artifactId]);
  return state;
}

/** An absent artifact is stated, never a blank panel (ticket 32). */
function Placeholder({ label }: { label: string }) {
  return (
    <div className="placeholder">
      <p className="dim">{label}</p>
    </div>
  );
}

/** Fetch and parse the digest the payload points at; null until it lands. */
function useReviewDigest(payload: ReviewPayload | null): ReviewDigestContent | null {
  const artifactId = payload?.digest?.artifactId;
  const [content, setContent] = useState<ReviewDigestContent | null>(null);
  useEffect(() => {
    let disposed = false;
    setContent(null);
    if (artifactId === undefined) return;
    fetch(`${apiBase}/api/artifacts/${artifactId}/content`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET digest → ${res.status}`);
        const text = await res.text();
        if (!disposed) setContent(parseReviewDigest(text));
      })
      .catch(() => {
        // A digest that won't load is the raw-diff wizard, not an error wall.
      });
    return () => {
      disposed = true;
    };
  }, [artifactId]);
  return content;
}

/**
 * The review agent's findings (TRK-3), always wearing the agent chip — the
 * reviewer must never mistake pre-digested opinion for wizard chrome. A
 * stale digest states its invalidation and renders nothing else (AC-43);
 * a failed agent states why the wizard opened raw-diff (AC-42).
 */
function DigestPanel({
  payload,
  digest,
}: {
  payload: ReviewPayload;
  digest: ReviewDigestContent | null;
}) {
  if (payload.digestFailure !== null) {
    return (
      <p className="digestflag dim">
        <span className="agentchip">agent</span> Review agent failed — reviewing from raw evidence.
        ({payload.digestFailure})
      </p>
    );
  }
  if (payload.digest === null) return null;
  if (payload.digest.freshness === "stale") {
    return (
      <p className="digestflag dim">
        <span className="agentchip">agent</span> Digest invalidated: produced at{" "}
        {payload.digest.producedAtSha.slice(0, 7)}, but the branch has moved — review from the raw
        evidence.
      </p>
    );
  }
  if (!digest) return null;
  return (
    <section className="digest">
      <header className="digesthead">
        <span className="agentchip">agent digest</span>
        <span className="dim">
          produced at {payload.digest.producedAtSha.slice(0, 7)} — the verdict is still yours
        </span>
      </header>
      {digest.walkthrough.length > 0 && (
        <div className="digestsection">
          <h4>Read the diff in this order</h4>
          <ol>
            {digest.walkthrough.map((entry, index) => (
              <li key={index}>
                <code>{entry.file}</code> — {entry.note}
              </li>
            ))}
          </ol>
        </div>
      )}
      {digest.risks.length > 0 && (
        <div className="digestsection">
          <h4>Risk callouts</h4>
          <ul>
            {digest.risks.map((risk, index) => (
              <li key={index}>
                {risk.severity && <span className={`riskchip risk-${risk.severity}`}>{risk.severity}</span>}{" "}
                {risk.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RecapStep({
  ticket,
  run,
  payload,
  digest,
}: {
  ticket: TicketWithAcs;
  run: RunWithPhases | null;
  payload: ReviewPayload;
  digest: ReviewDigestContent | null;
}) {
  const artifact = findArtifact(run, RECAP_NAME);
  return (
    <div className="recapstep">
      <DigestPanel payload={payload} digest={digest} />
      {artifact ? (
        // Sandboxed exactly per ticket 11 §6: scripts may run for tabs and
        // interactions, but there is no same-origin access, and the serving
        // endpoint's CSP kills external loads even if the lint missed one.
        <iframe
          className="recapframe"
          src={`${apiBase}/api/artifacts/${artifact.id}/content`}
          sandbox="allow-scripts"
          title={`Visual recap for ${ticket.displayKey}`}
        />
      ) : (
        <Placeholder label={missingArtifactLabel(ticket, RECAP_NAME)} />
      )}
    </div>
  );
}

function DogfoodStep({ ticket, run }: { ticket: TicketWithAcs; run: RunWithPhases | null }) {
  const report = findArtifact(run, DOGFOOD_REPORT_NAME);
  const results = findArtifact(run, DOGFOOD_RESULTS_NAME);
  return (
    <div className="dogfoodstep">
      {report ? (
        <MarkdownArtifact artifactId={report.id} />
      ) : (
        <Placeholder label={missingArtifactLabel(ticket, DOGFOOD_REPORT_NAME)} />
      )}
      {results && (
        <DogfoodDecisions ticketId={ticket.id} artifactId={results.id} updatedAt={ticket.updatedAt} />
      )}
    </div>
  );
}

/**
 * The "Decisions for a human" surface (ticket 37): open questions the dogfood
 * phase parked never gate — they land here for the reviewer to answer, and each
 * answer is recorded in the Audit Trail. Prior answers are read back from the
 * trail so a reopened wizard shows what's already been decided.
 */
function DogfoodDecisions({
  ticketId,
  artifactId,
  updatedAt,
}: {
  ticketId: number;
  artifactId: number;
  updatedAt: string;
}) {
  const { text, error } = useArtifactText(artifactId);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const loadAnswers = useCallback(() => {
    apiGet<AuditEvent[]>(`/api/tickets/${ticketId}/audit`)
      .then((events) => {
        const latest: Record<string, string> = {};
        for (const event of events) {
          if (event.type !== "dogfood.decision_answered") continue;
          const id = event.detail.decisionId;
          const answer = event.detail.answer;
          if (typeof id === "string" && typeof answer === "string") latest[id] = answer;
        }
        setAnswered(latest);
      })
      .catch(() => {});
  }, [ticketId]);
  useEffect(loadAnswers, [loadAnswers, updatedAt]);

  // A broken or missing results file never breaks the step — the report above
  // stands on its own. Only real, parseable decisions render here.
  if (error) return null;
  if (text === null) return <p className="dim">Loading decisions…</p>;
  const decisions = parseDogfoodDecisions(text);
  if (decisions.length === 0) return null;

  const submit = async (decision: DogfoodDecision) => {
    const answer = (drafts[decision.id] ?? answered[decision.id] ?? "").trim();
    if (answer === "") return;
    setBusy(decision.id);
    setPostError(null);
    try {
      await apiPost(`/api/tickets/${ticketId}/dogfood-decisions`, {
        decisionId: decision.id,
        question: decision.observed,
        answer,
      });
      setAnswered({ ...answered, [decision.id]: answer });
      setDrafts({ ...drafts, [decision.id]: "" });
    } catch (e: unknown) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="decisions">
      <h4>Decisions for a human</h4>
      <p className="dim">
        These never block the merge — answer each one; your answer lands in the audit trail.
      </p>
      {decisions.map((decision) => (
        <div key={decision.id} className="decision">
          <p className="decision-observed">
            <span className="dim">{decision.id} · observed</span> {decision.observed}
          </p>
          {decision.options.length > 0 && (
            <ul className="decision-options">
              {decision.options.map((option, index) => (
                <li key={index}>
                  <strong>{option.label}</strong>
                  {option.cost !== "" && <span className="dim"> — {option.cost}</span>}
                </li>
              ))}
            </ul>
          )}
          {decision.recommendation !== "" && (
            <p className="decision-rec">
              <span className="dim">recommendation</span> {decision.recommendation}
            </p>
          )}
          {answered[decision.id] !== undefined && (
            <p className="decision-answered mark-pass">✓ answered: {answered[decision.id]}</p>
          )}
          <div className="decision-answer">
            <input
              className="marknote"
              type="text"
              value={drafts[decision.id] ?? answered[decision.id] ?? ""}
              placeholder="Your answer — recorded in the audit trail"
              onChange={(event) => setDrafts({ ...drafts, [decision.id]: event.target.value })}
            />
            <button className="btn" disabled={busy === decision.id} onClick={() => void submit(decision)}>
              Record answer
            </button>
          </div>
        </div>
      ))}
      {postError && <p className="error">{postError}</p>}
    </div>
  );
}

function MarkdownArtifact({ artifactId }: { artifactId: number }) {
  const { text, error } = useArtifactText(artifactId);
  if (error) return <p className="error">{error}</p>;
  if (text === null) return <p className="dim">Loading…</p>;
  return <Markdown text={text} />;
}

const MERGEABILITY_LABELS = {
  mergeable: "✓ mergeable into the target branch",
  conflicting: "✗ conflicts with the target branch",
  unknown: "mergeability unknown — GitHub is still computing (or no backing configured)",
} as const;

function PrStep({ ticket, payload }: { ticket: TicketWithAcs; payload: ReviewPayload }) {
  if (!payload.pr) {
    return (
      <Placeholder
        label={absenceLabel(ticket, "No PR recorded", "No PR recorded for this ticket")}
      />
    );
  }
  return (
    <div className="prstep">
      <p>
        <a href={payload.pr.url} target="_blank" rel="noreferrer">
          PR #{payload.pr.number}
        </a>{" "}
        <span className="dim">{payload.pr.url}</span>
      </p>
      <p className={`merge-${payload.pr.mergeability}`}>
        {MERGEABILITY_LABELS[payload.pr.mergeability]}
      </p>
    </div>
  );
}

function DocsStep({ ticket, run }: { ticket: TicketWithAcs; run: RunWithPhases | null }) {
  const artifacts = docsArtifacts(run);
  if (artifacts.length === 0) {
    return (
      <Placeholder
        label={absenceLabel(ticket, "No artifacts persisted", "No artifacts persisted by this run")}
      />
    );
  }
  return (
    <ul className="doclist">
      {artifacts.map((artifact) => (
        <DocRow key={artifact.id} artifact={artifact} />
      ))}
    </ul>
  );
}

function DocRow({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="docrow" onClick={() => setOpen(!open)}>
        <span className="disclosure dim">{open ? "▾" : "▸"}</span>
        <span className="artifactkind dim">{artifact.kind}</span>
        <span>{artifact.name}</span>
        <span className="dim" title={`worktree HEAD ${artifact.worktreeHeadSha}`}>
          {artifact.contentHash.slice(0, 7)}
        </span>
      </button>
      {open && <DocPreview artifact={artifact} />}
    </li>
  );
}

function DocPreview({ artifact }: { artifact: Artifact }) {
  const { text, error } = useArtifactText(artifact.id);
  if (error) return <p className="error">{error}</p>;
  if (text === null) return <p className="dim">Loading…</p>;
  if (artifact.name.endsWith(".md")) return <Markdown text={text} />;
  return <pre className="docraw">{text}</pre>;
}

export interface PreviewController {
  view: PreviewView | null;
  busy: boolean;
  restart: () => Promise<void>;
}

/**
 * The wizard's preview lifecycle (ticket 34): the process starts on demand
 * when the wizard opens on a configured repo — not when the reviewer reaches
 * the walkthrough, so readiness has the earlier steps to settle in — and the
 * view refreshes on a short poll (readiness lands server-side in the
 * background; only the record knows when). Start/restart answers update the
 * view immediately.
 */
function usePreview(ticketId: number, onError: (message: string) => void): PreviewController {
  const [view, setView] = useState<PreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      apiGet<PreviewView>(`/api/tickets/${ticketId}/preview`)
        .then((data) => {
          if (disposed) return;
          setView(data);
          const status = data.record?.status;
          if (data.configured && !autoStarted.current && status !== "starting" && status !== "ready") {
            autoStarted.current = true;
            apiPost<PreviewView>(`/api/tickets/${ticketId}/preview/start`, {})
              .then((started) => !disposed && setView(started))
              .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
          }
        })
        .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [ticketId, onError]);

  const restart = async () => {
    setBusy(true);
    try {
      setView(await apiPost<PreviewView>(`/api/tickets/${ticketId}/preview/restart`, {}));
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return { view, busy, restart };
}

const PREVIEW_STATUS_LABELS = {
  starting: "starting…",
  ready: "ready",
  failed: "failed",
  stopped: "stopped",
} as const;

function PreviewGate({
  ticket,
  run,
  preview,
  error,
}: {
  ticket: TicketWithAcs;
  run: RunWithPhases | null;
  preview: PreviewController;
  error: string | null;
}) {
  const { view, busy, restart } = preview;
  if (!view) return <p className="dim">Loading preview…</p>;
  if (!view.configured) {
    return (
      <p className="dim">
        No preview configured for this repo — walk the change by hand, leaning on the demo and the
        diff.
      </p>
    );
  }
  const status = view.record?.status ?? "stopped";
  const transcript = view.kind === "api" ? demoTranscriptArtifact(run) : null;
  const video = view.kind === "ui" ? demoVideoArtifact(run) : null;
  return (
    <div className="previewpanel">
      <div className="previewrow">
        <span className={`previewstatus preview-${status}`}>
          preview {PREVIEW_STATUS_LABELS[status]}
        </span>
        {view.record !== null && view.record.port !== null && (
          <span className="dim">port {view.record.port}</span>
        )}
        {view.url && (
          <a href={view.url} target="_blank" rel="noreferrer" title="Opens in your browser">
            {view.url} ↗
          </a>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={() => void restart()}>
          {status === "ready" || status === "starting" ? "Restart" : "Start"}
        </button>
      </div>
      {view.kind === "ui" &&
        (video ? (
          // The run's recorded demo (ticket 35), played straight from the
          // artifact blob — evidence of the change working, beside the live
          // preview link.
          <video
            controls
            src={`${apiBase}/api/artifacts/${video.id}/content`}
            style={{ maxWidth: "100%" }}
          />
        ) : (
          <p className="dim">
            {absenceLabel(
              ticket,
              "No demo video recorded",
              "No demo video recorded for this run",
            )}
          </p>
        ))}
      {view.kind === "api" && (
        <>
          {view.url && (
            <p className="dim">
              API preview — base URL <code>{view.url}</code>
            </p>
          )}
          {transcript ? (
            <DocPreview artifact={transcript} />
          ) : (
            <p className="dim">
              {absenceLabel(
                ticket,
                "No curl transcript recorded",
                "No curl transcript recorded for this run",
              )}
            </p>
          )}
        </>
      )}
      {status === "failed" && view.logTail !== null && (
        <pre className="previewlog">{view.logTail}</pre>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function WalkthroughStep({
  ticket,
  run,
  digest,
  preview,
  previewError,
  onSettled,
}: {
  ticket: TicketWithAcs;
  run: RunWithPhases | null;
  /** Fresh digest only — stale findings never pre-fill (AC-43). */
  digest: ReviewDigestContent | null;
  preview: PreviewController;
  previewError: string | null;
  onSettled: () => void;
}) {
  const items = walkthroughItems(ticket);
  return (
    <div className="walkthrough">
      <PreviewGate ticket={ticket} run={run} preview={preview} error={previewError} />
      <p className="dim">
        Walk the change, then settle each criterion: verify and fail land with human provenance; a
        failed AC resets to pending on the next run.
      </p>
      {items.length === 0 && <p className="dim">No acceptance criteria filed.</p>}
      <ul className="aclist">
        {items.map(({ criterion, humanReason }) => (
          <li key={criterion.id}>
            <span className={`dot dot-${criterion.status}`} title={criterion.status} />
            <span>
              {criterion.text}
              {(() => {
                // The digest's AC-to-code mapping pre-fills the item (TRK-3),
                // chip-marked: agent findings, never wizard chrome.
                const entry = digestForAc(digest, criterion.id);
                return entry === null ? null : (
                  <span className="acdigest dim">
                    <span className="agentchip">agent</span> {entry.note}
                    {entry.files.length > 0 && <code> ({entry.files.join(", ")})</code>}
                  </span>
                );
              })()}
            </span>
            <em className="dim">
              {criterion.status}
              {criterion.provenance && ` · ${criterion.provenance}`}
              {humanReason && ` · routed to human: ${humanReason}`}
            </em>
            <span className="acactions">
              <button
                className="btn btn-sm"
                disabled={criterion.status === "verified" && criterion.provenance === "human"}
                onClick={() => settleAc(`/api/acs/${criterion.id}/verify`, {}, onSettled)}
              >
                ✓ verify
              </button>
              <button
                className="btn btn-sm"
                disabled={criterion.status === "failed" && criterion.provenance === "human"}
                onClick={() => settleAc(`/api/acs/${criterion.id}/fail`, {}, onSettled)}
              >
                ✗ fail
              </button>
              <button
                className="btn btn-sm"
                disabled={criterion.status === "waived"}
                onClick={() => waiveWithPrompt(criterion, onSettled)}
              >
                waive…
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerdictStep({
  ticket,
  payload,
  marks,
  busy,
  drift,
  actionError,
  onMerge,
  onForceMerge,
  onReverify,
  onFailReview,
}: {
  ticket: TicketWithAcs;
  payload: ReviewPayload;
  marks: ReviewMarks;
  busy: boolean;
  drift: string[] | null;
  actionError: string | null;
  onMerge: () => void;
  onForceMerge: () => void;
  onReverify: () => void;
  onFailReview: () => void;
}) {
  const badges = badgeRow(payload.run);
  const count = (status: GateStatus) => badges.filter((badge) => badge.status === status).length;
  const acs = ticket.acceptanceCriteria;
  const acCount = (status: AcStatus) => acs.filter((ac) => ac.status === status).length;
  const blockers = mergeProblems(ticket, marks);
  const failProblems = failVerdictProblems(marks, ticket);
  return (
    <div className="verdictstep">
      <ul className="verdictsummary">
        <li>
          Gates: {count("pass")} pass · {count("fail")} fail · {count("skip")} n/a
        </li>
        <li>
          Acceptance criteria: {acCount("verified") + acCount("waived")} of {acs.length} settled (
          {acCount("verified")} verified · {acCount("waived")} waived · {acCount("pending")} pending
          · {acCount("failed")} failed)
        </li>
        <li>
          PR:{" "}
          {payload.pr
            ? `#${payload.pr.number} — ${payload.pr.mergeability}`
            : "none recorded"}
        </li>
        <li>Evidence freshness: {payload.freshness}</li>
      </ul>

      <h4>Step marks</h4>
      <ul className="marksummary">
        {MARKABLE_STEPS.map(({ key, label }) => {
          const mark = marks[key];
          return (
            <li key={key} className={mark ? `mark-${mark.status}` : "dim"}>
              {mark ? GATE_MARKS[mark.status] : "·"} {label}
              {mark?.status === "fail" && mark.note.trim() !== "" && (
                <span className="dim"> — {mark.note}</span>
              )}
            </li>
          );
        })}
      </ul>

      {blockers.length > 0 && (
        <div className="verdictblockers">
          <h4>Before a merge</h4>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {drift !== null && (
        <div className="driftpanel">
          <h4>The evidence drifted since this review</h4>
          <ul>
            {drift.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="verdictactions">
            <button className="btn btn-danger" disabled={busy} onClick={onReverify}>
              Re-verify — bounce for a fresh run
            </button>
            <button className="btn btn-warn" disabled={busy} onClick={onForceMerge}>
              Force merge — waive the drift (audited)
            </button>
          </div>
        </div>
      )}

      {actionError && <p className="error">{actionError}</p>}

      {drift === null && (
        <div className="verdictactions">
          <button
            className="btn btn-danger"
            disabled={busy || failProblems.length > 0}
            title={failProblems.join("; ")}
            onClick={onFailReview}
          >
            Fail review — bounce with notes
          </button>
          <button
            className="btn btn-ok"
            disabled={busy || blockers.length > 0}
            title={blockers.join("; ")}
            onClick={onMerge}
          >
            Merge &amp; Done
          </button>
        </div>
      )}
    </div>
  );
}
