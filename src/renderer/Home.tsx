import { useState } from "react";
import type { Project } from "../server/types.ts";
import { apiPost } from "./api.ts";
import { Icon } from "./icons.tsx";

/** Preload-exposed folder picker; absent under `vite dev` in a plain browser. */
declare global {
  interface Window {
    tracker?: { pickFolder?: () => Promise<string | null> };
  }
}

/**
 * The entry surface (CONTEXT.md "Home"): a fresh window lands here. Open a
 * Recent Project (every Project is one; the list arrives activity-ordered
 * from the server), or add one by picking a repo already on disk.
 */
/** Deterministic chip color per name, stable across renders and sessions. */
const AVATAR_COLORS = ["#6d5ce6", "#d94fa4", "#2f8f6f", "#c67a2e", "#3f7fd9", "#8f5cd9"];
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function Home({
  projects,
  onOpen,
  onCreated,
}: {
  projects: Project[];
  onOpen: (projectId: number) => void;
  /** A picked repo landed as a new Project: open its board. */
  onCreated: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  /** Register the picked checkout; an already-tracked one just reopens. */
  const addLocal = async (repoPath: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ alreadyTracked?: boolean; project: Project }>(
        "/api/projects/local",
        { path: repoPath },
      );
      if (result.alreadyTracked) onOpen(result.project.id);
      else onCreated(result.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Electron's preload owns the dialog when present; otherwise the server
   *  does (vite dev in a browser) — either way it's the native chooser. */
  const pickRepo = async () => {
    setError(null);
    try {
      const repoPath = window.tracker?.pickFolder
        ? await window.tracker.pickFolder()
        : (await apiPost<{ path: string | null }>("/api/pick-folder", {})).path;
      if (repoPath !== null) await addLocal(repoPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="home">
      <h1 className="wordmark">tracker</h1>
      <div className="home-picker">
        <div className="home-header">
          <span className="home-title">Projects</span>
          <button
            type="button"
            className="icon-btn"
            title="Add a local repo"
            disabled={busy}
            onClick={() => void pickRepo()}
          >
            <Icon name="folder-add-left" />
          </button>
        </div>
        {error && <p className="banner error">{error}</p>}
        <input
          autoFocus
          className="home-search"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="home-list">
          {shown.map((project) => (
            <li key={project.id}>
              <button type="button" onClick={() => onOpen(project.id)}>
                <span className="avatar" style={{ background: avatarColor(project.name) }}>
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                {project.name}
              </button>
            </li>
          ))}
          {shown.length === 0 && projects.length > 0 && (
            <li className="dim home-empty">No project matches “{query}”</li>
          )}
          {projects.length === 0 && (
            <li className="dim home-empty">No projects yet — add a repo you have locally</li>
          )}
        </ul>
      </div>
    </div>
  );
}
