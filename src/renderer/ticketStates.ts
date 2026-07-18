import type { TicketState } from "../server/types.ts";

/** Board column order — one entry per ticket state. */
export const STATES: Array<{ key: TicketState; label: string }> = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "Todo" },
  { key: "in_progress", label: "In Progress" },
  { key: "verifying", label: "Verifying" },
  { key: "human_review", label: "Human Review" },
  { key: "done", label: "Done" },
];

export const STATE_LABELS = Object.fromEntries(
  STATES.map(({ key, label }) => [key, label]),
) as Record<TicketState, string>;
