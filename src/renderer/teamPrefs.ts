import type { TeamPr } from "../server/github.ts";

/**
 * Team work's preferences: which affiliated repos feed the PR list, plus the
 * user's saved views (named filter+sort presets rendered as tabs). Persistence
 * follows homePrefs.ts: pure serialize/restore (unit-tested), I/O-wrapping
 * load/save that no-op when localStorage throws, and anything unknowable
 * restores to the defaults.
 */
const PREFS_KEY = "tracker-team-prefs";

export const VIEW_CHECKS = ["any", "passing", "failing", "pending", "none"] as const;
export type ViewChecks = (typeof VIEW_CHECKS)[number];

export const VIEW_DRAFTS = ["any", "only", "hide"] as const;
export type ViewDraft = (typeof VIEW_DRAFTS)[number];

export const VIEW_SORTS = ["updated", "comments", "changes"] as const;
export type ViewSort = (typeof VIEW_SORTS)[number];

/** A saved filter over the open-PR feed, shown as a tab beside "All". */
export interface TeamView {
  id: string;
  name: string;
  /** Free-text match against title, #number, repo, and author. */
  query: string;
  checks: ViewChecks;
  draft: ViewDraft;
  /** Only PRs by this login when non-empty (case-insensitive). */
  author: string;
  sort: ViewSort;
}

export interface TeamPrefs {
  /** owner/repo slugs whose open PRs the feed shows. */
  repos: string[];
  views: TeamView[];
}

export const DEFAULT_TEAM_PREFS: TeamPrefs = { repos: [], views: [] };

export const DEFAULT_VIEW: Omit<TeamView, "id"> = {
  name: "New view",
  query: "",
  checks: "any",
  draft: "any",
  author: "",
  sort: "updated",
};

/** The slug shape /api/team/prs accepts; anything else restores away. */
const SLUG = /^[\w.-]+\/[\w.-]+$/;

export function loadTeamPrefs(): TeamPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFS_KEY);
  } catch {}
  return restoreTeamPrefs(raw);
}

export function saveTeamPrefs(prefs: TeamPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function restoreTeamPrefs(raw: string | null): TeamPrefs {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "");
  } catch {
    return DEFAULT_TEAM_PREFS;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_TEAM_PREFS;
  const { repos, views } = saved as Partial<TeamPrefs>;
  return {
    repos: Array.isArray(repos)
      ? [...new Set(repos.filter((slug): slug is string => typeof slug === "string" && SLUG.test(slug)))]
      : DEFAULT_TEAM_PREFS.repos,
    views: Array.isArray(views) ? views.flatMap(restoreView) : DEFAULT_TEAM_PREFS.views,
  };
}

/** One view row: identity fields must hold; filter fields default per-field. */
function restoreView(candidate: unknown): TeamView[] {
  if (typeof candidate !== "object" || candidate === null) return [];
  const view = candidate as Partial<TeamView>;
  if (typeof view.id !== "string" || view.id === "") return [];
  if (typeof view.name !== "string" || view.name.trim() === "") return [];
  return [
    {
      id: view.id,
      name: view.name,
      query: typeof view.query === "string" ? view.query : DEFAULT_VIEW.query,
      checks: VIEW_CHECKS.includes(view.checks as ViewChecks)
        ? (view.checks as ViewChecks)
        : DEFAULT_VIEW.checks,
      draft: VIEW_DRAFTS.includes(view.draft as ViewDraft)
        ? (view.draft as ViewDraft)
        : DEFAULT_VIEW.draft,
      author: typeof view.author === "string" ? view.author : DEFAULT_VIEW.author,
      sort: VIEW_SORTS.includes(view.sort as ViewSort)
        ? (view.sort as ViewSort)
        : DEFAULT_VIEW.sort,
    },
  ];
}

/** The feed through a view's filters, then its sort. Pure — unit-tested. */
export function applyView(prs: TeamPr[], view: Omit<TeamView, "id" | "name">): TeamPr[] {
  const query = view.query.trim().toLowerCase();
  const author = view.author.trim().toLowerCase();
  const rows = prs.filter((pr) => {
    if (view.checks !== "any" && pr.checks !== view.checks) return false;
    if (view.draft === "only" && !pr.isDraft) return false;
    if (view.draft === "hide" && pr.isDraft) return false;
    if (author !== "" && pr.author.toLowerCase() !== author) return false;
    if (query !== "") {
      const haystack = `${pr.title} #${pr.number} ${pr.repo} ${pr.author}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  if (view.sort === "comments") {
    rows.sort((a, b) => b.comments - a.comments || b.updatedAt.localeCompare(a.updatedAt));
  } else if (view.sort === "changes") {
    rows.sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  // "updated" keeps the server's order: the feed already sorts by updatedAt.
  return rows;
}
