import { describe, expect, test } from "vitest";
import type { DraftEdge, DraftGraph, DraftNode, DraftViolation } from "../src/server/types.ts";
import {
  addBranch,
  addEdge,
  addPhase,
  addStep,
  autoLayout,
  deleteEdge,
  deleteNode,
  deleteStep,
  insertPhase,
  NODE_H,
  nodeHeight,
  relabelEdge,
  updateNode,
  updateStep,
  violationsByEdge,
  violationsByNode,
} from "../src/renderer/canvasModel.ts";

function node(key: string, overrides: Partial<DraftNode> = {}): DraftNode {
  return {
    key,
    type: "agent_phase",
    name: key,
    promptTemplate: `work on ${key}`,
    emitsChecks: false,
    bootsPreview: false,
    gateRequirements: [],
    steps: [],
    ...overrides,
  };
}

function trigger(): DraftNode {
  return node("t", { type: "trigger", name: "ticket-claimed", promptTemplate: null });
}

function edge(from: string, to: string, conditionLabel: string | null = null): DraftEdge {
  return { from, to, conditionLabel };
}

/** trigger → a → b, with a branch a →(x) c. */
function graph(): DraftGraph {
  return {
    nodes: [trigger(), node("a"), node("b"), node("c")],
    edges: [edge("t", "a"), edge("a", "b", "code"), edge("a", "c", "docs")],
  };
}

describe("addPhase", () => {
  test("adds a phase with a fresh key and a unique name", () => {
    const { graph: next, key } = addPhase(graph());
    expect(next.nodes.map((n) => n.key)).toContain(key);
    expect(graph().nodes.map((n) => n.key)).not.toContain(key);
    const added = next.nodes.find((n) => n.key === key)!;
    expect(added.type).toBe("agent_phase");
    expect(next.nodes.filter((n) => n.name === added.name)).toHaveLength(1);
  });

  test("consecutive adds never collide on key or name", () => {
    const first = addPhase(graph());
    const second = addPhase(first.graph);
    expect(second.key).not.toBe(first.key);
    const names = second.graph.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("insertPhase", () => {
  test("slots into the sequence: takes over outgoing edges, labels ride along", () => {
    // a branches to b ("code") and c ("docs"); inserting after a moves the
    // whole branch point onto the new node.
    const { graph: next, key } = insertPhase(graph(), "a");
    expect(next.edges).toContainEqual(edge("a", key));
    expect(next.edges).toContainEqual(edge(key, "b", "code"));
    expect(next.edges).toContainEqual(edge(key, "c", "docs"));
    expect(next.edges.filter((e) => e.from === "a")).toHaveLength(1);
  });

  test("after a terminal node it is a plain append", () => {
    const { graph: next, key } = insertPhase(graph(), "b");
    expect(next.edges).toContainEqual(edge("b", key));
    expect(next.edges.filter((e) => e.from === key)).toHaveLength(0);
  });

  test("unknown key is a refusal (same reference)", () => {
    const g = graph();
    expect(insertPhase(g, "nope").graph).toBe(g);
  });
});

describe("addBranch", () => {
  test("alongside existing children it adds one unlabeled stub", () => {
    const { graph: next, keys } = addBranch(graph(), "a");
    expect(keys).toHaveLength(1);
    expect(next.edges).toContainEqual(edge("a", keys[0]!));
    // The existing labeled branches are untouched.
    expect(next.edges).toContainEqual(edge("a", "b", "code"));
    expect(next.edges).toContainEqual(edge("a", "c", "docs"));
  });

  test("on a terminal node it stubs both choices — a branch needs two", () => {
    const { graph: next, keys } = addBranch(graph(), "b");
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(next.edges).toContainEqual(edge("b", key));
  });

  test("unknown key is a refusal (same reference)", () => {
    const g = graph();
    expect(addBranch(g, "nope").graph).toBe(g);
  });
});

describe("deleteNode", () => {
  test("removes the node and every edge touching it", () => {
    const next = deleteNode(graph(), "a");
    expect(next.nodes.map((n) => n.key)).toEqual(["t", "b", "c"]);
    expect(next.edges).toEqual([]);
  });

  test("the trigger is undeletable — the graph comes back unchanged", () => {
    const before = graph();
    expect(deleteNode(before, "t")).toBe(before);
  });
});

describe("addEdge", () => {
  test("connects two nodes", () => {
    const next = addEdge(graph(), "b", "c");
    expect(next.edges).toContainEqual(edge("b", "c"));
  });

  test("refuses an incoming edge on the trigger", () => {
    const before = graph();
    expect(addEdge(before, "b", "t")).toBe(before);
  });

  test("refuses self-edges and exact duplicates", () => {
    const before = graph();
    expect(addEdge(before, "b", "b")).toBe(before);
    expect(addEdge(before, "t", "a")).toBe(before);
  });
});

describe("edge editing", () => {
  test("deleteEdge removes by index", () => {
    const next = deleteEdge(graph(), 1);
    expect(next.edges).toEqual([edge("t", "a"), edge("a", "c", "docs")]);
  });

  test("relabelEdge sets a label; blank clears to null", () => {
    const relabeled = relabelEdge(graph(), 1, "code-change");
    expect(relabeled.edges[1]).toEqual(edge("a", "b", "code-change"));
    const cleared = relabelEdge(graph(), 1, "  ");
    expect(cleared.edges[1]).toEqual(edge("a", "b"));
  });

  test("relabelEdge with an unchanged label is a no-op (same reference)", () => {
    const g = graph();
    expect(relabelEdge(g, 1, "code")).toBe(g);
    expect(relabelEdge(g, 1, "  code  ")).toBe(g); // trims before comparing
    expect(relabelEdge(g, 0, "")).toBe(g); // unlabeled stays unlabeled
    expect(relabelEdge(g, 1, "docs")).not.toBe(g);
  });
});

describe("updateNode", () => {
  test("patches phase fields", () => {
    const next = updateNode(graph(), "a", {
      name: "research",
      promptTemplate: "dig in",
      emitsChecks: true,
      gateRequirements: ["kb/recap.html"],
    });
    expect(next.nodes.find((n) => n.key === "a")).toMatchObject({
      name: "research",
      promptTemplate: "dig in",
      emitsChecks: true,
      gateRequirements: ["kb/recap.html"],
    });
  });

  test("the trigger is unconfigurable — the graph comes back unchanged", () => {
    const before = graph();
    expect(updateNode(before, "t", { name: "renamed" })).toBe(before);
  });
});

describe("steps", () => {
  test("addStep appends a typed step with a default title", () => {
    const next = addStep(graph(), "a", "search-code");
    const steps = next.nodes.find((n) => n.key === "a")!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "search-code", prompt: "" });
    expect(steps[0]!.title).not.toBe("");
  });

  test("updateStep patches title and prompt in place", () => {
    const withStep = addStep(graph(), "a", "author");
    const next = updateStep(withStep, "a", 0, { title: "Write the doc", prompt: "kb/x.md" });
    expect(next.nodes.find((n) => n.key === "a")!.steps[0]).toMatchObject({
      type: "author",
      title: "Write the doc",
      prompt: "kb/x.md",
    });
  });

  test("deleteStep removes by index", () => {
    const two = addStep(addStep(graph(), "a", "action"), "a", "author");
    const next = deleteStep(two, "a", 0);
    const steps = next.nodes.find((n) => n.key === "a")!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.type).toBe("author");
  });
});

describe("autoLayout", () => {
  test("positions every node, deeper nodes lower, fan-out side by side", () => {
    const pos = autoLayout(graph());
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "c", "t"]);
    expect(pos.a!.y).toBeGreaterThan(pos.t!.y);
    expect(pos.b!.y).toBeGreaterThan(pos.a!.y);
    expect(pos.b!.y).toBe(pos.c!.y);
    expect(pos.b!.x).not.toBe(pos.c!.x);
  });

  test("fan-in lands below the longest path and orphans still get a spot", () => {
    const g: DraftGraph = {
      nodes: [trigger(), node("a"), node("b"), node("merge"), node("lost")],
      edges: [
        edge("t", "a"),
        edge("t", "b"),
        edge("a", "merge"),
        edge("b", "merge"),
      ],
    };
    // merge is one past its deepest parent even with a shorter path into it.
    const pos = autoLayout(g);
    expect(pos.merge!.y).toBeGreaterThan(pos.a!.y);
    expect(pos.merge!.y).toBeGreaterThan(pos.b!.y);
    expect(pos.lost).toBeDefined();
  });

  test("a row with steps pushes the next row further down", () => {
    const short = autoLayout(graph());
    const tall = autoLayout({
      ...graph(),
      nodes: graph().nodes.map((n) =>
        n.key === "a"
          ? {
              ...n,
              steps: [
                { type: "search-code" as const, title: "find it", prompt: "" },
                { type: "action" as const, title: "do it", prompt: "" },
              ],
            }
          : n,
      ),
    });
    // a's card grew, so the b/c row starts lower than in the stepless layout;
    // rows above the grown card stay put.
    expect(tall.b!.y).toBeGreaterThan(short.b!.y);
    expect(tall.a!.y).toBe(short.a!.y);
    expect(nodeHeight(node("a"))).toBe(NODE_H);
  });

  test("survives a mid-edit cycle without hanging", () => {
    const g: DraftGraph = {
      nodes: [trigger(), node("a"), node("b")],
      edges: [edge("t", "a"), edge("a", "b"), edge("b", "a")],
    };
    const pos = autoLayout(g);
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "t"]);
  });
});

describe("violation anchoring", () => {
  const violations: DraftViolation[] = [
    { rule: "empty-prompt", message: "no prompt", nodeKey: "a" },
    { rule: "orphan", message: "unreachable", nodeKey: "a" },
    { rule: "cycle", message: "closes a cycle", edgeIndex: 2 },
    { rule: "trigger", message: "no trigger node" },
  ];

  test("groups messages by node key and edge index; unanchored stay global", () => {
    const byNode = violationsByNode(violations);
    expect(byNode.get("a")).toEqual(["no prompt", "unreachable"]);
    const byEdge = violationsByEdge(violations);
    expect(byEdge.get(2)).toEqual(["closes a cycle"]);
  });
});
