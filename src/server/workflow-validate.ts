import type { DraftGraph, DraftNode, DraftViolation } from "./types.ts";

/** The one fixed trigger (ticket 48: undeletable, unconfigurable). */
export const FIXED_TRIGGER_NAME = "ticket-claimed";

/**
 * The publish validator (ticket 47): every rule a graph must satisfy before
 * it may become an immutable version. Pure — no store, no db — so the rules
 * are testable one violation at a time. Always returns the full list, never
 * first-failure: the editor renders violations on the offending nodes and
 * edges, so a partial list would hide known problems.
 */
export function validateDraftGraph(graph: DraftGraph): DraftViolation[] {
  const violations: DraftViolation[] = [];
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));

  // Exactly one fixed "ticket claimed" trigger.
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (triggers.length === 0) {
    violations.push({ rule: "trigger", message: "the graph has no trigger node" });
  }
  for (const extra of triggers.slice(1)) {
    violations.push({
      rule: "trigger",
      message: `"${extra.name}" is a second trigger — a workflow has exactly one`,
      nodeKey: extra.key,
    });
  }
  // The trigger is fixed, not just unique: "ticket claimed" is the only
  // event that starts a workflow, so a renamed trigger is a broken one.
  for (const wrongName of triggers.filter((node) => node.name !== FIXED_TRIGGER_NAME)) {
    violations.push({
      rule: "trigger",
      message: `the trigger must be the fixed "${FIXED_TRIGGER_NAME}" node, not "${wrongName.name}"`,
      nodeKey: wrongName.key,
    });
  }

  // Unique node names.
  const seenNames = new Map<string, DraftNode>();
  for (const node of graph.nodes) {
    const holder = seenNames.get(node.name);
    if (holder) {
      violations.push({
        rule: "duplicate-name",
        message: `two nodes are named "${node.name}" — names must be unique`,
        nodeKey: node.key,
      });
    } else {
      seenNames.set(node.name, node);
    }
  }

  // Non-empty prompt templates on agent phases.
  for (const node of graph.nodes) {
    if (node.type !== "agent_phase") continue;
    if (node.promptTemplate === null || node.promptTemplate.trim() === "") {
      violations.push({
        rule: "empty-prompt",
        message: `agent phase "${node.name}" has no prompt template`,
        nodeKey: node.key,
      });
    }
  }

  // Per-node edges all-or-nothing: one unlabeled, or ≥2 uniquely-labeled.
  const outgoing = new Map<string, { labels: (string | null)[]; node: DraftNode }>();
  for (const node of graph.nodes) outgoing.set(node.key, { labels: [], node });
  for (const edge of graph.edges) outgoing.get(edge.from)?.labels.push(edge.conditionLabel);
  for (const { labels, node } of outgoing.values()) {
    if (labels.length === 0) continue; // terminal
    const unlabeled = labels.filter((label) => label === null).length;
    const labeled = labels.filter((label) => label !== null) as string[];
    if (unlabeled > 0 && labeled.length > 0) {
      violations.push({
        rule: "mixed-edges",
        message: `"${node.name}" mixes labeled and unlabeled outgoing edges — there is no default edge`,
        nodeKey: node.key,
      });
    } else if (unlabeled > 1) {
      violations.push({
        rule: "mixed-edges",
        message: `"${node.name}" has ${unlabeled} unlabeled outgoing edges — a non-branching node has exactly one`,
        nodeKey: node.key,
      });
    } else if (labeled.length === 1) {
      violations.push({
        rule: "mixed-edges",
        message: `"${node.name}" has a single labeled edge — a branch needs at least two choices`,
        nodeKey: node.key,
      });
    }
    const seenLabels = new Set<string>();
    for (const label of labeled) {
      if (seenLabels.has(label)) {
        violations.push({
          rule: "duplicate-label",
          message: `"${node.name}" has two outgoing edges labeled "${label}"`,
          nodeKey: node.key,
        });
      }
      seenLabels.add(label);
    }
  }

  const edgesFrom = (key: string) => graph.edges.filter((edge) => edge.from === key);
  const trigger = triggers[0];

  // Every node reachable from the trigger.
  const reachable = new Set<string>();
  if (trigger) {
    const stack = [trigger.key];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (reachable.has(key)) continue;
      reachable.add(key);
      for (const edge of edgesFrom(key)) if (byKey.has(edge.to)) stack.push(edge.to);
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.key)) {
        violations.push({
          rule: "orphan",
          message: `"${node.name}" is unreachable from the trigger`,
          nodeKey: node.key,
        });
      }
    }
  }

  // Acyclic (ADR-0005): DFS coloring, one violation per back edge.
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string) => {
    state.set(key, "visiting");
    for (const [index, edge] of graph.edges.entries()) {
      if (edge.from !== key || !byKey.has(edge.to)) continue;
      const targetState = state.get(edge.to);
      if (targetState === "visiting") {
        violations.push({
          rule: "cycle",
          message: `the edge from "${byKey.get(edge.from)!.name}" to "${byKey.get(edge.to)!.name}" closes a cycle — workflow graphs are acyclic`,
          edgeIndex: index,
        });
      } else if (targetState === undefined) {
        visit(edge.to);
      }
    }
    state.set(key, "done");
  };
  for (const node of graph.nodes) if (!state.has(node.key)) visit(node.key);

  // Every trigger-to-terminal path contains ≥1 check-emitting node: walk
  // only through non-emitting nodes; reaching a terminal that way is a
  // bypass path no gate battery would ever arm. The clean set makes this
  // terminate on cyclic graphs too — the full list is always returned.
  if (trigger) {
    const clean = new Set<string>();
    const stack = [trigger.key];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (clean.has(key)) continue;
      clean.add(key);
      const node = byKey.get(key);
      if (!node) continue;
      if (edgesFrom(key).length === 0) {
        violations.push({
          rule: "uncovered-path",
          message: `the path ending at "${node.name}" reaches a terminal without any check-emitting node`,
          nodeKey: node.key,
        });
        continue;
      }
      for (const edge of edgesFrom(key)) {
        const target = byKey.get(edge.to);
        if (target && !target.emitsChecks) stack.push(edge.to);
      }
    }
  }

  return violations;
}
