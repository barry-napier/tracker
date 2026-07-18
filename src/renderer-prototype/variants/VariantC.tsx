// PROTOTYPE — throwaway. Variant C: "Factory console".
// Top: three worker lanes with live phase + log tail (the factory is the hero).
// Middle: compact board strip. Bottom: selected-ticket dossier with tabs.
// Wizard = right-docked panel; the console stays visible while reviewing.
import React, { useState } from "react";
import type { TicketSnapshot } from "../events";
import { useFactory } from "../fakeStream";
import { PHASES, PROVIDER_LABELS, STATES } from "../fixtures";
import {
  AcList, AuditFeed, LogBlockView, ProviderPicker, StateBadge, StepBody,
  StepDecision, VerdictSummary, WIZARD_STEPS, WizardMeta, ticketRun,
  useTickets, useWizard,
} from "../shared";

export const name = "Factory console — worker lanes + docked wizard";

const TABS = ["Overview", "Criteria", "Agent log", "Artifacts", "Activity"] as const;

export default function VariantC() {
  const { list, create, promote } = useTickets();
  const [selectedId, setSelectedId] = useState<string | null>("TRK-25");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [reviewing, setReviewing] = useState<TicketSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const factory = useFactory();
  const selected = list.find((t) => t.id === selectedId) ?? null;
  const run = selected ? ticketRun(selected) : undefined;

  const workers = [
    { id: 1, runId: "run-25a", ticket: list.find((t) => t.id === "TRK-25") },
    { id: 2, runId: "run-26a", ticket: list.find((t) => t.id === "TRK-26") },
    { id: 3, runId: null, ticket: undefined },
  ];

  return (
    <div className={`vc ${reviewing ? "vc-docked" : ""}`}>
      <div className="vc-main">
        <section className="vc-workers">
          {workers.map((wk) => {
            const blocks = wk.runId ? factory.logs[wk.runId] ?? [] : [];
            const phase = wk.runId ? factory.phases[wk.runId] : null;
            return (
              <article key={wk.id} className={`vc-lane ${wk.ticket ? "" : "idle"}`}
                onClick={() => wk.ticket && setSelectedId(wk.ticket.id)}>
                <header>
                  <b>Worker {wk.id}</b>
                  {wk.ticket ? (
                    <>
                      <span>{wk.ticket.id} · {PROVIDER_LABELS[wk.ticket.provider!]}</span>
                      <span className="phasebar">
                        {PHASES.map((p) => <span key={p} className={`ph ${p === phase ? "ph-on" : ""}`} title={p} />)}
                        <em className="dim">{phase}</em>
                      </span>
                    </>
                  ) : (
                    <span className="dim">idle — waiting for Todo</span>
                  )}
                </header>
                <div className="vc-lanetail">
                  {blocks.slice(-3).map((b) => <LogBlockView key={b.blockId} b={b} />)}
                </div>
              </article>
            );
          })}
        </section>

        <section className="vc-strip">
          {STATES.map(({ key, label }) => (
            <div key={key} className="vc-stripcol">
              <h4>{label} <span className="dim">{list.filter((t) => t.state === key).length}</span></h4>
              {key === "backlog" && (
                <input
                  className="vc-new"
                  placeholder="+ new"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (create(draft), setDraft(""))}
                />
              )}
              {list.filter((t) => t.state === key).map((t) => (
                <button key={t.id} className={`vc-chip ${t.id === selectedId ? "on" : ""}`} onClick={() => setSelectedId(t.id)}>
                  {t.id}
                  {t.state === "human_review" && <em onClick={(e) => { e.stopPropagation(); setReviewing(t); }}> review→</em>}
                </button>
              ))}
            </div>
          ))}
        </section>

        {selected && (
          <section className="vc-dossier">
            <header>
              <h2>{selected.id} — {selected.title}</h2>
              <StateBadge state={selected.state} />
              {selected.state === "backlog" && <ProviderPicker value={null} onChange={(p) => promote(selected.id, p)} />}
              {selected.state === "human_review" && (
                <button className="reviewbtn" onClick={() => setReviewing(selected)}>Review →</button>
              )}
            </header>
            <nav className="vc-tabs">
              {TABS.map((tb) => (
                <button key={tb} className={tb === tab ? "on" : ""} onClick={() => setTab(tb)}>{tb}</button>
              ))}
            </nav>
            <div className="vc-tabbody">
              {tab === "Overview" && (
                <>
                  <div className="props">
                    <span>Repo: claims-app</span>
                    <span>Provider: {selected.provider ? PROVIDER_LABELS[selected.provider] : "—"}</span>
                    <span>Run: {selected.currentRunId ?? "—"}</span>
                    {run?.prNumber && <span>PR #{run.prNumber}</span>}
                  </div>
                  <p className="dim">As filed. Lorem for prototype purposes — the real description renders markdown.</p>
                </>
              )}
              {tab === "Criteria" && <AcList ticketId={selected.id} />}
              {tab === "Agent log" && (
                <div className="logscroll">
                  {(factory.logs[selected.currentRunId ?? ""] ?? []).map((b) => <LogBlockView key={b.blockId} b={b} />)}
                  {!factory.logs[selected.currentRunId ?? ""]?.length && <p className="dim">No live run.</p>}
                </div>
              )}
              {tab === "Artifacts" && (
                <ul className="artifacts">
                  {(run?.artifacts ?? []).map((a) => <li key={a.name}>{a.name} <span className="dim">@{a.sha}</span></li>)}
                  {!run?.artifacts.length && <li className="dim">None yet.</li>}
                </ul>
              )}
              {tab === "Activity" && <AuditFeed ticketId={selected.id} />}
            </div>
          </section>
        )}
      </div>

      {reviewing && <DockedWizard t={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function DockedWizard({ t, onClose }: { t: TicketSnapshot; onClose: () => void }) {
  const w = useWizard();
  const run = ticketRun(t)!;
  return (
    <aside className="vc-wizard">
      <header>
        <b>Review {t.id}</b>
        <button className="close" onClick={onClose}>✕</button>
      </header>
      <WizardMeta ticket={t} run={run} />
      <nav className="vc-checklist">
        {WIZARD_STEPS.map((s, i) => (
          <button key={s} className={`vstep ${i === w.step ? "on" : ""} hs-${w.outcomes[i] ?? "todo"}`} onClick={() => w.setStep(i)}>
            <span className="stepnum">{w.outcomes[i] === "pass" ? "✓" : w.outcomes[i] === "fail" ? "✗" : w.outcomes[i] === "skip" ? "–" : i + 1}</span>
            {s}
          </button>
        ))}
      </nav>
      <div className="vc-wizbody">
        {w.step < 5 ? <StepBody i={w.step} ticket={t} run={run} /> : <VerdictSummary w={w} />}
      </div>
      {w.step < 5 && (
        <footer className="vc-wizfoot">
          <StepDecision w={w} i={w.step} />
          <button disabled={!w.canAdvance(w.step)} onClick={() => w.setStep(w.step + 1)}>Next →</button>
        </footer>
      )}
    </aside>
  );
}
