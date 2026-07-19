import type { Project } from "../server/types.ts";

/**
 * Restart persistence for the tab strip (ticket B): only ids are saved —
 * names and everything else rehydrate from the live project rows, so a
 * rename never shows a stale label and a deleted project can't resurrect.
 * serialize/restore are pure (unit-tested); load/save wrap the storage I/O
 * so a throwing localStorage (quota, privacy mode) degrades to no-op.
 */
const TABS_KEY = "tracker-tabs";

interface SavedTabs {
  tabIds: number[];
  activeId: number | null;
}

export function loadTabs(projects: Project[]): { tabs: Project[]; activeId: number | null } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TABS_KEY);
  } catch {}
  return restoreTabs(raw, projects);
}

export function saveTabs(tabs: Project[], activeId: number | null): void {
  try {
    localStorage.setItem(TABS_KEY, serializeTabs(tabs, activeId));
  } catch {}
}

export function serializeTabs(tabs: Project[], activeId: number | null): string {
  const saved: SavedTabs = { tabIds: tabs.map((t) => t.id), activeId };
  return JSON.stringify(saved);
}

/**
 * Anything unknowable degrades to the Home view rather than throwing:
 * malformed JSON → no tabs; a vanished project drops its tab; an active id
 * without a surviving tab goes null (active must always be an open tab).
 */
export function restoreTabs(
  raw: string | null,
  projects: Project[],
): { tabs: Project[]; activeId: number | null } {
  const empty = { tabs: [], activeId: null };
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "");
  } catch {
    return empty;
  }
  if (typeof saved !== "object" || saved === null) return empty;
  const { tabIds, activeId } = saved as Partial<SavedTabs>;
  if (!Array.isArray(tabIds)) return empty;

  // Dedupe: one Project, one tab (CONTEXT.md) — even out of tampered storage.
  const byId = new Map(projects.map((p) => [p.id, p]));
  const tabs = [...new Set(tabIds.filter((id): id is number => typeof id === "number"))]
    .map((id) => byId.get(id))
    .filter((p): p is Project => p !== undefined);
  const active =
    typeof activeId === "number" && tabs.some((t) => t.id === activeId) ? activeId : null;
  return { tabs, activeId: active };
}
