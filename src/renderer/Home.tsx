import { Fragment, useEffect, useRef, useState } from "react";
import type { Project, ProjectListItem } from "../server/types.ts";

import { apiDelete, apiPost } from "./api.ts";
import { timeAgo } from "./format.ts";
import {
  clampVisible,
  groupProjects,
  loadHomePrefs,
  saveHomePrefs,
  sortProjects,
  type HomePrefs,
  type ProjectGrouping,
  type ProjectSort,
} from "./homePrefs.ts";
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
export const AVATAR_COLORS = ["#6d5ce6", "#d94fa4", "#2f8f6f", "#c67a2e", "#3f7fd9", "#8f5cd9"];
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

const SORT_LABELS: Record<ProjectSort, string> = {
  activity: "Last activity",
  created: "Created at",
  name: "Name",
};

const GROUP_LABELS: Record<ProjectGrouping, string> = {
  folder: "Group by folder",
  none: "Keep separate",
};

export function Home({
  projects,
  onOpen,
  onCreated,
  onArchivedChange,
  onDeleted,
}: {
  projects: ProjectListItem[];
  onOpen: (projectId: number) => void;
  /** A picked repo landed as a new Project: open its board. */
  onCreated: (project: Project) => void;
  /** A row was archived or unarchived (never deleted): patch its hiddenAt. */
  onArchivedChange: (projectId: number, hiddenAt: string | null) => void;
  /** A row was soft-deleted: drop it from state (re-adding the checkout recovers). */
  onDeleted: (projectId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The row menu renders position:fixed (the list scrolls, and absolute
  // positioning would clip it at the scroll container's edge), so the open
  // state carries the trigger's viewport anchor along with the row id.
  const [menuFor, setMenuFor] = useState<{ id: number; top: number; right: number } | null>(
    null,
  );
  const [sortOpen, setSortOpen] = useState(false);
  // Soft delete asks first — it clears the board from view, even though the
  // server keeps the row and re-adding the checkout brings it back.
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs] = useState<HomePrefs>(loadHomePrefs);
  const updatePrefs = (patch: Partial<HomePrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveHomePrefs(next);
      return next;
    });
  };
  const toggleCollapsed = (key: string) => {
    updatePrefs({
      collapsed: prefs.collapsed.includes(key)
        ? prefs.collapsed.filter((k) => k !== key)
        : [...prefs.collapsed, key],
    });
  };

  // Mirrors the Workflow library: the idle list hides archived rows unless
  // the pref shows them; a search always sweeps everything.
  const shown = sortProjects(
    projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) &&
        (query !== "" || prefs.showArchived || p.hiddenAt === null),
    ),
    prefs.sort,
  );
  // The visible cap applies only to the idle list — a search always sweeps
  // everything, so no project is ever unreachable.
  const capped = query === "" ? shown.slice(0, prefs.visible) : shown;
  const hiddenCount = shown.length - capped.length;
  const groups = groupProjects(capped, prefs.grouping);

  // An open menu closes the way native menus do: any click elsewhere (the
  // row menu's items close it themselves; the sort popover stays open for
  // its own clicks so the stepper is usable) or Escape.
  useEffect(() => {
    if (menuFor === null && !sortOpen) return;
    const close = () => {
      setMenuFor(null);
      setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    // The row menu is viewport-anchored, so a scroll would leave it adrift —
    // close instead, the way native context menus do.
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuFor, sortOpen]);

  // "/" jumps to search from anywhere on Home — unless something that takes
  // text is already focused, where "/" is just a character.
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onSlash);
    return () => document.removeEventListener("keydown", onSlash);
  }, []);

  /** Archive / unarchive the list entry (ticket 50) — nothing is deleted. */
  const toggleArchived = async (project: ProjectListItem) => {
    setError(null);
    try {
      const verb = project.hiddenAt === null ? "hide" : "unhide";
      const updated = await apiPost<Project>(`/api/projects/${project.id}/${verb}`, {});
      onArchivedChange(project.id, updated.hiddenAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Soft delete (server keeps the row): drop it from the list on success. */
  const deleteProject = async (project: ProjectListItem) => {
    setError(null);
    try {
      await apiDelete(`/api/projects/${project.id}`);
      onDeleted(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  const reveal = async (projectId: number) => {
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/reveal`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
        <div className="home-search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>/</kbd>
        </div>
        <div className="home-header">
          <span className="home-title">Projects</span>
          <span className="home-header-actions">
            <button
              type="button"
              className="icon-btn"
              title="Sort and group"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={(e) => {
                // The document-level closer sees this click too; stop it so
                // the toggle isn't immediately undone.
                e.stopPropagation();
                setSortOpen((open) => !open);
              }}
            >
              <Icon name="arrows-sort" size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Add a local repo"
              disabled={busy}
              onClick={() => void pickRepo()}
            >
              <Icon name="folder-add-left" />
            </button>
            {sortOpen && (
              <div
                className="row-menu sort-menu"
                role="menu"
                // Clicks inside adjust preferences; only outside clicks close.
                onClick={(e) => e.stopPropagation()}
              >
                <span className="menu-label">Sort projects</span>
                {(Object.keys(SORT_LABELS) as ProjectSort[]).map((sort) => (
                  <button
                    key={sort}
                    type="button"
                    role="menuitemradio"
                    aria-checked={prefs.sort === sort}
                    className="menu-item"
                    onClick={() => updatePrefs({ sort })}
                  >
                    <span className="menu-tick">
                      {prefs.sort === sort && <Icon name="check" size={14} />}
                    </span>
                    {SORT_LABELS[sort]}
                  </button>
                ))}
                <span className="menu-label">Visible projects</span>
                <div className="menu-stepper">
                  <button
                    type="button"
                    aria-label="Show fewer projects"
                    onClick={() => updatePrefs({ visible: clampVisible(prefs.visible - 1) })}
                  >
                    −
                  </button>
                  <span>{prefs.visible}</span>
                  <button
                    type="button"
                    aria-label="Show more projects"
                    onClick={() => updatePrefs({ visible: clampVisible(prefs.visible + 1) })}
                  >
                    +
                  </button>
                </div>
                <hr className="menu-divider" />
                <span className="menu-label">Group projects</span>
                {(Object.keys(GROUP_LABELS) as ProjectGrouping[]).map((grouping) => (
                  <button
                    key={grouping}
                    type="button"
                    role="menuitemradio"
                    aria-checked={prefs.grouping === grouping}
                    className="menu-item"
                    onClick={() => updatePrefs({ grouping })}
                  >
                    <span className="menu-tick">
                      {prefs.grouping === grouping && <Icon name="check" size={14} />}
                    </span>
                    {GROUP_LABELS[grouping]}
                  </button>
                ))}
                <hr className="menu-divider" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={prefs.showArchived}
                  className="menu-item"
                  onClick={() => updatePrefs({ showArchived: !prefs.showArchived })}
                >
                  <span className="menu-tick">
                    {prefs.showArchived && <Icon name="check" size={14} />}
                  </span>
                  Show archived
                </button>
              </div>
            )}
          </span>
        </div>
        {error && <p className="banner error">{error}</p>}
        <ul className="home-list">
          {groups.map((group) => (
            <Fragment key={group.key ?? "all"}>
              {group.key !== null && (
                <li className="home-group">
                  <button
                    type="button"
                    className="home-group-toggle"
                    title={group.key === "" ? undefined : group.key}
                    aria-expanded={!prefs.collapsed.includes(group.key)}
                    onClick={() => toggleCollapsed(group.key!)}
                  >
                    <Icon name="chevron-down" size={12} />
                    {group.label}
                  </button>
                </li>
              )}
              {!(group.key !== null && prefs.collapsed.includes(group.key)) &&
                group.projects.map((project) => (
                <li
                  key={project.id}
                  className={project.hiddenAt === null ? "home-row" : "home-row archived"}
                >
                  <button type="button" className="home-open" onClick={() => onOpen(project.id)}>
                    <span className="avatar" style={{ background: avatarColor(project.name) }}>
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="home-name">{project.name}</span>
                    {project.hiddenAt !== null && (
                      <span className="wf-badge archived">Archived</span>
                    )}
                    <span className="home-time">
                      {timeAgo(project.lastActivityAt ?? project.createdAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn row-kebab"
                    title="More options"
                    aria-haspopup="menu"
                    aria-expanded={menuFor?.id === project.id}
                    onClick={(e) => {
                      // The document-level closer sees this click too; stop it so
                      // the toggle isn't immediately undone.
                      e.stopPropagation();
                      const anchor = e.currentTarget.getBoundingClientRect();
                      setMenuFor((open) =>
                        open?.id === project.id
                          ? null
                          : {
                              id: project.id,
                              top: anchor.bottom + 2,
                              right: window.innerWidth - anchor.right,
                            },
                      );
                    }}
                  >
                    <Icon name="dots-horizontal" size={16} />
                  </button>
                  {menuFor?.id === project.id && (
                    <div
                      className="row-menu"
                      role="menu"
                      style={{ position: "fixed", top: menuFor.top, right: menuFor.right }}
                    >
                      <button type="button" role="menuitem" onClick={() => void reveal(project.id)}>
                        Reveal in Finder
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void toggleArchived(project)}
                      >
                        {project.hiddenAt === null ? "Archive" : "Unarchive"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => setDeleting(project)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
                ))}
            </Fragment>
          ))}
          {hiddenCount > 0 && (
            <li className="dim home-empty">
              +{hiddenCount} more — search, or raise visible projects
            </li>
          )}
          {shown.length === 0 && projects.length > 0 && query !== "" && (
            <li className="dim home-empty">No project matches “{query}”</li>
          )}
          {shown.length === 0 && projects.length > 0 && query === "" && (
            <li className="dim home-empty">
              Everything is archived — turn on “Show archived” to see the list
            </li>
          )}
          {projects.length === 0 && (
            <li className="dim home-empty home-empty-cta">
              No projects yet — add a repo you have locally
              <button type="button" disabled={busy} onClick={() => void pickRepo()}>
                Open a project
              </button>
            </li>
          )}
        </ul>
      </div>
      {deleting && (
        <div className="wf-overlay" onClick={() => setDeleting(null)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{deleting.name}”?</h3>
            <p className="dim">
              The project leaves this list entirely — tickets, runs, and the audit trail are
              kept, and re-adding the checkout brings everything back.
            </p>
            <div className="formrow">
              <button type="button" className="danger" onClick={() => void deleteProject(deleting)}>
                Delete
              </button>
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
