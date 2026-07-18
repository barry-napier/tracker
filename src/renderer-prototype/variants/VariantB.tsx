// PROTOTYPE — throwaway. Variant B: "Split workspace".
// Left: ticket list grouped by state (no columns). Center: persistent detail
// pane. Right: live rail (agent log of selection). Wizard = full-screen
// takeover with a left vertical step nav.
import React, { useState } from "react";
import type { TicketSnapshot } from "../events";
import { useFactory } from "../fakeStream";
import { PROVIDER_LABELS, STATES } from "../fixtures";
import {
  AcList, AuditFeed, LogBlockView, ProviderPicker, StateBadge, StepBody,
  StepDecision, VerdictSummary, WIZARD_STEPS, WizardMeta, ticketRun,
  useTickets, useWizard,
} from "../shared";

export const name = "Split workspace — persistent detail + takeover wizard";

export default function VariantB() {
  const { list, create, promote } = useTickets();
  const [selectedId, setSelectedId] = useState<string>("TRK-21");
  const [reviewing, setReviewing] = useState(false);
  const [draft, setDraft] = useState("");
  const factory = useFactory();
  const selected = list.find((t) => t.id === selectedId) ?? list[0];
  const run = ticketRun(selected);

  if (reviewing) return <TakeoverWizard t={selected} onClose={() => setReviewing(false)} />;

  return (
    <div className="vb">
      <aside className="vb-list">
        <div className="vb-newrow">
          <input
            placeholder="+ File a ticket"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (create(draft), setDraft(""))}
          />
        </div>
        {STATES.map(({ key, label }) => {
          const group = list.filter((t) => t.state === key);
          if (!group.length) return null;
          return (
            <div key={key} className="vb-group">
              <h4 style={{ color: undefined }}>{label} <span className="dim">{group.length}</span></h4>
              {group.map((t) => (
                <button
                  key={t.id}
                  className={`vb-row ${t.id === selected.id ? "on" : ""}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className="dim">{t.id}</span> {t.title}
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <main className="vb-detail">
        <header>
          <h2>{selected.id} — {selected.title}</h2>
          <StateBadge state={selected.state} />
          {selected.state === "backlog" && (
            <span className="vb-promote">
              promote: <ProviderPicker value={null} onChange={(p) => promote(selected.id, p)} />
            </span>
          )}
          {selected.state === "human_review" && (
            <button className="reviewbtn" onClick={() => setReviewing(true)}>Start review →</button>
          )}
        </header>
        <div className="props">
          <span>Repo: claims-app</span>
          <span>Provider: {selected.provider ? PROVIDER_LABELS[selected.provider] : "—"}</span>
          <span>Run: {selected.currentRunId ?? "—"}</span>
          {run?.prNumber && <span>PR #{run.prNumber}</span>}
        </div>
        <h4>Description</h4>
        <p className="dim">As filed. Lorem for prototype purposes — the real description renders markdown.</p>
        <h4>Acceptance criteria</h4>
        <AcList ticketId={selected.id} />
        <h4>Artifacts</h4>
        <ul className="artifacts">
          {(run?.artifacts ?? []).map((a) => <li key={a.name}>{a.name} <span className="dim">@{a.sha}</span></li>)}
          {!run?.artifacts.length && <li className="dim">None yet.</li>}
        </ul>
        <h4>Activity</h4>
        <AuditFeed ticketId={selected.id} />
      </main>

      <aside className="vb-live">
        <h4>Agent log {run && factory.logs[run.id]?.length ? "· live" : ""}</h4>
        <div className="logscroll tall">
          {(factory.logs[run?.id ?? ""] ?? []).map((b) => <LogBlockView key={b.blockId} b={b} />)}
          {!factory.logs[run?.id ?? ""]?.length && <p className="dim">No live run for this ticket.</p>}
        </div>
      </aside>
    </div>
  );
}

function TakeoverWizard({ t, onClose }: { t: TicketSnapshot; onClose: () => void }) {
  const w = useWizard();
  const run = ticketRun(t)!;
  return (
    <div className="vb-takeover">
      <aside className="vb-steps">
        <button className="close" onClick={onClose}>← Exit review</button>
        {WIZARD_STEPS.map((s, i) => (
          <button key={s} className={`vstep ${i === w.step ? "on" : ""} hs-${w.outcomes[i] ?? "todo"}`} onClick={() => w.setStep(i)}>
            <span className="stepnum">{i + 1}</span>
            <span>{s}</span>
            <em className="dim">{w.outcomes[i] ?? ""}</em>
          </button>
        ))}
      </aside>
      <main className="vb-stepbody">
        <WizardMeta ticket={t} run={run} />
        <div className="vb-stepcontent">
          {w.step < 5 ? <StepBody i={w.step} ticket={t} run={run} /> : <VerdictSummary w={w} />}
        </div>
        {w.step < 5 && (
          <footer className="vb-stepfoot">
            <StepDecision w={w} i={w.step} />
            <button disabled={!w.canAdvance(w.step)} onClick={() => w.setStep(w.step + 1)}>
              Next: {WIZARD_STEPS[w.step + 1]} →
            </button>
          </footer>
        )}
      </main>
    </div>
  );
}
