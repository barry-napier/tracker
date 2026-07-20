import type { ProjectListItem } from "../server/types.ts";

/**
 * Home's list preferences (sort / visible cap / grouping) plus the pure
 * sort-and-group model they drive. Persistence follows tabsState.ts: pure
 * serialize/restore (unit-tested), I/O-wrapping load/save that no-op when
 * localStorage throws, and anything unknowable restores to the defaults —
 * a tampered pref can never blank the recents list.
 */
const PREFS_KEY = "tracker-home-prefs";

export const SORTS = ["activity", "created", "name"] as const;
export type ProjectSort = (typeof SORTS)[number];

export const GROUPINGS = ["none", "folder"] as const;
export type ProjectGrouping = (typeof GROUPINGS)[number];

export const VISIBLE_MIN = 1;
export const VISIBLE_MAX = 20;

export interface HomePrefs {
  sort: ProjectSort;
  grouping: ProjectGrouping;
  /** Rows shown before the list truncates; a search query ignores the cap. */
  visible: number;
  /** Collapsed group keys (parent-folder paths) under folder grouping. */
  collapsed: string[];
  /** Archived rows show dimmed in the idle list only when asked (ticket 50). */
  showArchived: boolean;
}

/** activity = the server's order, so the two defaults render identically. */
export const DEFAULT_PREFS: HomePrefs = {
  sort: "activity",
  grouping: "none",
  visible: 6,
  collapsed: [],
  showArchived: false,
};

export function clampVisible(count: number): number {
  return Math.min(VISIBLE_MAX, Math.max(VISIBLE_MIN, Math.trunc(count)));
}

export function loadHomePrefs(): HomePrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFS_KEY);
  } catch {}
  return restoreHomePrefs(raw);
}

export function saveHomePrefs(prefs: HomePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function restoreHomePrefs(raw: string | null): HomePrefs {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "");
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_PREFS;
  const { sort, grouping, visible, collapsed, showArchived } = saved as Partial<HomePrefs>;
  return {
    sort: SORTS.includes(sort as ProjectSort) ? (sort as ProjectSort) : DEFAULT_PREFS.sort,
    grouping: GROUPINGS.includes(grouping as ProjectGrouping)
      ? (grouping as ProjectGrouping)
      : DEFAULT_PREFS.grouping,
    visible: typeof visible === "number" && Number.isFinite(visible)
      ? clampVisible(visible)
      : DEFAULT_PREFS.visible,
    collapsed: Array.isArray(collapsed)
      ? collapsed.filter((key): key is string => typeof key === "string")
      : DEFAULT_PREFS.collapsed,
    showArchived:
      typeof showArchived === "boolean" ? showArchived : DEFAULT_PREFS.showArchived,
  };
}

/**
 * "activity" keeps the incoming order: the server already sorts by latest
 * audit event (store.listProjects), which is the authority — event ids never
 * tie, while lastActivityAt timestamps could.
 */
export function sortProjects(
  projects: ProjectListItem[],
  sort: ProjectSort,
): ProjectListItem[] {
  const rows = [...projects];
  if (sort === "created") {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  } else if (sort === "name") {
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }
  return rows;
}

/**
 * A rendered section of the list. key/label are null for the ungrouped
 * ("keep separate") single section, which renders headerless.
 */
export interface ProjectGroup {
  /** Stable identity (full parent-folder path) — also the collapsed-set key. */
  key: string | null;
  /** Display name: the parent folder's basename. */
  label: string | null;
  projects: ProjectListItem[];
}

/** "~/Developer/tracker" groups under key "/Users/…/Developer", label "Developer". */
function parentFolder(repoPath: string): { key: string; label: string } {
  const segments = repoPath.split("/").filter(Boolean);
  return {
    key: "/" + segments.slice(0, -1).join("/"),
    label: segments.at(-2) ?? "/",
  };
}

/**
 * Folder grouping buckets by the repo checkout's parent directory. Group
 * order follows the sorted rows (a group sits where its first project does),
 * so the sort preference stays visible through the grouping. Projects with
 * no repo yet gather in a trailing "no repo" bucket.
 */
export function groupProjects(
  projects: ProjectListItem[],
  grouping: ProjectGrouping,
): ProjectGroup[] {
  if (grouping === "none") return [{ key: null, label: null, projects }];
  const groups = new Map<string, ProjectGroup>();
  const noRepo: ProjectGroup = { key: "", label: "no repo", projects: [] };
  for (const project of projects) {
    if (project.repoPath === null) {
      noRepo.projects.push(project);
      continue;
    }
    const { key, label } = parentFolder(project.repoPath);
    const group = groups.get(key) ?? { key, label, projects: [] };
    group.projects.push(project);
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  if (noRepo.projects.length > 0) ordered.push(noRepo);
  return ordered;
}
