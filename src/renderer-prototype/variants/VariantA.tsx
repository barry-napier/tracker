// PROTOTYPE — throwaway. Variant A: "Kanban classic".
// Full-width six-column board · ticket detail = right slide-over drawer ·
// review wizard = centered modal with a horizontal stepper.
import React, { useState } from "react";
import type { TicketSnapshot } from "../events";
import { useFactory } from "../fakeStream";
import { PHASES, PROVIDER_LABELS, STATES } from "../fixtures";
import {
  AcList, AuditFeed, LogBlockView, ProviderPicker, StateBadge, StepBody,
  StepDecision, VerdictSummary, WIZARD_STEPS, WizardMeta, ticketRun,
  useTickets, useWizard,
} from "../shared";

export const name = "Kanban classic — drawer + modal wizard";

export default function VariantA() {
  const { list, create, promote } = useTickets();
  const [selected, setSelected] = useState<TicketSnapshot | null>(null);
  const [reviewing, setReviewing] = useState<TicketSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const factory = useFactory();

  return (
    <div className="va">
      <header className="va-top">
        <b>Tracker</b> <span className="dim">/ Claims App</span>
        <span className="spacer" />
        <span className="dim">3 workers · 2 running</span>
      </header>
      <div className="va-board">
        {STATES.map(({ key, label }) => (
          <section key={key} className="va-col">
            <h3>
              {label} <span className="dim">{list.filter((t) => t.state === key).length}</span>
            </h3>
            {key === "backlog" && (
              <div className="va-new">
                <input
                  placeholder="+ New ticket"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (create(draft), setDraft(""))}
                />
              </div>
            )}
            {list.filter((t) => t.state === key).map((t) => {
              const run = ticketRun(t);
              const phase = run ? factory.phases[run.id] ?? run.phase : null;
              return (
                <article key={t.id} className="card" onClick={() => setSelected(t)}>
                  <span className="dim">{t.id}</span>
                  <p>{t.title}</p>
                  {t.provider && <em className="dim">{PROVIDER_LABELS[t.provider]}</em>}
                  {t.state === "in_progress" && phase && (
                    <div className="phasebar">
                      {PHASES.map((p) => (
                        <span key={p} className={`ph ${p === phase ? "ph-on" : ""}`} title={p} />
                      ))}
                      <em className="dim">{phase}</em>
                    </div>
                  )}
                  {t.state === "backlog" && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <ProviderPicker value={null} onChange={(p) => promote(t.id, p)} />
                    </div>
                  )}
                  {t.state === "human_review" && (
                    <button className="reviewbtn" onClick={(e) => { e.stopPropagation(); setReviewing(t); }}>
                      Review →
                    </button>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      {selected && (
        <aside className="va-drawer">
          <button className="close" onClick={() => setSelected(null)}>✕</button>
          <h2>{selected.id} — {selected.title}</h2>
          <StateBadge state={selected.state} />
          <h4>Properties</h4>
          <div className="props">
            <span>Repo: claims-app</span>
            <span>Provider: <ProviderPicker value={selected.provider} /></span>
            <span>Run: {selected.currentRunId ?? "—"}</span>
          </div>
          <h4>Description</h4>
          <p className="dim">As filed. Lorem for prototype purposes — the real description renders markdown.</p>
          <h4>Acceptance criteria</h4>
          <AcList ticketId={selected.id} />
          <h4>Agent log {selected.currentRunId && factory.logs[selected.currentRunId] ? "· live" : ""}</h4>
          <div className="logscroll">
            {(factory.logs[selected.currentRunId ?? ""] ?? []).map((b) => <LogBlockView key={b.blockId} b={b} />)}
            {!factory.logs[selected.currentRunId ?? ""]?.length && <p className="dim">No live run.</p>}
          </div>
          <h4>Artifacts</h4>
          <ul className="artifacts">
            {(ticketRun(selected)?.artifacts ?? []).map((a) => <li key={a.name}>{a.name} <span className="dim">@{a.sha}</span></li>)}
          </ul>
          <h4>Activity</h4>
          <AuditFeed ticketId={selected.id} />
        </aside>
      )}

      {reviewing && <ModalWizard t={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function ModalWizard({ t, onClose }: { t: TicketSnapshot; onClose: () => void }) {
  const w = useWizard();
  const run = ticketRun(t)!;
  return (
    <div className="modalveil" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <WizardMeta ticket={t} run={run} />
        <nav className="hstepper">
          {WIZARD_STEPS.map((s, i) => (
            <button key={s} className={`hstep ${i === w.step ? "on" : ""} hs-${w.outcomes[i] ?? "todo"}`} onClick={() => w.setStep(i)}>
              <span className="stepnum">{i + 1}</span> {s}
            </button>
          ))}
        </nav>
        <div className="modalbody">
          {w.step < 5 ? <StepBody i={w.step} ticket={t} run={run} /> : <VerdictSummary w={w} />}
        </div>
        <footer className="modalfoot">
          {w.step < 5 && <StepDecision w={w} i={w.step} />}
          <span className="spacer" />
          <button disabled={w.step === 0} onClick={() => w.setStep(w.step - 1)}>← Back</button>
          {w.step < 5 && (
            <button disabled={!w.canAdvance(w.step)} onClick={() => w.setStep(w.step + 1)}>Next →</button>
          )}
        </footer>
      </div>
    </div>
  );
}
