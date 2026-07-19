import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BOUNCE_REPORT_PATH } from "./bounce.ts";
import { readCheckManifest } from "./checks.ts";
import {
  dogfoodTemplateVars,
  resolvePersona,
  type PreviewHandoff,
} from "./dogfood.ts";
import { branchLabels, nextNode, nextNodeByLabel, triggerOf } from "./graph.ts";
import { DEFAULT_READINESS_TIMEOUT_MS, type PreviewManager } from "./previews.ts";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs, WorkflowNode } from "./types.ts";

/** Wrong work (hollow phase, provider-reported failure) — distinct from a crash. */
export class PhaseFailedError extends Error {}

/** The orchestrator cancelled the phase (app quit); nothing gets recorded. */
export class PhaseCancelledError extends Error {}

/** Everything a Run's phases execute against. */
export interface RunContext {
  run: Run;
  ticket: TicketWithAcs;
  repo: Repo;
  worktreePath: string;
  signal?: AbortSignal;
}

/**
 * The dumb interpreter (ADR-0001): start at the trigger, walk the single
 * unlabeled outgoing edge, run each agent phase in a fresh provider session.
 * A phase completes only when the provider signals success AND the Phase
 * Contract file `kb/<phase>.md` exists in the worktree.
 */
export class WorkflowEngine {
  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly logs: RunLogRegistry,
    private readonly previews: PreviewManager,
  ) {}

  /** Resolves on success; throws PhaseFailedError (failed) or anything else (crashed). */
  async execute(ctx: RunContext): Promise<void> {
    const provider = this.providers[ctx.ticket.provider!];
    if (!provider) throw new Error(`no adapter registered for provider ${ctx.ticket.provider}`);

    // The Run's pinned version (ADR-0004): the graph can never change under it.
    const workflow = this.store.getWorkflowGraph(ctx.run.workflowVersionId);
    // Context travels between phases as files: each completed phase's
    // contract doc joins the {{priorKb}} handoff for the ones after it.
    const priorKb: string[] = [];
    // Walk from the trigger. A branch node (labeled outgoing edges) routes by
    // the phase's declared outcome; every other node follows its single
    // unlabeled edge, so a v1 linear graph runs exactly as before. Following
    // one edge per node means a fan-in target is reached — and runs — once.
    let node: WorkflowNode | undefined = nextNode(workflow, triggerOf(workflow));
    while (node !== undefined) {
      if (node.type !== "agent_phase") {
        node = nextNode(workflow, node);
        continue;
      }
      const labels = branchLabels(workflow, node);
      const outcome = await this.#runPhase(ctx, provider, node, priorKb, labels);
      priorKb.push(`kb/${node.name}.md`);
      node =
        outcome === null
          ? nextNode(workflow, node)
          : nextNodeByLabel(workflow, node, outcome);
    }
  }

  /**
   * Run one phase. Returns the edge label the phase routes on when its node
   * branches (`labels` non-empty), or null for a single-unlabeled-edge node.
   * Throws PhaseFailedError (wrong work) or a plain Error (crash).
   */
  async #runPhase(
    ctx: RunContext,
    provider: NonNullable<ProviderRegistry[keyof ProviderRegistry]>,
    node: WorkflowNode,
    priorKb: readonly string[],
    labels: readonly string[],
  ): Promise<string | null> {
    const execution = this.store.startPhase(ctx.run.id, node);
    // Re-entry context (spec 21, Phase Contract): follow-up criteria and the
    // Bounce Report the previous cycle left in the reused worktree. Statuses
    // ride along so a follow-up settled on an earlier cycle reads as such.
    const followUps = ctx.ticket.acceptanceCriteria
      .filter((criterion) => criterion.origin !== "original")
      .map((criterion) => `AC-${criterion.id} (${criterion.origin}, ${criterion.status}) ${criterion.text}`);
    // The dogfood phase (ticket 36) boots the ticket's Preview Environment
    // and joins the live URL + persona + vendored playbook to the variables.
    // A boot failure is never the phase's failure — the agent still runs and
    // writes an honest report (AC5); the teeth belong to slice 37's gate.
    const dogfood = node.bootsPreview ? await this.#bootDogfoodPreview(ctx) : undefined;
    try {
      // The engine's fixed template variable set — the only context injection.
      const prompt = renderTemplate(node.promptTemplate ?? "", {
        displayKey: ctx.ticket.displayKey,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        // AC-<id> gives check-emitting phases the ids their manifest keys on.
        acceptanceCriteria: ctx.ticket.acceptanceCriteria
          .map((criterion) => `- [${criterion.status}] AC-${criterion.id}: ${criterion.text}`)
          .join("\n"),
        branch: ctx.ticket.branch ?? "",
        targetBranch: ctx.repo.targetBranch,
        phase: node.name,
        priorKb: priorKb.length === 0 ? "none yet" : priorKb.join(", "),
        followUps: followUps.length === 0 ? "none" : followUps.join("; "),
        bounceReportPath: existsSync(path.join(ctx.worktreePath, BOUNCE_REPORT_PATH))
          ? BOUNCE_REPORT_PATH
          : "none",
        // Branch choices (ADR-0001): a branch node's phase must declare one of
        // these as its `outcome`; empty for a single-edge node ("none").
        outcomes: labels.length === 0 ? "none" : labels.join(", "),
        ...(dogfood?.vars ?? {}),
      });

      const log = this.logs.for(ctx.run.id);
      const handle = provider.runPhase(prompt, ctx.worktreePath, { signal: ctx.signal });
      for await (const event of handle.events) {
        log.append(RunLogRegistry.decorate(event, node.name));
      }
      const result = await handle.done;

      // Cancellation is the orchestrator's own doing (app quit): the phase
      // execution stays "running" and the startup sweep of a later slice
      // reaps the orphan — recording a crash here would blame the work.
      if (result.outcome === "cancelled") {
        throw new PhaseCancelledError(`phase ${node.name} cancelled`);
      }
      const providerSessionId = result.providerSessionId;
      if (result.outcome === "crashed") {
        const reason = result.failureReason ?? "provider crashed";
        this.store.endPhase(execution.id, "crashed", { failureReason: reason, providerSessionId });
        throw new Error(reason);
      }
      const contract = path.join(ctx.worktreePath, "kb", `${node.name}.md`);
      let failure =
        result.outcome !== "completed"
          ? (result.failureReason ?? `provider reported ${result.outcome}`)
          : existsSync(contract)
            ? undefined
            : `contract file kb/${node.name}.md missing — phase is hollow`;
      // Extended Phase Contract (ticket 07 §4): a check-emitting node must also
      // cover every pending AC in checks/manifest.json. Statuses are re-read —
      // a human may have waived an AC since claim.
      if (failure === undefined && node.emitsChecks) {
        const acs = this.store.getTicket(ctx.ticket.id)!.acceptanceCriteria;
        const manifest = readCheckManifest(ctx.worktreePath, acs);
        if (manifest.ok) {
          this.store.registerAcChecks(ctx.run.id, manifest.entries);
        } else {
          failure = manifest.failure;
        }
      }
      // Branch routing (ADR-0001): a node with labeled edges must have its
      // phase declare `outcome: <label>` in the contract. The engine only
      // string-matches — routing is the phase's judgment, never a gate — but a
      // missing or unrecognized outcome is wrong work, failed with the same
      // teeth as a hollow contract. A single-edge node ignores any stray one.
      let route: string | null = null;
      if (failure === undefined && labels.length > 0) {
        const declared = readContractOutcome(contract);
        if (declared === undefined) {
          failure = `phase ${node.name} declared no outcome — kb/${node.name}.md must set \`outcome:\` to one of: ${labels.join(", ")}`;
        } else if (!labels.includes(declared)) {
          failure = `phase ${node.name} declared outcome "${declared}" — expected one of: ${labels.join(", ")}`;
        } else {
          route = declared;
        }
      }
      if (failure !== undefined) {
        this.store.endPhase(execution.id, "failed", { failureReason: failure, providerSessionId });
        throw new PhaseFailedError(failure);
      }
      this.store.endPhase(execution.id, "completed", {
        providerSessionId,
        outcome: route ?? undefined,
      });
      return route;
    } finally {
      // The dogfood phase owns its preview for the phase's lifetime only: stop
      // it however the phase ends so the later demo step (and the wizard) boot
      // their own fresh process against the code under review.
      if (dogfood?.booted) await this.previews.stop(ctx.ticket.id, { actor: "agent" });
    }
  }

  /**
   * Boot the ticket's Preview Environment for the dogfood phase and build its
   * slice of the template variables. No preview configured is not a failure —
   * the phase still runs, told honestly that no running app is available.
   */
  async #bootDogfoodPreview(
    ctx: RunContext,
  ): Promise<{ vars: Record<string, string>; booted: boolean }> {
    const persona = resolvePersona(ctx.repo, ctx.worktreePath);
    if (ctx.repo.previewCommand === null) {
      const handoff: PreviewHandoff = {
        available: false,
        note: "no preview configured for this repo",
      };
      return { vars: dogfoodTemplateVars(handoff, persona), booted: false };
    }
    const boot = await this.previews.bootReady(ctx.ticket.id, {
      timeoutMs: ctx.repo.previewReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      signal: ctx.signal,
      actor: "agent",
    });
    const handoff: PreviewHandoff = boot.ready
      ? { available: true, baseUrl: `http://localhost:${boot.port}` }
      : { available: false, note: boot.reason };
    return { vars: dogfoodTemplateVars(handoff, persona), booted: boot.ready };
  }
}

/** The engine's fixed template variable set (Phase Contract). */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

/**
 * The `outcome` a branching phase declared in its contract's leading YAML
 * frontmatter (`---` fenced). Returns undefined when the file has no
 * frontmatter block, no closing fence (malformed), or no `outcome:` key — all
 * of which the engine treats alike as an undeclared outcome.
 */
function readContractOutcome(contractPath: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(contractPath, "utf8"));
  if (!match) return undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^outcome:\s*(.+?)\s*$/.exec(line);
    if (kv) return kv[1]!.replace(/^["']|["']$/g, "").trim() || undefined;
  }
  return undefined;
}
