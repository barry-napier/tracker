import type { AcceptanceCriterion, AuditEvent, Run, TicketWithAcs } from "../server/types.ts";

/**
 * Pure board state derived from the API snapshot plus applied SSE events.
 * All operations are idempotent upserts so a snapshot fetch racing the SSE
 * stream can replay overlapping data safely.
 */
export interface BoardState {
  tickets: TicketWithAcs[];
  auditByTicket: Record<number, AuditEvent[]>;
  /** Newest run first — the latest Run is the one the drawer reads. */
  runsByTicket: Record<number, Run[]>;
}

export const emptyBoard: BoardState = { tickets: [], auditByTicket: {}, runsByTicket: {} };

export function seedTickets(state: BoardState, tickets: TicketWithAcs[]): BoardState {
  return { ...state, tickets: [...tickets].sort((a, b) => a.id - b.id) };
}

export function seedAudit(state: BoardState, ticketId: number, events: AuditEvent[]): BoardState {
  const merged = mergeAudit(events, state.auditByTicket[ticketId] ?? []);
  return { ...state, auditByTicket: { ...state.auditByTicket, [ticketId]: merged } };
}

export function seedRuns(state: BoardState, ticketId: number, runs: Run[]): BoardState {
  const merged = mergeRuns(runs, state.runsByTicket[ticketId] ?? []);
  return { ...state, runsByTicket: { ...state.runsByTicket, [ticketId]: merged } };
}

export function applyEvent(state: BoardState, type: string, data: unknown): BoardState {
  if (type === "ticket.updated") {
    const ticket = data as TicketWithAcs;
    const rest = state.tickets.filter((t) => t.id !== ticket.id);
    return { ...state, tickets: [...rest, ticket].sort((a, b) => a.id - b.id) };
  }
  if (type === "ac.updated") {
    const criterion = data as AcceptanceCriterion;
    return {
      ...state,
      tickets: state.tickets.map((ticket) => {
        if (ticket.id !== criterion.ticketId) return ticket;
        const rest = ticket.acceptanceCriteria.filter((a) => a.id !== criterion.id);
        const acceptanceCriteria = [...rest, criterion].sort(
          (a, b) => a.position - b.position || a.id - b.id,
        );
        return { ...ticket, acceptanceCriteria };
      }),
    };
  }
  if (type === "run.created" || type === "run.updated") {
    const run = data as Run;
    const merged = mergeRuns(state.runsByTicket[run.ticketId] ?? [], [run]);
    return { ...state, runsByTicket: { ...state.runsByTicket, [run.ticketId]: merged } };
  }
  if (type === "audit.appended") {
    const event = data as AuditEvent;
    if (event.ticketId === null) return state;
    const merged = mergeAudit(state.auditByTicket[event.ticketId] ?? [], [event]);
    return { ...state, auditByTicket: { ...state.auditByTicket, [event.ticketId]: merged } };
  }
  return state;
}

function mergeAudit(base: AuditEvent[], incoming: AuditEvent[]): AuditEvent[] {
  const byId = new Map(base.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function mergeRuns(base: Run[], incoming: Run[]): Run[] {
  const byId = new Map(base.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
