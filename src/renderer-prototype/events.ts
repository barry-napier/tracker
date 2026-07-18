// PROTOTYPE — throwaway (wayfinder ticket 12). Draft of the SSE event contract
// the renderer consumes from the Hono layer. This file is the deliverable draft;
// everything else in this folder exists to exercise it.
//
// Transport sketch:
//   GET /api/events                     — app-wide stream (ticket/run/gate/preview events)
//   GET /api/runs/:runId/log            — per-run agent log stream (block-level union, replay + live)
// Every event: `id:` = monotonic audit-trail seq (Last-Event-ID resume), `event:` = `type` field.

// ---- domain snapshots carried inside events ----

export type TicketState =
  | "backlog"
  | "todo"
  | "in_progress"
  | "verifying"
  | "human_review"
  | "done";

export type Provider = "claude-code" | "kiro" | "copilot";

export type Phase = "research" | "plan" | "implement" | "dogfood" | "document";

export type AcStatus = "pending" | "verified" | "failed" | "waived";

export interface AcRow {
  id: string;
  ticketId: string;
  text: string;
  status: AcStatus;
  /** machine | human — who verified; null while pending */
  provenance: "machine" | "human" | null;
  /** set when this AC was born from a failed gate/review (follow-up criterion) */
  followUpOf: string | null;
}

export interface TicketSnapshot {
  id: string; // TRK-<n>
  projectId: string;
  repoId: string | null; // null until promotion
  title: string;
  state: TicketState;
  provider: Provider | null; // picked at promotion
  currentRunId: string | null;
}

// ---- app-wide stream: /api/events ----

export type AppEvent =
  | { type: "ticket.updated"; ticket: TicketSnapshot } // any field change incl. state
  | { type: "run.created"; runId: string; ticketId: string; provider: Provider }
  | {
      type: "run.phase_changed";
      runId: string;
      ticketId: string;
      phase: Phase;
      status: "started" | "completed" | "crashed";
    }
  | {
      type: "gate.result";
      runId: string;
      ticketId: string;
      gate: string; // e.g. "tests-pass", "artifact-lint", "dogfood-green", "ac:<acId>"
      result: "pass" | "fail" | "skip";
      detail: string | null;
    }
  | { type: "ac.updated"; ac: AcRow }
  | {
      type: "run.ended";
      runId: string;
      ticketId: string;
      outcome: "gates_passed" | "bounced" | "crashed" | "parked";
    }
  | {
      type: "audit.appended"; // powers the ticket-detail activity feed
      seq: number;
      ticketId: string;
      actor: string; // "human:barry" | "worker:2"
      eventType: string;
      detail: string;
      at: string; // ISO
    }
  | {
      type: "preview.status";
      ticketId: string;
      status: "stopped" | "starting" | "ready" | "failed";
      port: number | null;
      logTail: string | null; // populated on failed
    };

// ---- per-run agent log stream: /api/runs/:runId/log ----
// Block-level conversation union (provider abstraction, ticket 09).
// Streaming text arrives as block.delta appends targeting an open block id.

export type LogBlock =
  | { kind: "prompt"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; tool: string; output: string; isError: boolean };

export type RunLogEvent =
  | { type: "block.open"; blockId: string; phase: Phase; block: LogBlock }
  | { type: "block.delta"; blockId: string; textDelta: string }
  | { type: "block.close"; blockId: string };
