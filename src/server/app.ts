import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { BusEvent, EventBus } from "./bus.ts";
import type { RunLogRegistry } from "./runlog.ts";
import { NotFoundError, StateError, ValidationError, type Store } from "./store.ts";
import { isProvider, PROVIDERS, type PreviewKind } from "./types.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function createApp(store: Store, bus: EventBus, runLogs: RunLogRegistry): Hono {
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
    const body = await c.req.json<{
      name?: string;
      ticketPrefix?: string;
      defaultProvider?: string;
    }>();
    if (!isNonEmptyString(body.name)) {
      return c.json({ error: "name is required" }, 400);
    }
    if (body.defaultProvider !== undefined && !isProvider(body.defaultProvider)) {
      return c.json({ error: `defaultProvider must be one of ${PROVIDERS.join(", ")}` }, 400);
    }
    const project = store.createProject({
      name: body.name,
      ticketPrefix: body.ticketPrefix,
      defaultProvider: body.defaultProvider,
    });
    return c.json(project, 201);
  });

  app.get("/api/projects", (c) => c.json(store.listProjects()));

  app.get("/api/projects/:id", (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  app.get("/api/projects/:id/audit", (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(store.listProjectAuditEvents(project.id));
  });

  app.post("/api/repos", async (c) => {
    const body = await c.req.json<{
      projectId?: number;
      path?: string;
      githubRemote?: string;
      targetBranch?: string;
      previewCommand?: string;
      previewKind?: string;
      previewReadinessPath?: string;
    }>();
    if (typeof body.projectId !== "number") return c.json({ error: "projectId is required" }, 400);
    if (!isNonEmptyString(body.path)) return c.json({ error: "path is required" }, 400);
    if (!isNonEmptyString(body.githubRemote)) {
      return c.json({ error: "githubRemote is required" }, 400);
    }
    if (body.previewKind !== undefined && body.previewKind !== "ui" && body.previewKind !== "api") {
      return c.json({ error: "previewKind must be ui or api" }, 400);
    }
    const repo = store.createRepo({
      projectId: body.projectId,
      path: body.path,
      githubRemote: body.githubRemote,
      targetBranch: isNonEmptyString(body.targetBranch) ? body.targetBranch : undefined,
      previewCommand: body.previewCommand,
      previewKind: body.previewKind as PreviewKind | undefined,
      previewReadinessPath: body.previewReadinessPath,
    });
    return c.json(repo, 201);
  });

  app.get("/api/repos", (c) => {
    const projectId = c.req.query("projectId");
    return c.json(store.listRepos(projectId === undefined ? undefined : Number(projectId)));
  });

  app.post("/api/tickets", async (c) => {
    const body = await c.req.json<{
      projectId?: number;
      title?: string;
      description?: string;
      externalRef?: string;
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
      externalRef: isNonEmptyString(body.externalRef) ? body.externalRef : undefined,
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

  app.get("/api/tickets/:id/runs", (c) => {
    const ticket = store.getTicket(Number(c.req.param("id")));
    if (!ticket) return c.json({ error: "not found" }, 404);
    return c.json(store.listRunsWithPhases(ticket.id));
  });

  // Per-run agent log: replay from Last-Event-ID, then live block events.
  app.get("/api/runs/:id/log", (c) => {
    const run = store.getRun(Number(c.req.param("id")));
    if (!run) return c.json({ error: "not found" }, 404);
    const log = runLogs.for(run.id);
    const lastEventId = Number(c.req.header("last-event-id") ?? 0);
    return streamSSE(c, async (stream) => {
      const queue = log.entriesSince(Number.isFinite(lastEventId) ? lastEventId : 0);
      let notify: (() => void) | undefined;
      const unsubscribe = log.subscribe((entry) => {
        queue.push(entry);
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
          const entry = queue.shift()!;
          await stream.writeSSE({
            id: String(entry.seq),
            event: entry.event.type,
            data: JSON.stringify(entry.event),
          });
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    });
  });

  app.get("/api/tickets/:id/audit", (c) => {
    const ticket = store.getTicket(Number(c.req.param("id")));
    if (!ticket) return c.json({ error: "not found" }, 404);
    return c.json(store.listAuditEvents(ticket.id));
  });

  app.post("/api/tickets/:id/promote", async (c) => {
    const body = await c.req.json<{ repoId?: number; provider?: string }>();
    if (typeof body.repoId !== "number") return c.json({ error: "repoId is required" }, 400);
    if (!isProvider(body.provider)) {
      return c.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
    }
    const ticket = store.promoteTicket(Number(c.req.param("id")), {
      repoId: body.repoId,
      provider: body.provider,
    });
    return c.json(ticket);
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
    if (error instanceof StateError) return c.json({ error: error.message }, 409);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
