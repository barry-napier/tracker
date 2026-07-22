import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TicketState, TicketWithAcs } from "../server/types.ts";
import { STATES } from "./ticketStates.ts";
import { Icon } from "./icons.tsx";

/*
 * Board toolbar (search / status / sort / week range) and the month view.
 * All display-side: no server involvement. "Done on day X" is the done
 * ticket's updatedAt — accurate as long as done tickets aren't edited later.
 */

export type SortKey = "updated" | "created" | "title";

export interface BoardControls {
  query: string;
  status: TicketState | "all";
  sort: SortKey;
  /** Monday of the visible week, local midnight. */
  weekStart: Date;
  view: "board" | "month";
}

export function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const FMT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FMT_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const FMT_MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function initialControls(): BoardControls {
  return { query: "", status: "all", sort: "updated", weekStart: mondayOf(new Date()), view: "board" };
}

/** Apply query/status/sort; scope the Done column to the visible week. */
export function applyControls(
  tickets: TicketWithAcs[],
  state: TicketState,
  c: BoardControls,
): TicketWithAcs[] {
  const q = c.query.trim().toLowerCase();
  const weekEnd = addDays(c.weekStart, 7);
  const out = tickets.filter((t) => {
    if (t.state !== state) return false;
    if (c.status !== "all" && t.state !== c.status) return false;
    if (q && !`${t.displayKey} ${t.title}`.toLowerCase().includes(q)) return false;
    if (state === "done") {
      const doneAt = new Date(t.updatedAt);
      if (doneAt < c.weekStart || doneAt >= weekEnd) return false;
    }
    return true;
  });
  out.sort((a, b) =>
    c.sort === "title"
      ? a.title.localeCompare(b.title)
      : c.sort === "created"
        ? b.createdAt.localeCompare(a.createdAt)
        : b.updatedAt.localeCompare(a.updatedAt),
  );
  return out;
}

export function BoardToolbar({
  controls,
  onChange,
  repoOptions = [],
  repoFilter = null,
  onRepoFilter,
  actions,
}: {
  controls: BoardControls;
  onChange: (next: BoardControls) => void;
  /** The project's repos, for the repo filter; hidden with fewer than two. */
  repoOptions?: { id: number; name: string }[];
  /** Selected repo id, null = all. Owned by the URL (?repo=<name>). */
  repoFilter?: number | null;
  onRepoFilter?: (id: number | null) => void;
  /** Board-level actions (new ticket, sweep) rendered at the far right. */
  actions?: ReactNode;
}) {
  const { weekStart } = controls;
  const weekEnd = addDays(weekStart, 6);
  const isThisWeek = sameDay(weekStart, mondayOf(new Date()));
  const set = (patch: Partial<BoardControls>) => onChange({ ...controls, ...patch });
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="board-toolbar">
      <select
        value={controls.status}
        onChange={(e) => set({ status: e.target.value as TicketState | "all" })}
      >
        <option value="all">All statuses</option>
        {STATES.map(({ key, label }) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      {repoOptions.length > 1 && (
        <select
          value={repoFilter === null ? "all" : String(repoFilter)}
          onChange={(e) =>
            onRepoFilter?.(e.target.value === "all" ? null : Number(e.target.value))
          }
        >
          <option value="all">All repos</option>
          {repoOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      <select value={controls.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
        <option value="updated">Last updated</option>
        <option value="created">Created</option>
        <option value="title">Title</option>
      </select>
      <div className="board-toolbar-spacer" />
      <div className="board-search">
        <Icon name="search" size={16} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search issues…"
          value={controls.query}
          onChange={(e) => set({ query: e.target.value })}
        />
        <kbd>/</kbd>
      </div>
      <div className="board-toolbar-spacer" />
      <button type="button" className="btn btn-ghost weeknav" onClick={() => set({ weekStart: addDays(weekStart, -7) })}>
        ‹
      </button>
      <span className="week-range">
        {FMT_DAY.format(weekStart)} – {FMT_DAY_YEAR.format(weekEnd)}
      </span>
      <button type="button" className="btn btn-ghost weeknav" onClick={() => set({ weekStart: addDays(weekStart, 7) })}>
        ›
      </button>
      <button
        type="button"
        className={"btn btn-ghost weeknav week-this" + (isThisWeek ? " week-this-active" : "")}
        onClick={() => set({ weekStart: mondayOf(new Date()) })}
      >
        This week
      </button>
      <button
        type="button"
        className={"btn btn-ghost weeknav" + (controls.view === "month" ? " week-this-active" : "")}
        title="Month view"
        onClick={() => set({ view: controls.view === "month" ? "board" : "month" })}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="11"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path d="M1.5 5.5 H12.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.5 1 V3.5 M9.5 1 V3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M4 8 H5.5 M8.5 8 H10 M4 10.5 H5.5 M8.5 10.5 H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {actions}
    </div>
  );
}

/** Month grid of done tickets, bucketed by the day they entered Done. */
export function MonthView({
  tickets,
  onOpenWeek,
  onOpenTicket,
}: {
  tickets: TicketWithAcs[];
  onOpenWeek: (weekStart: Date) => void;
  onOpenTicket: (ticket: TicketWithAcs) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const gridStart = mondayOf(cursor);
  const weeks: Date[][] = [];
  for (let d = new Date(gridStart); weeks.length < 6; ) {
    const week = Array.from({ length: 7 }, () => {
      const day = new Date(d);
      d = addDays(d, 1);
      return day;
    });
    weeks.push(week);
    if (d.getMonth() !== cursor.getMonth() && d > cursor) break;
  }
  const done = tickets.filter((t) => t.state === "done");
  const doneOn = (day: Date) => done.filter((t) => sameDay(new Date(t.updatedAt), day));
  const doneThisMonth = done.filter((t) => {
    const at = new Date(t.updatedAt);
    return at.getFullYear() === cursor.getFullYear() && at.getMonth() === cursor.getMonth();
  }).length;
  const today = new Date();
  return (
    <div className="monthview">
      <div className="monthview-head">
        <h2>{FMT_MONTH.format(cursor)}</h2>
        <span className="dim">{doneThisMonth} done this month</span>
        <div className="board-toolbar-spacer" />
        <button
          type="button"
          className="btn btn-ghost weeknav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <button
          type="button"
          className="btn btn-ghost weeknav"
          onClick={() => {
            const now = new Date();
            setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
          }}
        >
          Today
        </button>
        <button
          type="button"
          className="btn btn-ghost weeknav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      <div className="monthview-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="monthview-dow">
            {d}
          </div>
        ))}
        {weeks.flat().map((day) => {
          const inMonth = day.getMonth() === cursor.getMonth();
          const items = doneOn(day);
          return (
            <div
              key={day.toISOString()}
              className={
                "monthview-day" +
                (inMonth ? "" : " monthview-day-out") +
                (sameDay(day, today) ? " monthview-day-today" : "")
              }
              onDoubleClick={() => onOpenWeek(mondayOf(day))}
            >
              <span className="monthview-date">{day.getDate()}</span>
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="monthview-item"
                  title={`${t.displayKey} ${t.title}`}
                  onClick={() => onOpenTicket(t)}
                >
                  {t.displayKey} {t.title}
                </button>
              ))}
              {items.length > 0 && (
                <button
                  type="button"
                  className="monthview-weeklink"
                  onClick={() => onOpenWeek(mondayOf(day))}
                >
                  Open board for week of {FMT_DAY.format(mondayOf(day))}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
