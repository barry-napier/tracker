import { existsSync } from "node:fs";
import path from "node:path";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs, WorkflowGraph, WorkflowNode } from "./types.ts";

/** Wrong work (hollow phase, provider-reported failure) — distinct from a crash. */
export class PhaseFailedError extends Error {}

/** The orchestrator cancelled the phase (app quit); nothing gets recorded. */
export class PhaseCancelledError extends Error {}

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
  async execute(ctx: {
    run: Run;
    ticket: TicketWithAcs;
    repo: Repo;
    worktreePath: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const provider = this.providers[ctx.ticket.provider!];
    if (!provider) throw new Error(`no adapter registered for provider ${ctx.ticket.provider}`);

    const workflow = this.store.getDefaultWorkflow();
    let node: WorkflowNode | undefined = triggerOf(workflow);
    while ((node = nextNode(workflow, node)) !== undefined) {
      if (node.type !== "agent_phase") continue;
      await this.#runPhase(ctx, provider, node);
    }
  }

  async #runPhase(
    ctx: {
      run: Run;
      ticket: TicketWithAcs;
      repo: Repo;
      worktreePath: string;
      signal?: AbortSignal;
    },
    provider: NonNullable<ProviderRegistry[keyof ProviderRegistry]>,
    node: WorkflowNode,
  ): Promise<void> {
    const execution = this.store.startPhase(ctx.run.id, node);
    const prompt = renderTemplate(node.promptTemplate ?? "", {
      displayKey: ctx.ticket.displayKey,
      title: ctx.ticket.title,
      description: ctx.ticket.description,
      acceptanceCriteria: ctx.ticket.acceptanceCriteria
        .map((criterion) => `- ${criterion.text}`)
        .join("\n"),
      branch: ctx.ticket.branch ?? "",
      targetBranch: ctx.repo.targetBranch,
      phase: node.name,
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
    if (result.outcome === "crashed") {
      this.store.endPhase(execution.id, "failed", result.failureReason ?? "provider crashed");
      throw new Error(result.failureReason ?? "provider crashed");
    }
    const contract = path.join(ctx.worktreePath, "kb", `${node.name}.md`);
    const failure =
      result.outcome !== "completed"
        ? (result.failureReason ?? `provider reported ${result.outcome}`)
        : existsSync(contract)
          ? undefined
          : `contract file kb/${node.name}.md missing — phase is hollow`;
    if (failure !== undefined) {
      this.store.endPhase(execution.id, "failed", failure);
      throw new PhaseFailedError(failure);
    }
    this.store.endPhase(execution.id, "completed");
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
