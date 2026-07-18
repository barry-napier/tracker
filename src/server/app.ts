import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { BusEvent, EventBus } from "./bus.ts";
import { NotFoundError, type Store } from "./store.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function createApp(store: Store, bus: EventBus): Hono {
  const app = new Hono();

  // The renderer calls from a non-http origin (file:// in the packaged app
  // sends `Origin: null`, the Vite dev server a localhost origin). Anything
  // else — i.e. arbitrary websites open in a local browser — is refused.
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        if (origin === "null") return origin;
        try {
          const { hostname } = new URL(origin);
          if (hostname === "localhost" || hostname === "127.0.0.1") return origin;
        } catch {}
        return "";
      },
    }),
  );

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<{ name?: string; ticketPrefix?: string }>();
    if (!isNonEmptyString(body.name)) {
      return c.json({ error: "name is required" }, 400);
    }
    const project = store.createProject({ name: body.name, ticketPrefix: body.ticketPrefix });
    return c.json(project, 201);
  });

  app.get("/api/projects", (c) => c.json(store.listProjects()));

  app.get("/api/projects/:id", (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  app.post("/api/tickets", async (c) => {
    const body = await c.req.json<{
      projectId?: number;
      title?: string;
      description?: string;
      acceptanceCriteria?: string[];
    }>();
    if (typeof body.projectId !== "number") return c.json({ error: "projectId is required" }, 400);
    if (!isNonEmptyString(body.title)) {
      return c.json({ error: "title is required" }, 400);
    }
    const acs = body.acceptanceCriteria ?? [];
    if (!Array.isArray(acs) || !acs.every(isNonEmptyString)) {
      return c.json({ error: "acceptanceCriteria must be non-empty strings" }, 400);
    }
    const ticket = store.createTicket({
      projectId: body.projectId,
      title: body.title,
      description: body.description,
      acceptanceCriteria: acs,
    });
    return c.json(ticket, 201);
  });

  app.get("/api/tickets", (c) => {
    const projectId = c.req.query("projectId");
    return c.json(store.listTickets(projectId === undefined ? undefined : Number(projectId)));
  });

  app.get("/api/tickets/:id", (c) => {
    const ticket = store.getTicket(Number(c.req.param("id")));
    if (!ticket) return c.json({ error: "not found" }, 404);
    return c.json(ticket);
  });

  app.get("/api/tickets/:id/audit", (c) => {
    const ticket = store.getTicket(Number(c.req.param("id")));
    if (!ticket) return c.json({ error: "not found" }, 404);
    return c.json(store.listAuditEvents(ticket.id));
  });

  app.patch("/api/tickets/:id", async (c) => {
    const body = await c.req.json<{ title?: string; description?: string }>();
    const ticket = store.updateTicket(Number(c.req.param("id")), {
      title: body.title,
      description: body.description,
    });
    return c.json(ticket);
  });

  app.get("/api/events", (c) => {
    const lastEventId = Number(c.req.header("last-event-id") ?? 0);
    return streamSSE(c, async (stream) => {
      // eventsSince + subscribe run in the same tick, so no event can slip
      // between the replay snapshot and the live subscription.
      const queue: BusEvent[] = bus.eventsSince(Number.isFinite(lastEventId) ? lastEventId : 0);
      let notify: (() => void) | undefined;
      const unsubscribe = bus.subscribe((event) => {
        queue.push(event);
        notify?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        notify?.();
      });
      while (!closed) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event.data),
          });
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    });
  });

  app.onError((error, c) => {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
