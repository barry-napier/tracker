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
  repoWorkingDiff,
  revealInFinder,
  type Home,
} from "./home.ts";
import type { PreviewManager } from "./previews.ts";
import type { Reviews } from "./reviews.ts";
import { RunLogRegistry } from "./runlog.ts";
import { draftToTicketInput, runIntakeTurn } from "./intake.ts";
import {
  INTAKE_KINDS,
  isIntakeKind,
  isTicketKind,
  TICKET_KINDS,
  type IntakeBreakdown,
  type IntakeDraft,
} from "./types.ts";
import { DraftInvalidError, NotFoundError, StateError, ValidationError, type Store } from "./store.ts";
import type { DoneSweeper } from "./sweep.ts";
import { parseTimeOfDay } from "./automation-schedule.ts";
import {
  AUTOMATION_CADENCES,
  isAutomationCadence,
  isProvider,
  PROVIDERS,
  type AutomationCadence,
  type AutomationPriority,
  type PreviewKind,
  type ProviderInstance,
} from "./types.ts";
import { availabilityReason } from "./availability.ts";
import { NullGitHub, repoSlug, type GitHubPort } from "./github.ts";
import { GitHubAuth, PlaintextCipher } from "./auth.ts";
import { DriftError, type Verdicts } from "./verdicts.ts";
import { git } from "./worktrees.ts";
import type { ProviderRegistry } from "./provider.ts";
import { runWorkflowChat } from "./workflow-chat.ts";
import { validateDraftGraph } from "./workflow-validate.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The shared create/patch validation for Automations: every optional field
 * checked the same way in both routes; title/prompt/enabled stay route-local
 * (required on create, optional on patch).
 */
function parseAutomationBody(
  body: Record<string, unknown>,
  hasProviderInstance: (id: string) => boolean,
):
  | { patch: Partial<{
      category: string;
      priority: AutomationPriority;
      cadence: AutomationCadence;
      timeOfDay: string | null;
      dayOfWeek: number | null;
      projectId: number | null;
      provider: string | null;
    }> }
  | { error: string } {
  const patch: Extract<ReturnType<typeof parseAutomationBody>, { patch: unknown }>["patch"] = {};
  if ("category" in body) {
    if (!isNonEmptyString(body.category)) return { error: "category must be a non-empty string" };
    patch.category = body.category;
  }
  if ("priority" in body) {
    if (body.priority !== "low" && body.priority !== "medium" && body.priority !== "high") {
      return { error: "priority must be low, medium, or high" };
    }
    patch.priority = body.priority;
  }
  if ("cadence" in body) {
    if (!isAutomationCadence(body.cadence)) {
      return { error: `cadence must be one of ${AUTOMATION_CADENCES.join(", ")}` };
    }
    patch.cadence = body.cadence;
  }
  if ("timeOfDay" in body) {
    if (body.timeOfDay === null) patch.timeOfDay = null;
    else if (typeof body.timeOfDay === "string" && parseTimeOfDay(body.timeOfDay) !== null) {
      patch.timeOfDay = body.timeOfDay;
    } else return { error: "timeOfDay must be HH:MM or null" };
  }
  if ("dayOfWeek" in body) {
    if (body.dayOfWeek === null) patch.dayOfWeek = null;
    else if (
      typeof body.dayOfWeek === "number" &&
      Number.isInteger(body.dayOfWeek) &&
      body.dayOfWeek >= 0 &&
      body.dayOfWeek <= 6
    ) {
      patch.dayOfWeek = body.dayOfWeek;
    } else return { error: "dayOfWeek must be 0-6 or null" };
  }
  if ("projectId" in body) {
    if (body.projectId === null) patch.projectId = null;
    else if (typeof body.projectId === "number") patch.projectId = body.projectId;
    else return { error: "projectId must be a number or null" };
  }
  if ("provider" in body) {
    if (body.provider === null) patch.provider = null;
    else if (typeof body.provider === "string" && hasProviderInstance(body.provider)) {
      patch.provider = body.provider;
    } else return { error: "provider must be null or a configured provider instance id" };
  }
  return { patch };
}

/** Template create/patch: the optional chip fields, shared by both routes. */
function parseTemplateBody(
  body: Record<string, unknown>,
): { patch: Partial<{ category: string; priority: AutomationPriority }> } | { error: string } {
  const patch: Partial<{ category: string; priority: AutomationPriority }> = {};
  if ("category" in body) {
    if (!isNonEmptyString(body.category)) return { error: "category must be a non-empty string" };
    patch.category = body.category;
  }
  if ("priority" in body) {
    if (body.priority !== "low" && body.priority !== "medium" && body.priority !== "high") {
      return { error: "priority must be low, medium, or high" };
    }
    patch.priority = body.priority;
  }
  return { patch };
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
  /** Team work's repo/PR listings; defaults to the honest-zero backing. */
  github: GitHubPort = new NullGitHub(),
  /** GitHub identity (ADR-0006); tests build one on a PlaintextCipher. */
  auth: GitHubAuth = new GitHubAuth(store, new PlaintextCipher()),
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
    if (body.defaultProvider !== undefined && !store.getProviderInstance(body.defaultProvider)) {
      return c.json({ error: "defaultProvider must be a configured provider instance id" }, 400);
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
    const body = await c.req.json<{ message?: string; provider?: string; model?: string }>();
    if (!isNonEmptyString(body.message)) {
      return c.json({ error: "message is required" }, 400);
    }
    // The renderer sends a ProviderInstance id; a bare request without one
    // falls back to any registered instance rather than a hard-coded name —
    // registry keys are instance ids, not driver names.
    const providerName = body.provider ?? Object.keys(providers)[0] ?? "claude-code";
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
    const outcome = await runWorkflowChat(
      provider,
      graph,
      body.message,
      dataDir,
      undefined,
      isNonEmptyString(body.model) ? body.model : undefined,
    );
    if (!outcome.ok) return c.json({ error: outcome.error }, 502);
    // Chat edits get manual-edit parity: a shape-valid graph saves even when
    // the publish validator objects — scaffolding an incomplete draft is the
    // builder's whole point. The violations ride back on the response so the
    // canvas paints them exactly as a Test run would; only an unshaped graph
    // (not a graph at all) is refused, and then the draft stays untouched.
    let violations;
    try {
      violations = validateDraftGraph(outcome.graph);
    } catch {
      // The validator assumes a shaped graph; a throw means it wasn't one.
      return c.json({ error: "the model returned an invalid graph: not a graph shape" }, 502);
    }
    try {
      return c.json({
        reply: outcome.reply,
        draft: store.updateWorkflowDraft(id, outcome.graph),
        violations,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: `the model returned an invalid graph: ${error.message}` }, 502);
      }
      throw error;
    }
  });

  // AI ticket intake: the pre-Backlog grilling conversation (see intake.ts).
  // One provider phase per turn, run synchronously in the route like the
  // draft-edit chat; the per-session SSE log is the live view meanwhile. A
  // failed turn persists nothing — retry resends the same answer.
  const intakeLogs = new RunLogRegistry();
  // One provider turn at a time per session — a double-fired kick (dev
  // StrictMode, an impatient retry) must not run two research phases.
  const intakeTurnsInFlight = new Set<number>();

  const runIntake = async (
    sessionId: number,
    userText: string | null,
  ): Promise<{ status: 200 | 400 | 404 | 409 | 502 | 503; body: unknown }> => {
    const session = store.getIntakeSession(sessionId);
    if (!session) return { status: 404, body: { error: "not found" } };
    if (session.status === "approved" || session.status === "discarded") {
      return { status: 400, body: { error: `session is ${session.status}` } };
    }
    const provider = providers[session.provider];
    if (!provider) {
      return { status: 503, body: { error: `provider ${session.provider} is not available` } };
    }
    const repo = store.getRepo(session.repoId);
    if (!repo) return { status: 404, body: { error: "repo not found" } };
    if (intakeTurnsInFlight.has(sessionId)) {
      return { status: 409, body: { error: "a turn is already running for this session" } };
    }
    intakeTurnsInFlight.add(sessionId);
    try {
      const turns =
        userText === null
          ? session.transcript
          : [...session.transcript, { role: "user", text: userText } as const];
      const outcome = await runIntakeTurn(
        provider,
        session.kind,
        session.intent,
        turns,
        repo.path,
        intakeLogs.for(sessionId),
      );
      if (!outcome.ok) return { status: 502, body: { error: outcome.error } };
      const updated = store.updateIntakeSession(sessionId, {
        transcript: [...turns, outcome.turn],
        draft: "draft" in outcome.turn ? outcome.turn.draft : undefined,
        breakdown: "breakdown" in outcome.turn ? outcome.turn.breakdown : undefined,
      });
      return { status: 200, body: updated };
    } finally {
      intakeTurnsInFlight.delete(sessionId);
    }
  };

  app.post("/api/intake", async (c) => {
    const body = await c.req.json<{
      projectId?: number;
      repoId?: number;
      provider?: string;
      kind?: string;
      intent?: string;
    }>();
    if (typeof body.projectId !== "number") return c.json({ error: "projectId is required" }, 400);
    if (typeof body.repoId !== "number") return c.json({ error: "repoId is required" }, 400);
    if (!isNonEmptyString(body.intent)) return c.json({ error: "intent is required" }, 400);
    const kind = body.kind ?? "feature";
    if (!isIntakeKind(kind)) {
      return c.json({ error: `kind must be one of ${INTAKE_KINDS.join(", ")}` }, 400);
    }
    // A ProviderInstance id (main's registry keys), not a driver name.
    const providerName =
      body.provider ?? store.listProviderInstances().find((i) => i.enabled)?.id ?? "claude-code";
    if (!store.getProviderInstance(providerName)) {
      return c.json({ error: `provider ${providerName} is not configured` }, 400);
    }
    const session = store.createIntakeSession({
      projectId: body.projectId,
      repoId: body.repoId,
      provider: providerName,
      kind,
      intent: body.intent.trim(),
    });
    // Create-only: the intake view kicks the first (long) research turn via
    // /retry after navigating, so the launch button answers instantly.
    return c.json(session, 201);
  });

  app.get("/api/intake", (c) => {
    const projectId = c.req.query("projectId");
    if (projectId === undefined) return c.json({ error: "projectId is required" }, 400);
    return c.json(store.listIntakeSessions(Number(projectId)));
  });

  // turnInFlight lets a reloaded view re-attach to a running turn (show the
  // busy state and poll) instead of double-kicking into a 409.
  app.get("/api/intake/:id", (c) => {
    const session = store.getIntakeSession(Number(c.req.param("id")));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ ...session, turnInFlight: intakeTurnsInFlight.has(session.id) });
  });

  app.post("/api/intake/:id/reply", async (c) => {
    const body = await c.req.json<{ message?: string }>();
    if (!isNonEmptyString(body.message)) return c.json({ error: "message is required" }, 400);
    const result = await runIntake(Number(c.req.param("id")), body.message.trim());
    return c.json(result.body as object, result.status);
  });

  // A retry for a session whose last provider turn failed: re-run against
  // the persisted transcript without adding an answer.
  app.post("/api/intake/:id/retry", async (c) => {
    const result = await runIntake(Number(c.req.param("id")), null);
    return c.json(result.body as object, result.status);
  });

  app.post("/api/intake/:id/approve", async (c) => {
    const id = Number(c.req.param("id"));
    const session = store.getIntakeSession(id);
    if (!session) return c.json({ error: "not found" }, 404);
    const body = await c.req
      .json<{ draft?: IntakeDraft; breakdown?: IntakeBreakdown }>()
      .catch(() => ({}) as { draft?: IntakeDraft; breakdown?: IntakeBreakdown });

    // Initiative sessions approve a breakdown: every ticket in it lands in
    // Backlog as its own feature/bug; remaining fog keeps the session open.
    if (session.kind === "initiative") {
      const breakdown = body.breakdown ?? session.breakdown;
      if (!breakdown) return c.json({ error: "no breakdown to approve yet" }, 400);
      if (!Array.isArray(breakdown.tickets) || breakdown.tickets.length === 0) {
        return c.json({ error: "the breakdown has no tickets to approve" }, 400);
      }
      for (const t of breakdown.tickets) {
        if (
          !isTicketKind(t?.kind) ||
          !isNonEmptyString(t?.title) ||
          !Array.isArray(t?.acs) ||
          t.acs.length === 0 ||
          !t.acs.every((ac) => isNonEmptyString(ac?.text))
        ) {
          return c.json(
            { error: "every breakdown ticket needs a kind (bug|feature), title, and at least one AC" },
            400,
          );
        }
      }
      const inputs = breakdown.tickets.map((t) => ({ kind: t.kind, ...draftToTicketInput(t) }));
      const { session: updated, tickets } = store.approveIntakeBreakdown(id, breakdown, inputs);
      return c.json({ session: updated, tickets }, 201);
    }

    // The human's edited draft wins; the session's stands otherwise.
    const draft = body.draft ?? session.draft;
    if (!draft) return c.json({ error: "no draft to approve yet" }, 400);
    if (
      !isNonEmptyString(draft.title) ||
      typeof draft.description !== "string" ||
      !Array.isArray(draft.acs) ||
      draft.acs.length === 0 ||
      !draft.acs.every((ac) => isNonEmptyString(ac?.text))
    ) {
      return c.json({ error: "draft must carry a title and at least one AC" }, 400);
    }
    const { session: updated, ticket } = store.approveIntakeSession(id, draftToTicketInput(draft));
    return c.json({ session: updated, ticket }, 201);
  });

  app.delete("/api/intake/:id", (c) => {
    const session = store.discardIntakeSession(Number(c.req.param("id")));
    return c.json(session);
  });

  // Live agent activity for a session's running turn: same block-event SSE
  // as the per-run log, keyed by session id.
  app.get("/api/intake/:id/log", (c) => {
    const session = store.getIntakeSession(Number(c.req.param("id")));
    if (!session) return c.json({ error: "not found" }, 404);
    const log = intakeLogs.for(session.id);
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

  // Automations: recurring agent tasks. Templates are saved starting points
  // (seeded from v1's recurring items, user-editable since migration 24);
  // rows are the standing orders; run fires one by hand exactly as the
  // scheduler would.
  app.get("/api/automation-templates", (c) => c.json(store.listAutomationTemplates()));
  app.post("/api/automation-templates", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const parsed = parseTemplateBody(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (!isNonEmptyString(body.title)) return c.json({ error: "title is required" }, 400);
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return c.json({ error: "prompt is required" }, 400);
    }
    return c.json(
      store.createAutomationTemplate({ ...parsed.patch, title: body.title, prompt: body.prompt }),
      201,
    );
  });
  app.patch("/api/automation-templates/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const parsed = parseTemplateBody(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const patch: Parameters<Store["updateAutomationTemplate"]>[1] = { ...parsed.patch };
    if (isNonEmptyString(body.title)) patch.title = body.title;
    if (typeof body.prompt === "string" && body.prompt.trim() !== "") patch.prompt = body.prompt;
    return c.json(store.updateAutomationTemplate(Number(c.req.param("id")), patch));
  });
  app.delete("/api/automation-templates/:id", (c) => {
    store.deleteAutomationTemplate(Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.get("/api/automations", (c) => c.json(store.listAutomations()));
  app.post("/api/automations", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const parsed = parseAutomationBody(body, (id) => store.getProviderInstance(id) !== undefined);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (!isNonEmptyString(body.title)) return c.json({ error: "title is required" }, 400);
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return c.json({ error: "prompt is required" }, 400);
    }
    if (typeof parsed.patch.projectId === "number" && !store.getProject(parsed.patch.projectId)) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json(
      store.createAutomation({ ...parsed.patch, title: body.title, prompt: body.prompt }),
      201,
    );
  });
  app.patch("/api/automations/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const parsed = parseAutomationBody(body, (id) => store.getProviderInstance(id) !== undefined);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (typeof parsed.patch.projectId === "number" && !store.getProject(parsed.patch.projectId)) {
      return c.json({ error: "project not found" }, 404);
    }
    const patch: Parameters<Store["updateAutomation"]>[1] = { ...parsed.patch };
    if (isNonEmptyString(body.title)) patch.title = body.title;
    if (typeof body.prompt === "string" && body.prompt.trim() !== "") patch.prompt = body.prompt;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    return c.json(store.updateAutomation(Number(c.req.param("id")), patch));
  });
  app.delete("/api/automations/:id", (c) => {
    store.deleteAutomation(Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/automations/:id/run", (c) =>
    c.json(store.fireAutomation(Number(c.req.param("id")), "human"), 201),
  );

  // Team work: the user's own+org repos, and the open-PR feed across the
  // repos they picked. Repo failures degrade per-repo rather than blanking
  // the whole feed — one archived or permission-lost repo shouldn't hide
  // every other team's PRs.
  app.get("/api/team/repos", async (c) => {
    try {
      return c.json(await github.listAffiliatedRepos());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });
  app.get("/api/team/prs", async (c) => {
    const reposParam = c.req.query("repos") ?? "";
    const slugs = reposParam.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (slugs.length === 0) return c.json({ prs: [], errors: [] });
    for (const slug of slugs) {
      try {
        repoSlug(slug);
      } catch {
        return c.json({ error: `invalid repo slug "${slug}"` }, 400);
      }
    }
    const settled = await Promise.all(
      slugs.map(async (slug) => {
        try {
          return { slug, prs: await github.listPrs(slug) };
        } catch (error) {
          return { slug, failed: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const prs = settled
      .flatMap((result) => result.prs ?? [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const errors = settled.flatMap((result) =>
      "failed" in result ? [{ repo: result.slug, error: result.failed }] : [],
    );
    return c.json({ prs, errors });
  });

  // App-level provider config (ticket 38): one row per provider name, shared
  // by every Project. Adapters read it fresh per phase, so a save here lands
  // on the next claim without an app restart.
  // -- auth (ADR-0006): GitHub device flow. The renderer drives the polling
  // cadence; the token never crosses this boundary — status carries profile
  // fields only. TRACKER_NO_AUTH=1 tells the gate not to demand sign-in.
  app.get("/api/auth/status", (c) =>
    c.json({ ...auth.status(), required: process.env.TRACKER_NO_AUTH !== "1" }),
  );
  app.post("/api/auth/device/start", async (c) => c.json(await auth.startDeviceFlow()));
  app.post("/api/auth/device/poll", async (c) => {
    const body = await c.req.json<{ sessionId?: string }>();
    if (!isNonEmptyString(body.sessionId)) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    return c.json(await auth.pollOnce(body.sessionId));
  });
  app.post("/api/auth/device/cancel", async (c) => {
    const body = await c.req.json<{ sessionId?: string }>();
    if (isNonEmptyString(body.sessionId)) auth.cancel(body.sessionId);
    return c.json({ ok: true });
  });
  app.post("/api/auth/signout", (c) => {
    auth.signOut();
    return c.json({ ok: true });
  });

  // The provider list (migration 26): user-managed instances over the fixed
  // driver set. Config-field parsing is shared by add/patch below.
  const parseInstanceConfigBody = (
    body: Record<string, unknown>,
  ):
    | { patch: Partial<Omit<ProviderInstance, "id" | "driver">> }
    | { error: string } => {
    const patch: Partial<Omit<ProviderInstance, "id" | "driver">> = {};
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
      } else return { error: `${field} must be a string or null` };
    }
    if ("maxBudgetUsd" in body) {
      const value = body.maxBudgetUsd;
      if (value === null || value === "") patch.maxBudgetUsd = null;
      else if (typeof value === "number" && Number.isFinite(value)) patch.maxBudgetUsd = value;
      else return { error: "maxBudgetUsd must be a number or null" };
    }
    if ("env" in body) {
      const value = body.env;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { error: "env must be an object" };
      }
      if (Object.values(value).some((v) => typeof v !== "string")) {
        return { error: "env values must be strings" };
      }
      patch.env = value as Record<string, string>;
    }
    if ("displayName" in body) {
      if (!isNonEmptyString(body.displayName)) {
        return { error: "displayName must be a non-empty string" };
      }
      patch.displayName = body.displayName.trim();
    }
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return { error: "enabled must be a boolean" };
      patch.enabled = body.enabled;
    }
    return { patch };
  };

  // Each row carries its live PATH-shaped availability (availability.ts):
  // recomputed per request so an install or a binaryPath edit shows on the
  // next open, no restart or refresh dance.
  app.get("/api/provider-instances", (c) =>
    c.json(
      store.listProviderInstances().map((instance) => {
        const reason = availabilityReason(instance);
        return { ...instance, available: reason === null, availabilityReason: reason };
      }),
    ),
  );
  app.post("/api/provider-instances", async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    if (!isProvider(body.driver)) {
      return c.json({ error: `driver must be one of ${PROVIDERS.join(", ")}` }, 400);
    }
    if (!isNonEmptyString(body.displayName)) {
      return c.json({ error: "displayName is required" }, 400);
    }
    const parsed = parseInstanceConfigBody(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const created = store.addProviderInstance({
      driver: body.driver,
      displayName: body.displayName,
    });
    // Config fields on create are a convenience over add-then-patch.
    const { displayName: _renamed, ...config } = parsed.patch;
    return c.json(
      Object.keys(config).length === 0
        ? created
        : store.setProviderInstance(created.id, config),
      201,
    );
  });
  app.patch("/api/provider-instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.getProviderInstance(id)) {
      return c.json({ error: `unknown provider instance ${id}` }, 404);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    const parsed = parseInstanceConfigBody(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(store.setProviderInstance(id, parsed.patch));
  });
  app.delete("/api/provider-instances/:id", (c) => {
    const id = c.req.param("id");
    if (!store.getProviderInstance(id)) {
      return c.json({ error: `unknown provider instance ${id}` }, 404);
    }
    store.deleteProviderInstance(id);
    return c.json({ ok: true });
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

  // The right panel's Diff surface: the checkout's uncommitted changes.
  app.get("/api/projects/:id/diff", async (c) => {
    const project = store.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    const repo = store.listRepos(project.id)[0];
    if (!repo) throw new StateError(`project ${project.name} has no registered repo`);
    return c.json(await repoWorkingDiff(repo.path));
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
    if (!store.getProject(body.projectId)) return c.json({ error: "project not found" }, 404);
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
      kind?: string;
      acceptanceCriteria?: string[];
    }>();
    if (typeof body.projectId !== "number") return c.json({ error: "projectId is required" }, 400);
    if (!store.getProject(body.projectId)) return c.json({ error: "project not found" }, 404);
    if (!isNonEmptyString(body.title)) {
      return c.json({ error: "title is required" }, 400);
    }
    if (body.kind !== undefined && !isTicketKind(body.kind)) {
      return c.json({ error: `kind must be one of ${TICKET_KINDS.join(", ")}` }, 400);
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
      kind: body.kind,
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
    const instance =
      typeof body.provider === "string" ? store.getProviderInstance(body.provider) : undefined;
    if (!instance) {
      return c.json({ error: "provider must be a configured provider instance id" }, 400);
    }
    if (!instance.enabled) {
      return c.json({ error: `provider ${instance.id} is disabled` }, 400);
    }
    const ticket = store.promoteTicket(Number(c.req.param("id")), {
      repoId: body.repoId,
      provider: instance.id,
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

  // Send a parked ticket back to Todo for another attempt (setup failure or
  // crash cap). Distinct from a verdict: there is no reviewed work to judge.
  app.post("/api/tickets/:id/retry", (c) =>
    c.json(store.retryTicket(Number(c.req.param("id")))),
  );

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
