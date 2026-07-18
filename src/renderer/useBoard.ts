import { useCallback, useEffect, useState } from "react";
import type { AuditEvent, TicketWithAcs } from "../server/types.ts";
import { apiBase, apiGet } from "./api.ts";
import { applyEvent, emptyBoard, seedAudit, seedTickets, type BoardState } from "./boardState.ts";

const EVENT_TYPES = ["ticket.updated", "ac.updated", "audit.appended"] as const;

/**
 * Live board: SSE subscription plus a snapshot fetch. The stream opens first
 * and buffers until the snapshot seeds, so nothing emitted in between is
 * lost; boardState's idempotent upserts absorb any overlap.
 */
export function useBoard(): {
  board: BoardState;
  error: string | null;
  loadAudit: (ticketId: number) => void;
} {
  const [board, setBoard] = useState(emptyBoard);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let seeded = false;
    const buffered: Array<{ type: string; data: unknown }> = [];
    const source = new EventSource(`${apiBase}/api/events`);

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        const data: unknown = JSON.parse((message as MessageEvent<string>).data);
        if (seeded) setBoard((state) => applyEvent(state, type, data));
        else buffered.push({ type, data });
      });
    }

    apiGet<TicketWithAcs[]>("/api/tickets")
      .then((tickets) => {
        if (disposed) return;
        setBoard((state) =>
          buffered.reduce(
            (acc, event) => applyEvent(acc, event.type, event.data),
            seedTickets(state, tickets),
          ),
        );
        seeded = true;
        setError(null);
      })
      .catch((e: unknown) => {
        // An unseeded board must not read as "no tickets".
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      disposed = true;
      source.close();
    };
  }, []);

  const loadAudit = useCallback((ticketId: number) => {
    apiGet<AuditEvent[]>(`/api/tickets/${ticketId}/audit`)
      .then((events) => {
        setBoard((state) => seedAudit(state, ticketId, events));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  return { board, error, loadAudit };
}
