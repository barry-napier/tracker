import { useCallback, useEffect, useState } from "react";
import type { ReviewPayload } from "../server/reviews.ts";
import type {
  AcStatus,
  Artifact,
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
  docsArtifacts,
  DOGFOOD_REPORT_NAME,
  failVerdictProblems,
  findArtifact,
  MARKABLE_STEPS,
  mergeProblems,
  missingArtifactLabel,
  RECAP_NAME,
  verdictSteps,
  walkthroughItems,
  WIZARD_STEPS,
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
        <button className="close" onClick={onClose} aria-label="Close">
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
          {payload && stepKey === "recap" && <RecapStep ticket={ticket} run={run} />}
          {payload && stepKey === "dogfood" && <DogfoodStep ticket={ticket} run={run} />}
          {payload && stepKey === "pr" && <PrStep ticket={ticket} payload={payload} />}
          {payload && stepKey === "docs" && <DocsStep ticket={ticket} run={run} />}
          {payload && stepKey === "walkthrough" && (
            <WalkthroughStep ticket={ticket} onSettled={refetch} />
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
          <button onClick={() => setStep(step - 1)} disabled={step === 0}>
            ← Back
          </button>
          <span className="dim">
            Step {step + 1} of {WIZARD_STEPS.length}
          </span>
          <button onClick={() => setStep(step + 1)} disabled={step === WIZARD_STEPS.length - 1}>
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
          className={`markbtn mark-${status}${mark?.status === status ? " active" : ""}`}
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

function RecapStep({ ticket, run }: { ticket: TicketWithAcs; run: RunWithPhases | null }) {
  const artifact = findArtifact(run, RECAP_NAME);
  if (!artifact) return <Placeholder label={missingArtifactLabel(ticket, RECAP_NAME)} />;
  // Sandboxed exactly per ticket 11 §6: scripts may run for tabs and
  // interactions, but there is no same-origin access, and the serving
  // endpoint's CSP kills external loads even if the lint missed one.
  return (
    <iframe
      className="recapframe"
      src={`${apiBase}/api/artifacts/${artifact.id}/content`}
      sandbox="allow-scripts"
      title={`Visual recap for ${ticket.displayKey}`}
    />
  );
}

function DogfoodStep({ ticket, run }: { ticket: TicketWithAcs; run: RunWithPhases | null }) {
  const artifact = findArtifact(run, DOGFOOD_REPORT_NAME);
  if (!artifact) return <Placeholder label={missingArtifactLabel(ticket, DOGFOOD_REPORT_NAME)} />;
  return <MarkdownArtifact artifactId={artifact.id} />;
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

function WalkthroughStep({
  ticket,
  onSettled,
}: {
  ticket: TicketWithAcs;
  onSettled: () => void;
}) {
  const items = walkthroughItems(ticket);
  return (
    <div className="walkthrough">
      <p className="dim">
        No preview configured — preview environments arrive in a later slice. Walk the change by
        hand, then settle each criterion: verify and fail land with human provenance; a failed AC
        resets to pending on the next run.
      </p>
      {items.length === 0 && <p className="dim">No acceptance criteria filed.</p>}
      <ul className="aclist">
        {items.map(({ criterion, humanReason }) => (
          <li key={criterion.id}>
            <span className={`dot dot-${criterion.status}`} title={criterion.status} />
            <span>{criterion.text}</span>
            <em className="dim">
              {criterion.status}
              {criterion.provenance && ` · ${criterion.provenance}`}
              {humanReason && ` · routed to human: ${humanReason}`}
            </em>
            <span className="acactions">
              <button
                disabled={criterion.status === "verified" && criterion.provenance === "human"}
                onClick={() => settleAc(`/api/acs/${criterion.id}/verify`, {}, onSettled)}
              >
                ✓ verify
              </button>
              <button
                disabled={criterion.status === "failed" && criterion.provenance === "human"}
                onClick={() => settleAc(`/api/acs/${criterion.id}/fail`, {}, onSettled)}
              >
                ✗ fail
              </button>
              <button
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
            <button className="danger" disabled={busy} onClick={onReverify}>
              Re-verify — bounce for a fresh run
            </button>
            <button className="warn" disabled={busy} onClick={onForceMerge}>
              Force merge — waive the drift (audited)
            </button>
          </div>
        </div>
      )}

      {actionError && <p className="error">{actionError}</p>}

      {drift === null && (
        <div className="verdictactions">
          <button
            className="danger"
            disabled={busy || failProblems.length > 0}
            title={failProblems.join("; ")}
            onClick={onFailReview}
          >
            Fail review — bounce with notes
          </button>
          <button
            className="ok"
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
