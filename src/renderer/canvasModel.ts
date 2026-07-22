import type {
  DraftGraph,
  DraftNode,
  DraftStep,
  DraftViolation,
  WorkflowStepType,
} from "../server/types.ts";

/**
 * The canvas editor's pure model (ticket 48): every mutation the editor can
 * perform on a Draft graph, plus the auto-layout. Guarded operations return
 * the input graph unchanged (same reference) so the view can treat "refused"
 * as a no-op render — the trigger's invariants (undeletable, unconfigurable,
 * no incoming edge) live here, not in event handlers.
 */

export const STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  "search-global": "Search global knowledge",
  "search-project": "Search project knowledge",
  "search-code": "Search the codebase",
  "search-web": "Web search",
  action: "Perform an action",
  author: "Author a document",
};

const findNode = (graph: DraftGraph, key: string) => graph.nodes.find((n) => n.key === key);

/**
 * Add an agent phase; key and name are made collision-free. A kind seeds the
 * stage with one step of that type and names it after the kind — the create
 * menu's classification. Kind is authoring convenience only: every stage is
 * an agent_phase to the engine.
 */
export function addPhase(
  graph: DraftGraph,
  kind?: WorkflowStepType,
): { graph: DraftGraph; key: string } {
  const keys = new Set(graph.nodes.map((n) => n.key));
  const names = new Set(graph.nodes.map((n) => n.name));
  let i = 1;
  while (keys.has(`p${i}`)) i += 1;
  const key = `p${i}`;
  const base =
    kind === undefined
      ? "new-phase"
      : STEP_TYPE_LABELS[kind].toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let j = 1;
  while (names.has(j === 1 ? base : `${base}-${j}`)) j += 1;
  const added: DraftNode = {
    key,
    type: "agent_phase",
    name: j === 1 ? base : `${base}-${j}`,
    promptTemplate: null,
    emitsChecks: false,
    bootsPreview: false,
    gateRequirements: [],
    steps: kind === undefined ? [] : [{ type: kind, title: STEP_TYPE_LABELS[kind], prompt: "" }],
  };
  return { graph: { ...graph, nodes: [...graph.nodes, added] }, key };
}

/** Remove a node and every edge touching it. The trigger is undeletable. */
export function deleteNode(graph: DraftGraph, key: string): DraftGraph {
  const node = findNode(graph, key);
  if (!node || node.type === "trigger") return graph;
  return {
    nodes: graph.nodes.filter((n) => n.key !== key),
    edges: graph.edges.filter((e) => e.from !== key && e.to !== key),
  };
}

/** Connect two nodes. Refused: into the trigger, self-edges, exact duplicates. */
export function addEdge(
  graph: DraftGraph,
  from: string,
  to: string,
  conditionLabel: string | null = null,
): DraftGraph {
  if (from === to) return graph;
  const target = findNode(graph, to);
  if (!target || !findNode(graph, from) || target.type === "trigger") return graph;
  if (graph.edges.some((e) => e.from === from && e.to === to)) return graph;
  return { ...graph, edges: [...graph.edges, { from, to, conditionLabel }] };
}

export function deleteEdge(graph: DraftGraph, index: number): DraftGraph {
  return { ...graph, edges: graph.edges.filter((_, i) => i !== index) };
}

/** Set an edge's condition label; blank/whitespace clears it to unlabeled. */
export function relabelEdge(graph: DraftGraph, index: number, label: string): DraftGraph {
  const trimmed = label.trim();
  return {
    ...graph,
    edges: graph.edges.map((e, i) =>
      i === index ? { ...e, conditionLabel: trimmed === "" ? null : trimmed } : e,
    ),
  };
}

/** Patch a phase's editable fields. The trigger is unconfigurable. */
export function updateNode(
  graph: DraftGraph,
  key: string,
  patch: Partial<
    Pick<DraftNode, "name" | "promptTemplate" | "emitsChecks" | "bootsPreview" | "gateRequirements">
  >,
): DraftGraph {
  const node = findNode(graph, key);
  if (!node || node.type === "trigger") return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)),
  };
}

function patchSteps(
  graph: DraftGraph,
  key: string,
  change: (steps: DraftStep[]) => DraftStep[],
): DraftGraph {
  const node = findNode(graph, key);
  if (!node || node.type === "trigger") return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.key === key ? { ...n, steps: change(n.steps) } : n)),
  };
}

/** Append a typed step; the type's label doubles as the starting title. */
export function addStep(graph: DraftGraph, key: string, type: WorkflowStepType): DraftGraph {
  return patchSteps(graph, key, (steps) => [
    ...steps,
    { type, title: STEP_TYPE_LABELS[type], prompt: "" },
  ]);
}

export function updateStep(
  graph: DraftGraph,
  key: string,
  index: number,
  patch: Partial<Pick<DraftStep, "title" | "prompt">>,
): DraftGraph {
  return patchSteps(graph, key, (steps) =>
    steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  );
}

export function deleteStep(graph: DraftGraph, key: string, index: number): DraftGraph {
  return patchSteps(graph, key, (steps) => steps.filter((_, i) => i !== index));
}

export const NODE_W = 190;
export const NODE_H = 56;
/** One step row on the card; keep in sync with .wfc-node-steprow height. */
export const STEP_ROW_H = 26;
const STEPS_PAD = 10;
const COL_GAP = 40;
const ROW_GAP = 44;
const ORIGIN = { x: 340, y: 40 };

/**
 * A card's rendered height: the NODE_H header, plus a row per step (steps
 * are visible on the card, Lindy-style — not hidden behind a count pill).
 */
export function nodeHeight(node: DraftNode): number {
  if (node.steps.length === 0) return NODE_H;
  return NODE_H + node.steps.length * STEP_ROW_H + STEPS_PAD;
}

/**
 * Layered layout: each node's row is its longest path from the trigger, so
 * fan-in always lands below every parent; nodes sharing a row spread into
 * columns. Row spacing follows the tallest card in each row — cards grow
 * with their step lists. Mid-edit graphs may hold cycles and orphans — back
 * edges are ignored for depth, orphans get the bottom row.
 */
export function autoLayout(graph: DraftGraph): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const onStack = new Set<string>();
  const edgesFrom = (key: string) => graph.edges.filter((e) => e.from === key);
  const visit = (key: string, d: number) => {
    if (onStack.has(key)) return; // back edge — a mid-edit cycle
    if ((depth.get(key) ?? -1) >= d) return;
    depth.set(key, d);
    onStack.add(key);
    for (const e of edgesFrom(key)) if (findNode(graph, e.to)) visit(e.to, d + 1);
    onStack.delete(key);
  };
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) visit(trigger.key, 0);

  const maxDepth = Math.max(0, ...depth.values());
  for (const node of graph.nodes) {
    if (!depth.has(node.key)) depth.set(node.key, maxDepth + 1);
  }

  const rows = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.key)!;
    rows.set(d, [...(rows.get(d) ?? []), node.key]);
  }
  // Cumulative row tops: each row clears the tallest card of the row above.
  const rowTop = new Map<number, number>();
  const depths = [...rows.keys()].sort((a, b) => a - b);
  let y = ORIGIN.y;
  for (const d of depths) {
    rowTop.set(d, y);
    const tallest = Math.max(
      ...rows.get(d)!.map((key) => nodeHeight(findNode(graph, key)!)),
    );
    y += tallest + ROW_GAP;
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [d, keys] of rows) {
    const rowWidth = keys.length * NODE_W + (keys.length - 1) * COL_GAP;
    keys.forEach((key, i) => {
      positions[key] = {
        x: ORIGIN.x + NODE_W / 2 - rowWidth / 2 + i * (NODE_W + COL_GAP),
        y: rowTop.get(d)!,
      };
    });
  }
  return positions;
}

/** Violation messages grouped onto their offending node, for in-place render. */
export function violationsByNode(violations: DraftViolation[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const v of violations) {
    if (v.nodeKey === undefined) continue;
    grouped.set(v.nodeKey, [...(grouped.get(v.nodeKey) ?? []), v.message]);
  }
  return grouped;
}

export function violationsByEdge(violations: DraftViolation[]): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const v of violations) {
    if (v.edgeIndex === undefined) continue;
    grouped.set(v.edgeIndex, [...(grouped.get(v.edgeIndex) ?? []), v.message]);
  }
  return grouped;
}
