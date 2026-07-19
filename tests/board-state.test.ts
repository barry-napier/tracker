import { describe, expect, test } from "vitest";
import {
  applyEvent,
  emptyBoard,
  seedAudit,
  seedRuns,
  seedTickets,
} from "../src/renderer/boardState.ts";
import type { AcceptanceCriterion, AuditEvent, RunWithPhases, TicketWithAcs } from "../src/server/types.ts";

function audit(overrides: Partial<AuditEvent> & { id: number }): AuditEvent {
  return {
    projectId: 1,
    ticketId: 1,
    actor: "human",
    type: "ticket.created",
    detail: {},
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function ac(overrides: Partial<AcceptanceCriterion> & { id: number }): AcceptanceCriterion {
  return {
    ticketId: 1,
    text: `AC ${overrides.id}`,
    position: 0,
    status: "pending",
    origin: "original",
    provenance: null,
    waiveReason: null,
    check: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function ticket(overrides: Partial<TicketWithAcs> & { id: number }): TicketWithAcs {
  return {
    projectId: 1,
    displayKey: `TRK-${overrides.id}`,
    title: `Ticket ${overrides.id}`,
    description: "",
    state: "backlog",
    repoId: null,
    provider: null,
    externalRef: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    bounceCount: 0,
    arrivedByCap: false,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    acceptanceCriteria: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunWithPhases> & { id: number }): RunWithPhases {
  return {
    ticketId: 1,
    state: "running",
    worktreePath: null,
    crashReason: null,
    phases: [],
    artifacts: [],
    gateResults: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

describe("board state", () => {
  test("seeding the snapshot lists tickets in id order", () => {
    const state = seedTickets(emptyBoard, [ticket({ id: 2 }), ticket({ id: 1 })]);
    expect(state.tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(state.tickets[0]!.displayKey).toBe("TRK-1");
  });

  test("ticket.updated inserts a ticket the snapshot didn't have", () => {
    const seeded = seedTickets(emptyBoard, [ticket({ id: 3 })]);
    const state = applyEvent(seeded, "ticket.updated", ticket({ id: 1, title: "Fresh" }));
    expect(state.tickets.map((t) => t.id)).toEqual([1, 3]);
    expect(state.tickets[0]!.title).toBe("Fresh");
  });

  test("ticket.updated replaces an existing ticket in place", () => {
    const seeded = seedTickets(emptyBoard, [ticket({ id: 1, title: "Before" }), ticket({ id: 2 })]);
    const state = applyEvent(
      seeded,
      "ticket.updated",
      ticket({ id: 1, title: "After", state: "todo" }),
    );
    expect(state.tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(state.tickets[0]).toMatchObject({ title: "After", state: "todo" });
  });

  test("ac.updated replaces the AC on its ticket, keeping position order", () => {
    const seeded = seedTickets(emptyBoard, [
      ticket({
        id: 1,
        acceptanceCriteria: [
          ac({ id: 10, position: 0 }),
          ac({ id: 11, position: 1 }),
        ],
      }),
    ]);
    const state = applyEvent(seeded, "ac.updated", ac({ id: 11, position: 1, status: "verified" }));
    expect(state.tickets[0]!.acceptanceCriteria.map((a) => a.id)).toEqual([10, 11]);
    expect(state.tickets[0]!.acceptanceCriteria[1]!.status).toBe("verified");
  });

  test("ac.updated inserts a new AC (a follow-up) in position order", () => {
    const seeded = seedTickets(emptyBoard, [
      ticket({ id: 1, acceptanceCriteria: [ac({ id: 10, position: 1 })] }),
    ]);
    const state = applyEvent(
      seeded,
      "ac.updated",
      ac({ id: 12, position: 0, origin: "gate-fail" }),
    );
    expect(state.tickets[0]!.acceptanceCriteria.map((a) => a.id)).toEqual([12, 10]);
  });

  test("ac.updated for a ticket the board doesn't know is ignored", () => {
    const seeded = seedTickets(emptyBoard, [ticket({ id: 1 })]);
    const state = applyEvent(seeded, "ac.updated", ac({ id: 10, ticketId: 99 }));
    expect(state).toEqual(seeded);
  });

  test("audit.appended builds the per-ticket activity feed in event order", () => {
    let state = applyEvent(emptyBoard, "audit.appended", audit({ id: 1, type: "ticket.created" }));
    state = applyEvent(state, "audit.appended", audit({ id: 2, type: "ticket.updated" }));
    state = applyEvent(state, "audit.appended", audit({ id: 3, ticketId: 2 }));
    expect(state.auditByTicket[1]!.map((e) => e.type)).toEqual([
      "ticket.created",
      "ticket.updated",
    ]);
    expect(state.auditByTicket[2]!.map((e) => e.id)).toEqual([3]);
  });

  test("seeding a fetched audit history merges with live events without duplicates", () => {
    // The drawer fetches history while the live stream may already have
    // delivered the same rows — seed + replay must dedupe by event id.
    let state = applyEvent(emptyBoard, "audit.appended", audit({ id: 2 }));
    state = seedAudit(state, 1, [audit({ id: 1 }), audit({ id: 2 })]);
    state = applyEvent(state, "audit.appended", audit({ id: 2 }));
    state = applyEvent(state, "audit.appended", audit({ id: 3 }));
    expect(state.auditByTicket[1]!.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  test("audit events without a ticket leave board state untouched", () => {
    const state = applyEvent(emptyBoard, "audit.appended", audit({ id: 1, ticketId: null }));
    expect(state).toEqual(emptyBoard);
  });

  test("run.created starts the ticket's run list; run.updated replaces in place", () => {
    let state = applyEvent(emptyBoard, "run.created", run({ id: 1 }));
    expect(state.runsByTicket[1]!.map((r) => r.id)).toEqual([1]);

    state = applyEvent(state, "run.updated", run({ id: 1, worktreePath: "/data/wt/app--trk-1" }));
    expect(state.runsByTicket[1]).toHaveLength(1);
    expect(state.runsByTicket[1]![0]!.worktreePath).toBe("/data/wt/app--trk-1");
  });

  test("a bounced ticket's newest run lists first; older runs are kept", () => {
    let state = applyEvent(emptyBoard, "run.created", run({ id: 1, state: "crashed" }));
    state = applyEvent(state, "run.created", run({ id: 2 }));
    expect(state.runsByTicket[1]!.map((r) => r.id)).toEqual([2, 1]);
  });

  test("seeding fetched runs merges with live events without duplicates", () => {
    let state = applyEvent(emptyBoard, "run.updated", run({ id: 2 }));
    state = seedRuns(state, 1, [run({ id: 2 }), run({ id: 1 })]);
    state = applyEvent(state, "run.updated", run({ id: 2, worktreePath: "/wt" }));
    expect(state.runsByTicket[1]!.map((r) => r.id)).toEqual([2, 1]);
    expect(state.runsByTicket[1]![0]!.worktreePath).toBe("/wt");
  });
});
