import { useEffect, useState } from "react";
import type { Artifact, RunWithPhases, TicketWithAcs } from "../server/types.ts";
import { apiBase } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { Icon } from "./icons.tsx";

/**
 * Full-screen artifact viewer (the counterpart of AgentLogs): every run's
 * persisted artifacts in a sidebar, the picked one rendered in-app — markdown
 * through the shared Markdown component, video through <video>, everything
 * else as escaped text. The raw content endpoint stays one click away.
 */
export function ArtifactViewer({
  ticket,
  runs,
  loadRuns,
  selectedId,
  onSelect,
  onBack,
}: {
  ticket: TicketWithAcs;
  runs: RunWithPhases[];
  loadRuns: (ticketId: number) => void;
  /** URL-owned selection; null falls back to the newest run's first artifact. */
  selectedId: number | null;
  onSelect: (artifactId: number) => void;
  onBack: () => void;
}) {
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

  const all = runs.flatMap((run) => run.artifacts);
  const selected = all.find((a) => a.id === selectedId) ?? all[0] ?? null;

  return (
    <div className="logs-view artifact-view">
      <header className="logs-head">
        <button type="button" className="logs-back" onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          {ticket.displayKey}
        </button>
        <span className="logs-title">{ticket.title}</span>
        <div className="logs-controls">
          {selected && (
            <a
              className="artifact-raw"
              href={`${apiBase}/api/artifacts/${selected.id}/content`}
              target="_blank"
              rel="noreferrer"
            >
              Raw ↗
            </a>
          )}
        </div>
      </header>

      {all.length === 0 ? (
        <p className="logs-empty">No artifacts yet — they persist when a run ends.</p>
      ) : (
        <div className="logs-body">
          <aside className="logs-phases artifact-list">
            {runs
              .filter((run) => run.artifacts.length > 0)
              .map((run) => (
                <div key={run.id} className="artifact-rungroup">
                  {runs.length > 1 && (
                    <span className="logs-phases-label">
                      Run #{run.id} · {run.state}
                    </span>
                  )}
                  {runs.length === 1 && <span className="logs-phases-label">Artifacts</span>}
                  {run.artifacts.map((artifact) => (
                    <button
                      type="button"
                      key={artifact.id}
                      className={
                        selected?.id === artifact.id ? "logs-phase active" : "logs-phase"
                      }
                      onClick={() => onSelect(artifact.id)}
                      title={`${artifact.kind} · ${artifact.name}`}
                    >
                      <span className="logs-phase-mark">▤</span>
                      <span className="logs-phase-name">{artifact.name}</span>
                    </button>
                  ))}
                </div>
              ))}
          </aside>

          {selected && <ArtifactContent key={selected.id} artifact={selected} />}
        </div>
      )}
    </div>
  );
}

function ArtifactContent({ artifact }: { artifact: Artifact }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `${apiBase}/api/artifacts/${artifact.id}/content`;
  const video = artifact.name.endsWith(".webm");

  useEffect(() => {
    if (video) return;
    let live = true;
    void fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET artifact → ${res.status}`);
        return res.text();
      })
      .then((body) => {
        if (live) setText(body);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [url, video]);

  return (
    <div className="logs-scroll artifact-pane">
      <div className="artifact-pane-head">
        <span className="artifactkind dim">{artifact.kind}</span>
        <h2>{artifact.name}</h2>
      </div>
      {error && <p className="error">{error}</p>}
      {video ? (
        <video controls src={url} className="artifact-video" />
      ) : text === null && !error ? (
        <p className="dim">Loading…</p>
      ) : artifact.name.endsWith(".md") ? (
        <Markdown text={text ?? ""} />
      ) : (
        <pre className="artifact-plain">{prettyIfJson(artifact.name, text ?? "")}</pre>
      )}
    </div>
  );
}

/** JSON artifacts read better indented; anything unparseable renders as-is. */
function prettyIfJson(name: string, body: string): string {
  if (!name.endsWith(".json")) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
