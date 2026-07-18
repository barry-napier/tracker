import { existsSync } from "node:fs";
import path from "node:path";
import { readCheckManifest } from "./checks.ts";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs, WorkflowGraph, WorkflowNode } from "./types.ts";

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
  ) {}

  /** Resolves on success; throws PhaseFailedError (failed) or anything else (crashed). */
  async execute(ctx: RunContext): Promise<void> {
    const provider = this.providers[ctx.ticket.provider!];
    if (!provider) throw new Error(`no adapter registered for provider ${ctx.ticket.provider}`);

    const workflow = this.store.getDefaultWorkflow();
    // Context travels between phases as files: each completed phase's
    // contract doc joins the {{priorKb}} handoff for the ones after it.
    const priorKb: string[] = [];
    let node: WorkflowNode | undefined = triggerOf(workflow);
    while ((node = nextNode(workflow, node)) !== undefined) {
      if (node.type !== "agent_phase") continue;
      await this.#runPhase(ctx, provider, node, priorKb);
      priorKb.push(`kb/${node.name}.md`);
    }
  }

  async #runPhase(
    ctx: RunContext,
    provider: NonNullable<ProviderRegistry[keyof ProviderRegistry]>,
    node: WorkflowNode,
    priorKb: readonly string[],
  ): Promise<void> {
    const execution = this.store.startPhase(ctx.run.id, node);
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
    if (failure !== undefined) {
      this.store.endPhase(execution.id, "failed", { failureReason: failure, providerSessionId });
      throw new PhaseFailedError(failure);
    }
    this.store.endPhase(execution.id, "completed", { providerSessionId });
  }
}

function triggerOf(workflow: WorkflowGraph): WorkflowNode {
  const trigger = workflow.nodes.find((node) => node.type === "trigger");
  if (!trigger) throw new Error(`workflow ${workflow.name} has no trigger node`);
  return trigger;
}

/** v1 walk: follow the node's single unlabeled outgoing edge, if any. */
function nextNode(workflow: WorkflowGraph, from: WorkflowNode): WorkflowNode | undefined {
  const edge = workflow.edges.find(
    (candidate) => candidate.fromNodeId === from.id && candidate.conditionLabel === null,
  );
  if (!edge) return undefined;
  const node = workflow.nodes.find((candidate) => candidate.id === edge.toNodeId);
  if (!node) throw new Error(`edge ${edge.id} points at missing node ${edge.toNodeId}`);
  return node;
}

/** The engine's fixed template variable set (Phase Contract). */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
}
