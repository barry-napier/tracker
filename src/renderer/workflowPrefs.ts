import type { WorkflowListing } from "../server/types.ts";

/**
 * The Workflow library's list preferences (ticket 51), a sibling of
 * homePrefs.ts: pure sort/filter model plus localStorage persistence that
 * restores anything unknowable to the defaults — a tampered pref can never
 * blank the library.
 */
const PREFS_KEY = "tracker-workflow-prefs";

export const WF_SORTS = ["name", "created", "usage"] as const;
export type WorkflowSort = (typeof WF_SORTS)[number];

export const WF_VISIBLE_MIN = 1;
export const WF_VISIBLE_MAX = 20;

export interface WorkflowPrefs {
  sort: WorkflowSort;
  /** Rows shown before the list truncates; a search query ignores the cap. */
  visible: number;
  /** Archived rows hide by default; a search query always sweeps them. */
  showArchived: boolean;
}

export const DEFAULT_WF_PREFS: WorkflowPrefs = {
  sort: "name",
  visible: 10,
  showArchived: false,
};

export function clampWfVisible(count: number): number {
  return Math.min(WF_VISIBLE_MAX, Math.max(WF_VISIBLE_MIN, Math.trunc(count)));
}

export function loadWorkflowPrefs(): WorkflowPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFS_KEY);
  } catch {}
  return restoreWorkflowPrefs(raw);
}

export function saveWorkflowPrefs(prefs: WorkflowPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function restoreWorkflowPrefs(raw: string | null): WorkflowPrefs {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "");
  } catch {
    return DEFAULT_WF_PREFS;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_WF_PREFS;
  const { sort, visible, showArchived } = saved as Partial<WorkflowPrefs>;
  return {
    sort: WF_SORTS.includes(sort as WorkflowSort) ? (sort as WorkflowSort) : DEFAULT_WF_PREFS.sort,
    visible: typeof visible === "number" && Number.isFinite(visible)
      ? clampWfVisible(visible)
      : DEFAULT_WF_PREFS.visible,
    showArchived: typeof showArchived === "boolean" ? showArchived : DEFAULT_WF_PREFS.showArchived,
  };
}

/**
 * Filter, then sort. A non-empty query sweeps the whole library (archived
 * included) across name and phase names, so no workflow is ever unreachable;
 * idle, archived rows show only when the pref says so.
 */
export function filterWorkflows(
  rows: WorkflowListing[],
  query: string,
  prefs: WorkflowPrefs,
): WorkflowListing[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows.filter((row) => prefs.showArchived || !row.archived);
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      row.phases.some((phase) => phase.toLowerCase().includes(needle)),
  );
}

export function sortWorkflows(rows: WorkflowListing[], sort: WorkflowSort): WorkflowListing[] {
  const sorted = [...rows];
  if (sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  } else if (sort === "created") {
    sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  } else {
    sorted.sort((a, b) => b.usedByProjects - a.usedByProjects || a.id - b.id);
  }
  return sorted;
}
