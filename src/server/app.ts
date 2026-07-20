import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { BusEvent, EventBus } from "./bus.ts";
import {
  listLocalServers,
  listRepoFiles,
  pickFolderNative,
  readRepoFile,
  revealInFinder,
  type Home,
} from "./home.ts";
import type { PreviewManager } from "./previews.ts";
import type { Reviews } from "./reviews.ts";
import type { RunLogRegistry } from "./runlog.ts";
import { DraftInvalidError, NotFoundError, StateError, ValidationError, type Store } from "./store.ts";
import type { DoneSweeper } from "./sweep.ts";
import { isProvider, PROVIDERS, type PreviewKind, type ProviderConfig } from "./types.ts";
import { DriftError, type Verdicts } from "./verdicts.ts";
import { git } from "./worktrees.ts";
import type { ProviderRegistry } from "./provider.ts";
import { runWorkflowChat } from "./workflow-chat.ts";
import { validateDraftGraph } from "./workflow-validate.ts";

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
  sweeper: DoneSweeper,
  /** Where the ArtifactStore blobbed run evidence; content serves from here. */
  dataDir: string,
  /** For the draft-edit chat (one provider phase per message); empty in
   *  tests that never chat. */
  providers: ProviderRegistry = {},
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
    const body = await c.req.json<{ workflowId?: number; workflowConfirmed?: boolean }>();
    if (typeof body.workflowId === "number") {
      return c.json(store.setProjectWorkflow(Number(c.req.param("id")), body.workflowId));
    }
    // "Keep it" on the board's first-view ask: confirm without changing.
    if (body.workflowConfirmed === true) {
      return c.json(store.confirmProjectWorkflow(Number(c.req.param("id"))));
    }
    return c.json({ error: "workflowId or workflowConfirmed is required" }, 400);
  });

  // The app-global Workflow library (ticket 43): identity ops only — content
  // is immutable versions, and creation is duplicate-only until the editor.
  app.get("/api/workflows", (c) => c.json(store.listWorkflows()));
  app.post("/api/workflows", async (c) => {
    type CreateBody = {
      name?: string;
      description?: string;
      color?: string | null;
      icon?: string | null;
    };
    const body = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
    if (body.name !== undefined && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return c.json({ error: "description must be a string" }, 400);
    }
    if (body.color !== undefined && body.color !== null && typeof body.color !== "string") {
      return c.json({ error: "color must be a string or null" }, 400);
    }
    if (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string") {
      return c.json({ error: "icon must be a string or null" }, 400);
    }
    return c.json(store.createWorkflow(body.name, body.description, body.color, body.icon), 201);
  });
  app.delete("/api/workflows/:id", (c) => {
    store.deleteWorkflow(Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/workflows/:id/duplicate", (c) =>
    c.json(store.duplicateWorkflow(Number(c.req.param("id"))), 201),
  );
  app.patch("/api/workflows/:id", async (c) => {
    const body = await c.req.json<{
      name?: string;
      description?: string;
      color?: string | null;
      icon?: string | null;
    }>();
    if (body.name !== undefined && typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return c.json({ error: "description must be a string" }, 400);
    }
    if (body.color !== undefined && body.color !== null && typeof body.color !== "string") {
      return c.json({ error: "color must be a string or null" }, 400);
    }
    if (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string") {
      return c.json({ error: "icon must be a string or null" }, 400);
    }
    if (
      body.name === undefined &&
      body.description === undefined &&
      body.color === undefined &&
      body.icon === undefined
    ) {
      return c.json({ error: "name, description, color, or icon is required" }, 400);
    }
    return c.json(
      store.updateWorkflow(Number(c.req.param("id")), {
        name: body.name,
        description: body.description,
        color: body.color,
        icon: body.icon,
      }),
    );
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

  // The Draft (ticket 47): the mutable editing layer over immutable versions.
  // GET is get-or-create (first touch cuts it from the head), PUT replaces
  // the graph (shape-checked only — a mid-edit draft may be invalid),
  // validate returns the full violation list, publish appends the new head
  // or answers 400 with that same list, DELETE discards.
  // The head version, read-only (ticket 48): the editor's opening render.
  app.get("/api/workflows/:id/head", (c) =>
    c.json(store.getWorkflowHeadGraph(Number(c.req.param("id")))),
  );
  app.get("/api/workflows/:id/draft", (c) =>
    c.json(store.getWorkflowDraft(Number(c.req.param("id")))),
  );
  app.put("/api/workflows/:id/draft", async (c) =>
    c.json(store.updateWorkflowDraft(Number(c.req.param("id")), await c.req.json())),
  );
  app.post("/api/workflows/:id/draft/validate", (c) =>
    c.json({ violations: store.validateWorkflowDraft(Number(c.req.param("id"))) }),
  );
  app.post("/api/workflows/:id/draft/publish", (c) =>
    c.json(store.publishWorkflowDraft(Number(c.req.param("id")))),
  );
  app.delete("/api/workflows/:id/draft", (c) =>
    c.json(store.discardWorkflowDraft(Number(c.req.param("id")))),
  );

  // The draft-edit chat (ticket 48 follow-on): one provider phase per
  // message. The model answers with a full replacement graph; the same
  // shape check as PUT guards the save, so a hallucinated graph is a 502
  // and the draft stays as it was.
  app.post("/api/workflows/:id/draft/chat", async (c) => {
    const body = await c.req.json<{ message?: string; provider?: string }>();
    if (!isNonEmptyString(body.message)) {
      return c.json({ error: "message is required" }, 400);
    }
    const providerName = body.provider ?? "claude-code";
    if (!isProvider(providerName)) {
      return c.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
    }
    const provider = providers[providerName];
    if (!provider) {
      return c.json({ error: `provider ${providerName} is not available` }, 503);
    }
    const id = Number(c.req.param("id"));
    // Read without cutting a draft: a chat that fails must leave no trace,
    // so the head graph stands in until a successful save (which is the
    // first touch that cuts the draft, same as the editor's PUT).
    const head = store.getWorkflowHeadGraph(id);
    const graph = head.hasDraft ? store.getWorkflowDraft(id).graph : head.graph;
    const outcome = await runWorkflowChat(provider, graph, body.message, dataDir);
    if (!outcome.ok) return c.json({ error: outcome.error }, 502);
    // Manual edits may leave a draft invalid until Publish, but a chat edit
    // is refused outright: the publish validator's verdict is the reason the
    // user sees, and the draft stays exactly as it was.
    let violations;
    try {
      violations = validateDraftGraph(outcome.graph);
    } catch {
      // The validator assumes a shaped graph; a throw means it wasn't one.
      return c.json({ error: "the model returned an invalid graph: not a graph shape" }, 502);
    }
    if (violations.length > 0) {
      return c.json(
        { error: `that edit was refused: ${violations.map((v) => v.message).join("; ")}` },
        422,
      );
    }
    try {
      return c.json({ reply: outcome.reply, draft: store.updateWorkflowDraft(id, outcome.graph) });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: `the model returned an invalid graph: ${error.message}` }, 502);
      }
      throw error;
    }
  });

  // App-level provider config (ticket 38): one row per provider name, shared
  // by every Project. Adapters read it fresh per phase, so a save here lands
  // on the next claim without an app restart.
  app.get("/api/provider-config", (c) => c.json(store.listProviderConfigs()));
  app.patch("/api/provider-config/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: `unknown provider ${provider}` }, 404);
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    const patch: Partial<Omit<ProviderConfig, "provider">> = {};
    // Present-and-null clears; absent leaves alone. Empty strings from a form
    // field are the user blanking it, which is the same as clearing.
    for (const field of ["binaryPath", "model"] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null) patch[field] = null;
      else if (typeof value === "string") {
        // Trim before testing for empty, or a field the user cleared to
        // whitespace would store "" and read as a pinned model named nothing.
        const trimmed = value.trim();
        patch[field] = trimmed === "" ? null : trimmed;
      } else return c.json({ error: `${field} must be a string or null` }, 400);
    }
    if ("maxBudgetUsd" in body) {
      const value = body.maxBudgetUsd;
      if (value === null || value === "") patch.maxBudgetUsd = null;
      else if (typeof value === "number" && Number.isFinite(value)) patch.maxBudgetUsd = value;
      else return c.json({ error: "maxBudgetUsd must be a number or null" }, 400);
    }
    if ("env" in body) {
      const value = body.env;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return c.json({ error: "env must be an object" }, 400);
      }
      if (Object.values(value).some((v) => typeof v !== "string")) {
        return c.json({ error: "env values must be strings" }, 400);
      }
      patch.env = value as Record<string, string>;
    }
    return c.json(store.setProviderConfig(provider, patch));
  });

  app.get("/api/projects", (c) =>
    c.json(store.listProjects({ includeHidden: c.req.query("includeHidden") === "1" })),
  );

  // Renderers without the Electron preload (vite dev in a browser) still get
  // the native chooser: the server owns the dialog. Null path = cancelled.
  app.post("/api/pick-folder", async (c) => c.json({ path: await pickFolderNative() }));

  // The right panel's Browser surface: listening localhost ports to offer as
  // one-click destinations.
  app.get("/api/local-servers", async (c) => c.json(await listLocalServers()));

  // Home's add-project flow: register a repo already on disk. Picking an
  // already-tracked checkout (or a second checkout of a tracked remote)
  // reopens the existing Project instead of creating a duplicate.
  app.post("/api/projects/local", async (c) => {
    const result = await home.addLocal(await c.req.json());
    if (result.alreadyTracked) return c.json({ alreadyTracked: true, project: result.project });
    return c.json({ project: result.project, repo: result.repo }, 201);
  });

  app.get("/api/projects/:id", (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  // Archive from Home's recents (ticket 50): the row leaves the default
  // listing, nothing is deleted. Unarchive (or re-adding the checkout via
  // /api/projects/local) brings it back.
  app.post("/api/projects/:id/hide", (c) =>
    c.json(store.hideProject(Number(c.req.param("id")))),
  );

  app.post("/api/projects/:id/unhide", (c) =>
    c.json(store.unhideProject(Number(c.req.param("id")))),
  );

  // Soft delete: gone from every listing, row kept for references. Recovery
  // is re-adding the checkout via /api/projects/local.
  app.delete("/api/projects/:id", (c) =>
    c.json(store.deleteProject(Number(c.req.param("id")))),
  );

  // Row menu's "Reveal in Finder": the server owns the shell, same as the
  // folder picker. A project with no registered repo has nothing to reveal.
  app.post("/api/projects/:id/reveal", async (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    const repo = store.listRepos(project.id)[0];
    if (!repo) throw new StateError(`project ${project.name} has no registered repo`);
    await revealInFinder(repo.path);
    return c.json({ ok: true });
  });

  // The right panel's Files surface: the repo's file list (tracked +
  // untracked-not-ignored) and single-file reads.
  app.get("/api/projects/:id/files", async (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    const repo = store.listRepos(project.id)[0];
    if (!repo) throw new StateError(`project ${project.name} has no registered repo`);
    return c.json({ root: path.basename(repo.path), files: await listRepoFiles(repo.path) });
  });

  app.get("/api/projects/:id/file", async (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    const repo = store.listRepos(project.id)[0];
    if (!repo) throw new StateError(`project ${project.name} has no registered repo`);
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path is required" }, 400);
    return c.json(await readRepoFile(repo.path, rel));
  });

  app.get("/api/projects/:id/audit", (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(store.listProjectAuditEvents(project.id));
  });

  // The Done-column sweep (ticket 42): deliberate, batched disk hygiene.
  // The response is the whole story — what was reaped, what was skipped and
  // why; nothing disappears silently.
  app.post("/api/projects/:id/sweep", async (c) =>
    c.json(await sweeper.sweep(Number(c.req.param("id")))),
  );

  app.post("/api/repos", async (c) => {
    const body = await c.req.json<{
      projectId?: number;
      path?: string;
      githubRemote?: string | null;
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
    // Null/omitted = a local-only Repo (docs/tickets/local-only-projects.md);
    // when given, the remote must at least be a non-empty string.
    if (
      body.githubRemote !== undefined &&
      body.githubRemote !== null &&
      !isNonEmptyString(body.githubRemote)
    ) {
      return c.json({ error: "githubRemote must be a non-empty string or null" }, 400);
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
      githubRemote: body.githubRemote ?? null,
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

  // Rows carry gitMissing, derived from disk at read time (types.ts
  // RepoListItem): a folder registered before `git init` banners on the
  // board, and the flag clears itself the moment init runs.
  app.get("/api/repos", (c) => {
    const projectId = c.req.query("projectId");
    const rows = store.listRepos(projectId === undefined ? undefined : Number(projectId));
    return c.json(
      rows.map((repo) => ({ ...repo, gitMissing: !existsSync(path.join(repo.path, ".git")) })),
    );
  });

  // The board banner's "Initialise git": turn a registered plain folder into
  // a repo on its recorded target branch. Idempotent — an already-initted
  // checkout just reports gitMissing: false.
  app.post("/api/repos/:id/git-init", async (c) => {
    const repo = store.getRepo(Number(c.req.param("id")));
    if (!repo) return c.json({ error: "not found" }, 404);
    if (!existsSync(path.join(repo.path, ".git"))) {
      await git(repo.path, "init", "-b", repo.targetBranch);
    }
    return c.json({ ...repo, gitMissing: false });
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
    // Structured like DriftError: the editor renders violations on the
    // offending nodes and edges, so the list rides along with the message.
    if (error instanceof DraftInvalidError) {
      return c.json({ error: error.message, violations: error.violations }, 400);
    }
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
