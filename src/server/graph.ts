import type { WorkflowGraph, WorkflowNode } from "./types.ts";

/**
 * The v1 graph walk (ADR-0001), shared by the engine's interpreter and the
 * library's phase-preview line: start at the trigger, follow each node's
 * single unlabeled outgoing edge.
 */
export function triggerOf(workflow: WorkflowGraph): WorkflowNode {
  const trigger = workflow.nodes.find((node) => node.type === "trigger");
  if (!trigger) throw new Error(`workflow ${workflow.name} has no trigger node`);
  return trigger;
}

export function nextNode(workflow: WorkflowGraph, from: WorkflowNode): WorkflowNode | undefined {
  const edge = workflow.edges.find(
    (candidate) => candidate.fromNodeId === from.id && candidate.conditionLabel === null,
  );
  if (!edge) return undefined;
  const node = workflow.nodes.find((candidate) => candidate.id === edge.toNodeId);
  if (!node) throw new Error(`edge ${edge.id} points at missing node ${edge.toNodeId}`);
  return node;
}

/** The agent phases in execution order — node ids say nothing about order. */
export function walkPhases(workflow: WorkflowGraph): WorkflowNode[] {
  const phases: WorkflowNode[] = [];
  let node: WorkflowNode | undefined = triggerOf(workflow);
  while ((node = nextNode(workflow, node)) !== undefined) {
    if (node.type === "agent_phase") phases.push(node);
  }
  return phases;
}
