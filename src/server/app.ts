import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { BusEvent, EventBus } from "./bus.ts";
import { GitHubUnavailableError, type Home } from "./home.ts";
import type { PreviewManager } from "./previews.ts";
import type { Reviews } from "./reviews.ts";
import type { RunLogRegistry } from "./runlog.ts";
import { NotFoundError, StateError, ValidationError, type Store } from "./store.ts";
import { isProvider, PROVIDERS, type PreviewKind } from "./types.ts";
import { DriftError, type Verdicts } from "./verdicts.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Defense in depth for served artifact content (ticket 11 §6, ported from
 * the prototype): even if the recap lint missed an external reference,
 * nothing may load from the network — inline styles/scripts and data: URIs
 * are all a self-contained artifact needs.
 */
const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";

/** Only extensions the workflow actually persists get a renderable type. */
function artifactContentType(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  // The demo recorder's video (ticket 35) — what the walkthrough's player loads.
  if (name.endsWith(".webm")) return "video/webm";
  return "text/plain; charset=utf-8";
}

export function createApp(
  store: Store,
  bus: EventBus,
  runLogs: RunLogRegistry,
  verdicts: Verdicts,
  reviews: Reviews,
  home: Home,
  previews: PreviewManager,
  /** Where the ArtifactStore blobbed run evidence; content serves from here. */
  dataDir: string,
): Hono {
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
      workflowId?: number;
    }>();
    if (!isNonEmptyString(body.name)) {
      return c.json({ error: "name is required" }, 400);
    }
    if (body.defaultProvider !== undefined && !isProvider(body.defaultProvider)) {
      return c.json({ error: `defaultProvider must be one of ${PROVIDERS.join(", ")}` }, 400);
    }
    if (body.workflowId !== undefined && typeof body.workflowId !== "number") {
      return c.json({ error: "workflowId must be a number" }, 400);
    }
    const project = store.createProject({
      name: body.name,
      ticketPrefix: body.ticketPrefix,
      defaultProvider: body.defaultProvider,
      workflowId: body.workflowId,
    });
    return c.json(project, 201);
  });

  // A project's workflow selection (ticket 43): forward-acting — the next
  // claim pins the new head version; running Runs keep theirs. No audit
  // event by design: the Run's pinned version is the record.
  app.patch("/api/projects/:id", async (c) => {
    const body = await c.req.json<{ workflowId?: number }>();
    if (typeof body.workflowId !== "number") {
      return c.json({ error: "workflowId is required" }, 400);
    }
    return c.json(store.setProjectWorkflow(Number(c.req.param("id")), body.workflowId));
  });

  // The app-global Workflow library (ticket 43): identity ops only — content
  // is immutable versions, and creation is duplicate-only until the editor.
  app.get("/api/workflows", (c) => c.json(store.listWorkflows()));
  app.post("/api/workflows/:id/duplicate", (c) =>
    c.json(store.duplicateWorkflow(Number(c.req.param("id"))), 201),
  );
  app.patch("/api/workflows/:id", async (c) => {
    const body = await c.req.json<{ name?: string }>();
    if (typeof body.name !== "string") return c.json({ error: "name is required" }, 400);
    return c.json(store.renameWorkflow(Number(c.req.param("id")), body.name));
  });
  app.post("/api/workflows/:id/default", (c) =>
    c.json(store.setDefaultWorkflow(Number(c.req.param("id")))),
  );
  app.post("/api/workflows/:id/archive", async (c) => {
    const body = await c.req.json<{ successorId?: number }>().catch(() => ({}) as { successorId?: number });
    if (body.successorId !== undefined && typeof body.successorId !== "number") {
      return c.json({ error: "successorId must be a number" }, 400);
    }
    return c.json(store.archiveWorkflow(Number(c.req.param("id")), body.successorId));
  });
  app.post("/api/workflows/:id/unarchive", (c) =>
    c.json(store.unarchiveWorkflow(Number(c.req.param("id")))),
  );

  app.get("/api/projects", (c) => c.json(store.listProjects()));

  // Home's clone pane (ticket A): the user's own+org repos, tracked ones flagged.
  // GitHub being unreachable disables cloning, never the recents list — the
  // error body is the message the pane shows.
  app.get("/api/github/repos", async (c) => {
    try {
      return c.json({ repos: await home.listGitHubRepos() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/github/clone", async (c) => {
    const result = await home.clone(await c.req.json());
    if (result.alreadyTracked) return c.json({ alreadyTracked: true, project: result.project });
    return c.json({ project: result.project, repo: result.repo }, 201);
  });

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
      previewReadinessTimeoutMs?: number;
      testCommand?: string;
      personaPath?: string;
    }>();
    if (typeof body.projectId !== "number") return c.json({ error: "projectId is required" }, 400);
    if (!isNonEmptyString(body.path)) return c.json({ error: "path is required" }, 400);
    if (!isNonEmptyString(body.githubRemote)) {
      return c.json({ error: "githubRemote is required" }, 400);
    }
    if (body.previewKind !== undefined && body.previewKind !== "ui" && body.previewKind !== "api") {
      return c.json({ error: "previewKind must be ui or api" }, 400);
    }
    if (
      body.previewReadinessTimeoutMs !== undefined &&
      (typeof body.previewReadinessTimeoutMs !== "number" || body.previewReadinessTimeoutMs <= 0)
    ) {
      return c.json({ error: "previewReadinessTimeoutMs must be a positive number" }, 400);
    }
    const repo = store.createRepo({
      projectId: body.projectId,
      path: body.path,
      githubRemote: body.githubRemote,
      targetBranch: isNonEmptyString(body.targetBranch) ? body.targetBranch : undefined,
      previewCommand: body.previewCommand,
      previewKind: body.previewKind as PreviewKind | undefined,
      previewReadinessPath: body.previewReadinessPath,
      previewReadinessTimeoutMs: body.previewReadinessTimeoutMs,
      testCommand: body.testCommand,
      personaPath: isNonEmptyString(body.personaPath) ? body.personaPath : undefined,
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

  // Everything the review wizard opens on (ticket 32): the latest Run's
  // evidence plus live GitHub chrome (PR mergeability, branch-tip freshness).
  app.get("/api/tickets/:id/review", async (c) =>
    c.json(await reviews.forTicket(Number(c.req.param("id")))),
  );

  // Raw artifact content out of the blob store — what the recap iframe and
  // the wizard's markdown/preview panes load. The deny-external CSP is
  // defense in depth on top of the renderer's sandboxed iframe.
  app.get("/api/artifacts/:id/content", (c) => {
    const artifact = store.getArtifact(Number(c.req.param("id")));
    if (!artifact) return c.json({ error: "not found" }, 404);
    let content: Buffer;
    try {
      content = readFileSync(path.join(dataDir, artifact.path));
    } catch {
      return c.json({ error: "artifact blob missing from disk" }, 404);
    }
    return c.body(new Uint8Array(content), 200, {
      "content-type": artifactContentType(artifact.name),
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
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

  // The wizard's Manual Walkthrough preview (ticket 34): status/link view,
  // on-demand start when the wizard opens, and restart. No stop route — the
  // lifecycle is deliberate (ticket 10): the process stops on verdict submit
  // and app quit, nothing else. A repo without preview config answers
  // configured:false, never an error — the step degrades, the review goes on.
  app.get("/api/tickets/:id/preview", (c) => c.json(previews.view(Number(c.req.param("id")))));
  app.post("/api/tickets/:id/preview/start", async (c) =>
    c.json(await previews.start(Number(c.req.param("id")))),
  );
  app.post("/api/tickets/:id/preview/restart", async (c) =>
    c.json(await previews.restart(Number(c.req.param("id")))),
  );

  // The verdict actions (tickets 31 + 33): pass merges through the
  // GitHubPort (force waives recorded drift, audited); fail bounces with the
  // reviewer's noted steps; reverify is the drift choice that buys a fresh
  // battery run instead of waiving.
  app.post("/api/tickets/:id/verdict", async (c) => {
    const body = await c.req.json<{ outcome?: string; force?: boolean; steps?: unknown }>();
    const ticketId = Number(c.req.param("id"));
    let result: unknown;
    if (body.outcome === "pass") {
      result = await verdicts.pass(ticketId, { force: body.force === true });
    } else if (body.outcome === "fail") {
      result = await verdicts.fail(ticketId, body.steps);
    } else if (body.outcome === "reverify") {
      result = await verdicts.reverify(ticketId);
    } else {
      return c.json({ error: 'outcome must be "pass", "fail", or "reverify"' }, 400);
    }
    // The review is over either way — the preview stops with it (ticket 34).
    // Best-effort: a stop hiccup must not turn a landed verdict into an error.
    await previews.stop(ticketId).catch(() => {});
    return c.json(result);
  });

  // The Manual Walkthrough's human verdicts on individual ACs (ticket 33):
  // verified or failed with human provenance. Like waiving, legal in any
  // state — a human observation is never illegal, merely forward-acting.
  app.post("/api/acs/:id/verify", (c) =>
    c.json(store.settleAcByHuman(Number(c.req.param("id")), "verified")),
  );
  app.post("/api/acs/:id/fail", (c) =>
    c.json(store.settleAcByHuman(Number(c.req.param("id")), "failed")),
  );

  // A reviewer answers an open dogfood "Decision for a human" (ticket 37):
  // it never gates or moves the ticket — the answer lands in the Audit Trail.
  app.post("/api/tickets/:id/dogfood-decisions", async (c) => {
    const body = await c.req.json<{ decisionId?: string; question?: string; answer?: string }>();
    if (!isNonEmptyString(body.decisionId) || !isNonEmptyString(body.answer)) {
      return c.json({ error: "a decision answer needs a decisionId and a non-empty answer" }, 400);
    }
    return c.json(
      store.answerDogfoodDecision(Number(c.req.param("id")), {
        decisionId: body.decisionId,
        question: typeof body.question === "string" ? body.question : "",
        answer: body.answer,
      }),
    );
  });

  // Waiving is human-only with a mandatory reason, legal in any state —
  // retiring an aspirational AC before it burns a bounce cycle is legitimate.
  app.post("/api/acs/:id/waive", async (c) => {
    const body = await c.req.json<{ reason?: string }>();
    if (!isNonEmptyString(body.reason)) {
      return c.json({ error: "a waive requires a reason" }, 400);
    }
    return c.json(store.waiveAc(Number(c.req.param("id")), body.reason));
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
    // Structured so the wizard can offer re-verify / force-merge without
    // parsing prose; still a 409 StateError to every other caller.
    if (error instanceof DriftError) {
      return c.json({ error: error.message, drift: error.reasons }, 409);
    }
    if (error instanceof StateError) return c.json({ error: error.message }, 409);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof GitHubUnavailableError) return c.json({ error: error.message }, 502);
    if (error instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
