import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types.ts";

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
  return edge === undefined ? undefined : nodeOfEdge(workflow, edge);
}

/**
 * The labels on a node's outgoing edges — the branch choices a phase picks
 * from (ADR-0001). A non-empty result marks a branch node: its phase must
 * declare one of these labels as its outcome, and the engine routes by it.
 */
export function branchLabels(workflow: WorkflowGraph, from: WorkflowNode): string[] {
  return workflow.edges
    .filter((edge) => edge.fromNodeId === from.id && edge.conditionLabel !== null)
    .map((edge) => edge.conditionLabel as string);
}

/** Follow the outgoing edge whose label matches the phase's declared outcome. */
export function nextNodeByLabel(
  workflow: WorkflowGraph,
  from: WorkflowNode,
  label: string,
): WorkflowNode | undefined {
  const edge = workflow.edges.find(
    (candidate) => candidate.fromNodeId === from.id && candidate.conditionLabel === label,
  );
  return edge === undefined ? undefined : nodeOfEdge(workflow, edge);
}

function nodeOfEdge(workflow: WorkflowGraph, edge: WorkflowEdge): WorkflowNode {
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
