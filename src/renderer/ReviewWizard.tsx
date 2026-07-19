import { useEffect, useState } from "react";
import type { ReviewPayload } from "../server/reviews.ts";
import type {
  AcStatus,
  Artifact,
  GateStatus,
  RunWithPhases,
  TicketWithAcs,
} from "../server/types.ts";
import { apiBase, apiGet } from "./api.ts";
import { GATE_MARKS } from "./format.ts";
import { Markdown } from "./Markdown.tsx";
import {
  absenceLabel,
  badgeRow,
  docsArtifacts,
  DOGFOOD_REPORT_NAME,
  findArtifact,
  missingArtifactLabel,
  RECAP_NAME,
  walkthroughItems,
  WIZARD_STEPS,
} from "./reviewModel.ts";

/**
 * The six-step review wizard as a centered modal (ticket 12, Variant A),
 * read-only in this slice — verdict actions land with slice 33. Chrome (meta
 * header, badge row, stale banner) renders live from ticket/run/gate data;
 * only the step bodies show agent-authored artifacts, and those come from
 * the blob store of the latest Run.
 */
export function ReviewWizard({ ticket, onClose }: { ticket: TicketWithAcs; onClose: () => void }) {
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  // Refetch whenever the board's live ticket row moves (waives, gate
  // results, bounces all bump updatedAt) so chrome stays drawn from the DB.
  useEffect(() => {
    let disposed = false;
    apiGet<ReviewPayload>(`/api/tickets/${ticket.id}/review`)
      .then((data) => {
        if (disposed) return;
        setPayload(data);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
    };
  }, [ticket.id, ticket.updatedAt]);

  const run = payload?.run ?? null;
  const badges = badgeRow(run);
  const stepKey = WIZARD_STEPS[step]!.key;

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
            </button>
          ))}
        </nav>

        <div className="stepbody">
          {!payload && !error && <p className="dim">Loading review…</p>}
          {payload && stepKey === "recap" && <RecapStep ticket={ticket} run={run} />}
          {payload && stepKey === "dogfood" && <DogfoodStep ticket={ticket} run={run} />}
          {payload && stepKey === "pr" && <PrStep ticket={ticket} payload={payload} />}
          {payload && stepKey === "docs" && <DocsStep ticket={ticket} run={run} />}
          {payload && stepKey === "walkthrough" && <WalkthroughStep ticket={ticket} />}
          {payload && stepKey === "verdict" && <VerdictStep ticket={ticket} payload={payload} />}
        </div>

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

function WalkthroughStep({ ticket }: { ticket: TicketWithAcs }) {
  const items = walkthroughItems(ticket);
  return (
    <div className="walkthrough">
      <p className="dim">
        No preview configured — preview environments arrive in a later slice, so the walkthrough is
        a read-only checklist for now.
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
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerdictStep({ ticket, payload }: { ticket: TicketWithAcs; payload: ReviewPayload }) {
  const badges = badgeRow(payload.run);
  const count = (status: GateStatus) => badges.filter((badge) => badge.status === status).length;
  const acs = ticket.acceptanceCriteria;
  const acCount = (status: AcStatus) => acs.filter((ac) => ac.status === status).length;
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
      <p className="dim">
        This wizard is read-only — pass/fail verdicts (merge or bounce) land with the next slice.
      </p>
    </div>
  );
}
