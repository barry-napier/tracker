import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { hasEmbeddedBrowser } from "./RightSidebar.tsx";
import type { AffiliatedRepo, TeamPr } from "../server/github.ts";
import { apiGet, errorMessage } from "./api.ts";
import { timeAgo } from "./format.ts";
import { avatarColor } from "./Home.tsx";
import { Icon } from "./icons.tsx";
import {
  applyView,
  DEFAULT_VIEW,
  loadTeamPrefs,
  saveTeamPrefs,
  VIEW_CHECKS,
  VIEW_DRAFTS,
  VIEW_SORTS,
  type TeamPrefs,
  type TeamView,
  type ViewChecks,
  type ViewDraft,
  type ViewSort,
} from "./teamPrefs.ts";

interface TeamPrFeed {
  prs: TeamPr[];
  errors: Array<{ repo: string; error: string }>;
}

const CHECK_LABELS: Record<TeamPr["checks"], string | null> = {
  failing: "Failed",
  pending: "Pending",
  passing: "Passing",
  none: null,
};

const CHECKS_OPTIONS: Record<ViewChecks, string> = {
  any: "Any checks",
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
  none: "No checks",
};

const DRAFT_OPTIONS: Record<ViewDraft, string> = {
  any: "Drafts shown",
  only: "Drafts only",
  hide: "Drafts hidden",
};

const SORT_OPTIONS: Record<ViewSort, string> = {
  updated: "Recently updated",
  comments: "Most comments",
  changes: "Largest change",
};

const PAGE_SIZE = 10;

/**
 * Team work (hosted as a Home view, like the Workflow library): pick any of
 * your own+org repos and read one open-PR feed across them, sliced by saved
 * views — named filter+sort presets rendered as tabs beside "All". Repos and
 * views are local preferences (teamPrefs.ts); filtering is client-side over
 * the fetched feed, so switching tabs never refetches.
 */
export function TeamWork() {
  // In the packaged app PR rows open in the sidebar's <webview> (GitHub won't
  // render in the dev fallback's iframe, so dev keeps the new-tab behavior).
  const { openInSidebar } = useOutletContext<{ openInSidebar?: (url: string) => void }>() ?? {};
  const openPr =
    hasEmbeddedBrowser && openInSidebar
      ? (e: React.MouseEvent, url: string) => {
          e.preventDefault();
          openInSidebar(url);
        }
      : null;
  const [prefs, setPrefs] = useState<TeamPrefs>(loadTeamPrefs);
  const [repos, setRepos] = useState<AffiliatedRepo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [feed, setFeed] = useState<TeamPrFeed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  // null = the built-in "All" tab; otherwise a saved view's id.
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // The view being created/edited, or null when the editor is closed. A draft
  // with an id not yet in prefs.views is a creation; saving adds it.
  const [draft, setDraft] = useState<TeamView | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const updatePrefs = (patch: Partial<TeamPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveTeamPrefs(next);
      return next;
    });
  };

  useEffect(() => {
    apiGet<AffiliatedRepo[]>("/api/team/repos")
      .then((listed) => {
        setRepos(listed);
        setRepoError(null);
      })
      .catch((e) => setRepoError(errorMessage(e)));
  }, []);

  const selected = prefs.repos;
  const loadFeed = () => {
    if (selected.length === 0) {
      setFeed(null);
      setFeedError(null);
      return;
    }
    setLoadingFeed(true);
    apiGet<TeamPrFeed>(`/api/team/prs?repos=${encodeURIComponent(selected.join(","))}`)
      .then((fetched) => {
        setFeed(fetched);
        setFeedError(null);
      })
      .catch((e) => setFeedError(errorMessage(e)))
      .finally(() => setLoadingFeed(false));
  };
  // Refetch on every selection change; join() keeps the dep primitive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadFeed, [selected.join(",")]);

  // Same close-anywhere behavior as Home's menus: outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const visibleRepos = useMemo(() => {
    if (repos === null) return [];
    const query = repoQuery.trim().toLowerCase();
    if (query === "") return repos;
    return repos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(query));
  }, [repos, repoQuery]);

  const toggleRepo = (slug: string) => {
    updatePrefs({
      repos: selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug],
    });
  };

  const activeView = prefs.views.find((view) => view.id === activeViewId) ?? null;
  // The editor's draft filters preview live, so the list answers "what would
  // this view show?" while it's still being shaped.
  const shapingView = draft ?? activeView;
  const rows = useMemo(() => {
    const all = feed?.prs ?? [];
    return shapingView === null ? all : applyView(all, shapingView);
  }, [feed, shapingView]);

  // Ten rows per page; any change to what's listed snaps back to page one —
  // page 4 of the old filter is meaningless under the new one.
  const [page, setPage] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPage(0), [feed, shapingView]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // A shrunken result set can strand `page` past the end (e.g. rows refetch);
  // clamp at render so the list never shows an empty page.
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const openEditor = (view: TeamView | null) => {
    setDraft(view ?? { id: crypto.randomUUID(), ...DEFAULT_VIEW });
  };

  const saveDraft = () => {
    if (draft === null) return;
    const named = { ...draft, name: draft.name.trim() === "" ? DEFAULT_VIEW.name : draft.name.trim() };
    const exists = prefs.views.some((view) => view.id === named.id);
    updatePrefs({
      views: exists
        ? prefs.views.map((view) => (view.id === named.id ? named : view))
        : [...prefs.views, named],
    });
    setActiveViewId(named.id);
    setDraft(null);
  };

  const deleteDraft = () => {
    if (draft === null) return;
    updatePrefs({ views: prefs.views.filter((view) => view.id !== draft.id) });
    if (activeViewId === draft.id) setActiveViewId(null);
    setDraft(null);
  };

  const editingExisting = draft !== null && prefs.views.some((view) => view.id === draft.id);

  return (
    <div className="home teamwork">
      <section className="home-picker teamwork-picker-panel">
      <div className="home-header">
        <span className="home-title">Team</span>
        <span className="teamwork-actions">
          <button
            type="button"
            className="icon-btn"
            title="Refresh pull requests"
            disabled={loadingFeed || selected.length === 0}
            onClick={loadFeed}
          >
            <Icon name="refresh" size={16} />
          </button>
          <div className="teamwork-picker" ref={pickerRef}>
            <button
              type="button"
              className="btn btn-sm teamwork-choose"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              {selected.length === 0
                ? "Choose repos"
                : `${selected.length} repo${selected.length === 1 ? "" : "s"}`}
              <Icon name="chevron-down" size={12} />
            </button>
            {pickerOpen && (
              <div className="row-menu teamwork-menu" role="menu">
                <input
                  className="teamwork-repo-search"
                  placeholder="Filter repos…"
                  value={repoQuery}
                  onChange={(e) => setRepoQuery(e.target.value)}
                />
                {repos === null && repoError === null && (
                  <span className="menu-label">Loading repos…</span>
                )}
                {repoError !== null && <span className="menu-label">{repoError}</span>}
                {repos !== null && visibleRepos.length === 0 && (
                  <span className="menu-label">No matching repos</span>
                )}
                {visibleRepos.map((repo) => (
                  <button
                    key={repo.nameWithOwner}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={selected.includes(repo.nameWithOwner)}
                    className="menu-item"
                    onClick={() => toggleRepo(repo.nameWithOwner)}
                  >
                    <span className="menu-tick">
                      {selected.includes(repo.nameWithOwner) && <Icon name="check" size={14} />}
                    </span>
                    {repo.nameWithOwner}
                  </button>
                ))}
              </div>
            )}
          </div>
        </span>
      </div>
      <div className="teamwork-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeViewId === null}
          className={activeViewId === null ? "teamwork-tab active" : "teamwork-tab"}
          onClick={() => {
            setActiveViewId(null);
            setDraft(null);
          }}
        >
          All
        </button>
        {prefs.views.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={activeViewId === view.id}
            className={activeViewId === view.id ? "teamwork-tab active" : "teamwork-tab"}
            onClick={() => {
              // A second click on the active tab opens it for editing.
              if (activeViewId === view.id) openEditor(view);
              else {
                setActiveViewId(view.id);
                setDraft(null);
              }
            }}
            title={activeViewId === view.id ? "Click again to edit" : undefined}
          >
            {view.name}
          </button>
        ))}
        <button
          type="button"
          className="teamwork-tab teamwork-tab-add"
          title="New view"
          onClick={() => openEditor(null)}
        >
          +
        </button>
      </div>
      {draft !== null && (
        <div className="teamwork-view-editor">
          <input
            className="teamwork-view-name"
            value={draft.name}
            placeholder="View name"
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <div className="teamwork-view-controls">
            <input
              className="teamwork-repo-search teamwork-view-search"
              placeholder="Search…"
              value={draft.query}
              onChange={(e) => setDraft({ ...draft, query: e.target.value })}
            />
            <select
              className="teamwork-view-select"
              value={draft.checks}
              onChange={(e) => setDraft({ ...draft, checks: e.target.value as ViewChecks })}
            >
              {VIEW_CHECKS.map((value) => (
                <option key={value} value={value}>
                  {CHECKS_OPTIONS[value]}
                </option>
              ))}
            </select>
            <select
              className="teamwork-view-select"
              value={draft.draft}
              onChange={(e) => setDraft({ ...draft, draft: e.target.value as ViewDraft })}
            >
              {VIEW_DRAFTS.map((value) => (
                <option key={value} value={value}>
                  {DRAFT_OPTIONS[value]}
                </option>
              ))}
            </select>
            <input
              className="teamwork-repo-search teamwork-view-author"
              placeholder="Author…"
              value={draft.author}
              onChange={(e) => setDraft({ ...draft, author: e.target.value })}
            />
            <select
              className="teamwork-view-select"
              value={draft.sort}
              onChange={(e) => setDraft({ ...draft, sort: e.target.value as ViewSort })}
            >
              {VIEW_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SORT_OPTIONS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="teamwork-view-buttons">
            {editingExisting && (
              <button type="button" className="btn teamwork-view-delete" onClick={deleteDraft}>
                Delete view
              </button>
            )}
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={saveDraft}>
              Save
            </button>
          </div>
        </div>
      )}
      {feedError && <p className="banner error">{feedError}</p>}
      {feed?.errors.map((failure) => (
        <p key={failure.repo} className="banner error">
          {failure.repo}: {failure.error}
        </p>
      ))}
      {selected.length === 0 ? (
        <p className="teamwork-empty">
          Choose team repos to see their open pull requests here.
        </p>
      ) : feed !== null && feed.prs.length === 0 && feed.errors.length === 0 ? (
        <p className="teamwork-empty">No open pull requests. Enjoy the quiet.</p>
      ) : feed !== null && rows.length === 0 ? (
        <p className="teamwork-empty">No pull requests match this view.</p>
      ) : (
        <>
        <ul className="home-list teamwork-list">
          {pageRows.map((pr) => (
            <li key={`${pr.repo}#${pr.number}`} className="home-row">
              <a
                className="home-open teamwork-pr"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                onClick={openPr === null ? undefined : (e) => openPr(e, pr.url)}
              >
                <span className="avatar" style={{ background: avatarColor(pr.repo) }}>
                  {pr.repo.split("/")[1]?.slice(0, 1).toUpperCase()}
                </span>
                <span className="teamwork-pr-text">
                  <span className="teamwork-pr-title">
                    {pr.title} <span className="teamwork-pr-number">#{pr.number}</span>
                    {pr.isDraft && <span className="wf-badge archived">Draft</span>}
                  </span>
                  <span className="teamwork-pr-sub">
                    {pr.repo} · {pr.author} · {timeAgo(pr.updatedAt)}
                  </span>
                </span>
                <span className="teamwork-pr-meta">
                  {CHECK_LABELS[pr.checks] !== null && (
                    <span className={`teamwork-checks ${pr.checks}`}>
                      {CHECK_LABELS[pr.checks]}
                    </span>
                  )}
                  <span className="teamwork-diff">
                    <span className="teamwork-add">+{pr.additions}</span>{" "}
                    <span className="teamwork-del">-{pr.deletions}</span>
                  </span>
                  {pr.comments > 0 && (
                    <span className="teamwork-comments" title={`${pr.comments} comments`}>
                      {pr.comments}
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {rows.length > PAGE_SIZE && (
          <div className="teamwork-pager">
            <button
              type="button"
              className="icon-btn"
              title="Previous page"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <Icon name="chevron-down" size={14} className="teamwork-pager-prev" />
            </button>
            <span className="teamwork-pager-range">
              {safePage * PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * PAGE_SIZE)} of{" "}
              {rows.length}
            </span>
            <button
              type="button"
              className="icon-btn"
              title="Next page"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              <Icon name="chevron-down" size={14} className="teamwork-pager-next" />
            </button>
          </div>
        )}
        </>
      )}
      </section>
    </div>
  );
}
