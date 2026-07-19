import { useEffect, useMemo, useState } from "react";
import type { HomeRepo } from "../server/home.ts";
import type { Project } from "../server/types.ts";
import { apiGet, apiPost } from "./api.ts";

/** Preload-exposed folder picker; absent under `vite dev` in a plain browser. */
declare global {
  interface Window {
    tracker?: { pickFolder?: () => Promise<string | null> };
  }
}

/**
 * The entry surface (CONTEXT.md "Home"): a fresh window lands here. Two paths
 * onto a board — open a Recent Project (every Project is one; the list arrives
 * activity-ordered from the server) or clone an affiliated GitHub repo.
 */
export function Home({
  projects,
  onOpen,
  onCreated,
}: {
  projects: Project[];
  onOpen: (projectId: number) => void;
  /** A clone landed: open its new Project's board. */
  onCreated: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const shown = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="home">
      <h1 className="wordmark">tracker</h1>
      {!adding && (
        <div className="home-picker">
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
                  <span className="avatar">{project.name.slice(0, 1).toUpperCase()}</span>
                  {project.name}
                </button>
              </li>
            ))}
            {shown.length === 0 && projects.length > 0 && (
              <li className="dim home-empty">No project matches “{query}”</li>
            )}
            {projects.length === 0 && (
              <li className="dim home-empty">No projects yet — add one from GitHub</li>
            )}
          </ul>
          <button type="button" className="home-link" onClick={() => setAdding(true)}>
            + Add project
          </button>
        </div>
      )}
      {adding && <ClonePane onOpen={onOpen} onCreated={onCreated} onBack={() => setAdding(false)} />}
    </div>
  );
}

/**
 * "Add project" = clone from GitHub — the only way Home creates a Project.
 * Listing failures (no `gh`, not authenticated) disable this pane with the
 * server's reason; Recent Projects are untouched by GitHub being down.
 */
function ClonePane({
  onOpen,
  onCreated,
  onBack,
}: {
  onOpen: (projectId: number) => void;
  onCreated: (project: Project) => void;
  onBack: () => void;
}) {
  const [repos, setRepos] = useState<HomeRepo[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only used when no native picker exists (vite dev in a browser).
  const [parentDirInput, setParentDirInput] = useState("");
  const [pendingRepo, setPendingRepo] = useState<HomeRepo | null>(null);

  useEffect(() => {
    apiGet<{ repos: HomeRepo[] }>("/api/github/repos")
      .then(({ repos }) => setRepos(repos))
      .catch((e: unknown) => {
        setUnavailable(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const shown = useMemo(
    () =>
      (repos ?? []).filter((repo) =>
        repo.nameWithOwner.toLowerCase().includes(query.toLowerCase()),
      ),
    [repos, query],
  );

  const clone = async (repo: HomeRepo, parentDir: string) => {
    setBusy(repo.nameWithOwner);
    setError(null);
    try {
      const result = await apiPost<{ alreadyTracked?: boolean; project: Project }>(
        "/api/github/clone",
        { nameWithOwner: repo.nameWithOwner, parentDir },
      );
      if (result.alreadyTracked) onOpen(result.project.id);
      else onCreated(result.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Tracked repos open their existing Project; anything else starts a clone. */
  const openOrClone = async (repo: HomeRepo) => {
    if (repo.trackedProjectId !== null) {
      onOpen(repo.trackedProjectId);
      return;
    }
    const pickFolder = window.tracker?.pickFolder;
    if (pickFolder) {
      const parentDir = await pickFolder();
      if (parentDir !== null) await clone(repo, parentDir);
    } else {
      setPendingRepo(repo); // dev fallback: type the parent folder instead
    }
  };

  return (
    <div className="home-picker">
      {unavailable && (
        <p className="banner error">GitHub is unavailable — cloning is disabled: {unavailable}</p>
      )}
      {!unavailable && (
        <input
          autoFocus
          className="home-search"
          placeholder="Search your GitHub repos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {!unavailable && repos === null && <p className="dim home-empty">Loading your repos…</p>}
      {error && <p className="banner error">{error}</p>}
      <ul className="home-list">
        {shown.map((repo) => (
          <li key={repo.nameWithOwner}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void openOrClone(repo)}
            >
              <span className="avatar">{repo.nameWithOwner.split("/")[1]!.slice(0, 1).toUpperCase()}</span>
              <span className="home-repo">
                {repo.nameWithOwner}
                {repo.description && <em className="dim"> — {repo.description}</em>}
              </span>
              {repo.trackedProjectId !== null && <span className="pill">already tracked</span>}
              {busy === repo.nameWithOwner && <span className="dim">cloning…</span>}
            </button>
            {pendingRepo?.nameWithOwner === repo.nameWithOwner && (
              <form
                className="home-parent"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPendingRepo(null);
                  void clone(repo, parentDirInput.trim());
                }}
              >
                <input
                  autoFocus
                  placeholder="Clone into folder (e.g. /Users/you/Developer)"
                  value={parentDirInput}
                  onChange={(e) => setParentDirInput(e.target.value)}
                />
                <button type="submit" disabled={parentDirInput.trim() === ""}>
                  Clone
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="home-link" onClick={onBack}>
        ← Back to projects
      </button>
    </div>
  );
}
