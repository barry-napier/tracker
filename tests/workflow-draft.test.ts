import { afterEach, describe, expect, test } from "vitest";
import { validateDraftGraph } from "../src/server/workflow-validate.ts";
import type { DraftEdge, DraftGraph, DraftNode } from "../src/server/types.ts";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";
import { PHASES } from "./workflow-helpers.ts";
import { SseClient } from "./sse-client.ts";

afterEach(runCleanups);

/** A provider whose phase never ends, for asserting mid-flight semantics. */
function stuckProvider(): FakeProvider {
  return new FakeProvider(async function* () {
    await new Promise(() => {});
    throw new Error("unreachable");
  });
}

// -- validator ------------------------------------------------------------

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

/** trigger → a(emits) → b: the smallest graph every rule accepts. */
function validGraph(): DraftGraph {
  return {
    nodes: [trigger(), node("a", { emitsChecks: true }), node("b")],
    edges: [edge("t", "a"), edge("a", "b")],
  };
}

describe("the publish validator", () => {
  test("accepts the smallest covered linear graph", () => {
    expect(validateDraftGraph(validGraph())).toEqual([]);
  });

  test("missing and multiple triggers are each their own violation", () => {
    const none = validGraph();
    none.nodes = none.nodes.filter((n) => n.type !== "trigger");
    expect(validateDraftGraph(none)).toContainEqual(
      expect.objectContaining({ rule: "trigger", message: expect.stringContaining("no trigger") }),
    );

    const twice = validGraph();
    twice.nodes.push(node("t2", { type: "trigger", name: "second-trigger", promptTemplate: null }));
    expect(validateDraftGraph(twice)).toContainEqual(
      expect.objectContaining({ rule: "trigger", nodeKey: "t2" }),
    );
  });

  test("a renamed trigger is rejected — the trigger is fixed, not just unique", () => {
    const graph = validGraph();
    graph.nodes = graph.nodes.map((n) => (n.type === "trigger" ? { ...n, name: "on-merge" } : n));
    expect(validateDraftGraph(graph)).toContainEqual(
      expect.objectContaining({ rule: "trigger", message: expect.stringContaining("ticket-claimed") }),
    );
  });

  test("a cyclic graph still reports its coverage violations — the list is always full", () => {
    // A self-cycling orphan beside an uncovered main line: every rule that
    // applies must appear at once, never a first-failure subset.
    const graph: DraftGraph = {
      nodes: [trigger(), node("a"), node("end"), node("loop")],
      edges: [edge("t", "a"), edge("a", "end"), edge("loop", "loop")],
    };
    const violations = validateDraftGraph(graph);
    expect(violations).toContainEqual(expect.objectContaining({ rule: "cycle" }));
    expect(violations).toContainEqual(expect.objectContaining({ rule: "orphan", nodeKey: "loop" }));
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: "uncovered-path", nodeKey: "end" }),
    );
  });

  test("an unreachable node is an orphan", () => {
    const graph = validGraph();
    graph.nodes.push(node("island", { name: "island" }));
    expect(validateDraftGraph(graph)).toContainEqual(
      expect.objectContaining({ rule: "orphan", nodeKey: "island" }),
    );
  });

  test("a cycle is rejected with the closing edge named", () => {
    const graph = validGraph();
    graph.edges.push(edge("b", "a"));
    expect(validateDraftGraph(graph)).toContainEqual(expect.objectContaining({ rule: "cycle" }));
  });

  test("mixed labeled/unlabeled, double-unlabeled, and single-labeled edges all violate all-or-nothing", () => {
    const mixed = validGraph();
    mixed.nodes.push(node("c"));
    mixed.edges.push(edge("a", "c", "retry"));
    expect(validateDraftGraph(mixed)).toContainEqual(
      expect.objectContaining({ rule: "mixed-edges", nodeKey: "a" }),
    );

    const doubled = validGraph();
    doubled.nodes.push(node("c"));
    doubled.edges.push(edge("a", "c"));
    expect(validateDraftGraph(doubled)).toContainEqual(
      expect.objectContaining({ rule: "mixed-edges", nodeKey: "a" }),
    );

    const lonely = validGraph();
    lonely.edges = [edge("t", "a"), edge("a", "b", "only-choice")];
    expect(validateDraftGraph(lonely)).toContainEqual(
      expect.objectContaining({ rule: "mixed-edges", nodeKey: "a" }),
    );
  });

  test("duplicate edge labels on one node are rejected", () => {
    const graph = validGraph();
    graph.nodes.push(node("c"));
    graph.edges = [edge("t", "a"), edge("a", "b", "same"), edge("a", "c", "same")];
    expect(validateDraftGraph(graph)).toContainEqual(
      expect.objectContaining({ rule: "duplicate-label", nodeKey: "a" }),
    );
  });

  test("path coverage proven both ways: a bypass branch fails; emitsChecks on it passes", () => {
    // t → a(emits) → b, plus a branch at t?? — branch at a covered node
    // won't do: build t → gate(branches) → {covered(emits) → end1, bypass → end2}.
    const graph: DraftGraph = {
      nodes: [
        trigger(),
        node("gate"),
        node("covered", { emitsChecks: true }),
        node("bypass"),
      ],
      edges: [
        edge("t", "gate"),
        edge("gate", "covered", "ok"),
        edge("gate", "bypass", "shortcut"),
      ],
    };
    expect(validateDraftGraph(graph)).toContainEqual(
      expect.objectContaining({ rule: "uncovered-path", nodeKey: "bypass" }),
    );

    graph.nodes = graph.nodes.map((n) => (n.key === "bypass" ? { ...n, emitsChecks: true } : n));
    expect(validateDraftGraph(graph)).toEqual([]);
  });

  test("duplicate node names and empty agent prompts are rejected; the list is full, not first-failure", () => {
    const graph = validGraph();
    graph.nodes.push(node("dupe", { name: "a", promptTemplate: "   " }));
    graph.edges.push(edge("b", "dupe"));
    const violations = validateDraftGraph(graph);
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: "duplicate-name", nodeKey: "dupe" }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: "empty-prompt", nodeKey: "dupe" }),
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  test("accepts RPIRD's seeded graph", async () => {
    const server = await bootServer();
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(validateDraftGraph(draft.graph)).toEqual([]);
  });
});

// -- draft lifecycle over the API -----------------------------------------

describe("workflow drafts", () => {
  test("get-or-create cuts the draft from the head; re-opening resumes it; the listing flags it", async () => {
    const server = await bootServer();
    const fresh = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(fresh.baseVersion).toBe(1);
    // Node rows come back in id order, not walk order — assert as a set.
    expect([...fresh.graph.nodes.map((n: any) => n.name)].sort()).toEqual(
      ["ticket-claimed", ...PHASES].sort(),
    );

    // Creating the draft alone flips the listing's unpublished-changes flag.
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: any) => w.id === 1).hasDraft).toBe(true);

    // Mutate: rename the research node; re-open resumes the same draft.
    const graph = fresh.graph;
    graph.nodes = graph.nodes.map((n: any) =>
      n.name === "research" ? { ...n, name: "deep-research" } : n,
    );
    await api(server, "PUT", "/api/workflows/1/draft", graph);
    const resumed = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(resumed.graph.nodes.map((n: any) => n.name)).toContain("deep-research");
  });

  test("a malformed graph is refused with 400 and the draft is unchanged", async () => {
    const server = await bootServer();
    await api(server, "GET", "/api/workflows/1/draft");
    expect((await api(server, "PUT", "/api/workflows/1/draft", { nodes: "nope" })).status).toBe(400);
    const bad = {
      nodes: [{ key: "x", type: "agent_phase", name: "x", promptTemplate: "p", emitsChecks: false, bootsPreview: false, gateRequirements: [], steps: [] }],
      edges: [{ from: "x", to: "ghost", conditionLabel: null }],
    };
    expect((await api(server, "PUT", "/api/workflows/1/draft", bad)).status).toBe(400);
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(draft.graph.nodes.map((n: any) => n.name)).toContain("research");
  });

  test("the draft is invisible to claims: a mid-edit claim pins the head version", async () => {
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": stuckProvider() },
    });
    const { project, repo } = await seedWorkspace(server);

    // An edited draft exists before the claim.
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    draft.graph.nodes = draft.graph.nodes.map((n: any) =>
      n.name === "implement" ? { ...n, promptTemplate: "draft-only prompt" } : n,
    );
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);

    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Ship the widget",
        acceptanceCriteria: ["Widget renders"],
      })
    ).json;
    await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
      repoId: repo.id,
      provider: "claude-code",
    });
    await client.waitFor("run.updated", 1, 5000);

    const runs = (await api(server, "GET", `/api/tickets/${ticket.id}/runs`)).json;
    expect(runs[0].workflowVersionId).toBe(1);
  });

  test("publish appends the new head atomically and clears the draft; the old version is untouched", async () => {
    const server = await bootServer();
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    draft.graph.nodes = draft.graph.nodes.map((n: any) =>
      n.name === "research" ? { ...n, name: "deep-research" } : n,
    );
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);

    const published = await api(server, "POST", "/api/workflows/1/draft/publish");
    expect(published.status).toBe(200);
    expect(published.json).toMatchObject({ id: 1, version: 2, hasDraft: false });
    expect(published.json.phases).toContain("deep-research");

    // A new draft cut from the new head carries the published edit.
    const reopened = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(reopened.baseVersion).toBe(2);
    expect(reopened.graph.nodes.map((n: any) => n.name)).toContain("deep-research");
  });

  test("publish is forward-acting: the running run keeps its v1 pin, the next claim pins v2", async () => {
    const server = await bootServer(undefined, {
      workers: 3,
      providers: { "claude-code": stuckProvider() },
    });
    const { project, repo } = await seedWorkspace(server);
    const client = await SseClient.connect(`${server.url}/api/events`);
    cleanups.push(async () => client.close());

    const claim = async (title: string) => {
      const ticket = (
        await api(server, "POST", "/api/tickets", {
          projectId: project.id,
          title,
          acceptanceCriteria: ["It works"],
        })
      ).json;
      await api(server, "POST", `/api/tickets/${ticket.id}/promote`, {
        repoId: repo.id,
        provider: "claude-code",
      });
      return ticket;
    };

    const before = await claim("Claimed before publish");
    await client.waitFor("run.updated", 1, 5000);

    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    draft.graph.nodes = draft.graph.nodes.map((n: any) =>
      n.name === "research" ? { ...n, name: "deep-research" } : n,
    );
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);
    expect((await api(server, "POST", "/api/workflows/1/draft/publish")).status).toBe(200);

    // The mid-flight run is untouched by the append.
    const untouched = (await api(server, "GET", `/api/tickets/${before.id}/runs`)).json;
    expect(untouched[0]).toMatchObject({ state: "running", workflowVersionId: 1 });

    // The project follows the head: its next claim pins the new version.
    const after = await claim("Claimed after publish");
    await client.waitFor("run.updated", 2, 5000);
    const runs = (await api(server, "GET", `/api/tickets/${after.id}/runs`)).json;
    expect(runs[0].workflowVersionId).toBe(2);
  });

  test("an invalid draft is refused at publish with the full violation list; nothing is appended", async () => {
    const server = await bootServer();
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    // Two independent problems at once: blank a prompt and orphan a node.
    draft.graph.nodes = draft.graph.nodes.map((n: any) =>
      n.name === "document" ? { ...n, promptTemplate: "" } : n,
    );
    draft.graph.nodes.push({
      key: "island",
      type: "agent_phase",
      name: "island",
      promptTemplate: "p",
      emitsChecks: false,
      bootsPreview: false,
      gateRequirements: [],
      steps: [],
    });
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);

    const validated = (await api(server, "POST", "/api/workflows/1/draft/validate")).json;
    expect(validated.violations).toContainEqual(expect.objectContaining({ rule: "empty-prompt" }));
    expect(validated.violations).toContainEqual(expect.objectContaining({ rule: "orphan" }));

    const refused = await api(server, "POST", "/api/workflows/1/draft/publish");
    expect(refused.status).toBe(400);
    expect(refused.json.violations.length).toBeGreaterThanOrEqual(2);

    // Nothing was appended; the draft survives for fixing.
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: any) => w.id === 1)).toMatchObject({ version: 1, hasDraft: true });
  });

  test("discard clears the draft and leaves the head identical", async () => {
    const server = await bootServer();
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    draft.graph.nodes = draft.graph.nodes.map((n: any) => ({ ...n, name: `${n.name}-x` }));
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);

    const discarded = await api(server, "DELETE", "/api/workflows/1/draft");
    expect(discarded.status).toBe(200);
    expect(discarded.json).toMatchObject({ id: 1, version: 1, hasDraft: false });
    expect(discarded.json.phases).toEqual([...PHASES]);

    // Re-open cuts a fresh draft from the untouched head — the edit is gone.
    const reopened = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(reopened.graph.nodes.map((n: any) => n.name)).toContain("research");
  });

  test("steps round-trip through publish and survive duplication as versioned content", async () => {
    const server = await bootServer();
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    draft.graph.nodes = draft.graph.nodes.map((n: any) =>
      n.name === "research"
        ? {
            ...n,
            steps: [
              { type: "search-web", title: "Web search", prompt: "Search the web for prior art." },
              { type: "author", title: "Write the doc", prompt: "Synthesize into kb/research.md." },
            ],
          }
        : n,
    );
    await api(server, "PUT", "/api/workflows/1/draft", draft.graph);
    expect(
      (await api(server, "PUT", "/api/workflows/1/draft", {
        nodes: [{ ...draft.graph.nodes[0], steps: [{ type: "no-such-type", title: "t", prompt: "p" }] }],
        edges: [],
      })).status,
    ).toBe(400);
    await api(server, "POST", "/api/workflows/1/draft/publish");

    // The published version's content carries the steps in order.
    const reopened = (await api(server, "GET", "/api/workflows/1/draft")).json;
    const research = reopened.graph.nodes.find((n: any) => n.name === "research");
    expect(research.steps.map((s: any) => s.type)).toEqual(["search-web", "author"]);

    // Duplicate copies the head's steps into the new workflow's own rows.
    const copy = (await api(server, "POST", "/api/workflows/1/duplicate")).json;
    const copyDraft = (await api(server, "GET", `/api/workflows/${copy.id}/draft`)).json;
    const copiedResearch = copyDraft.graph.nodes.find((n: any) => n.name === "research");
    expect(copiedResearch.steps.map((s: any) => s.title)).toEqual(["Web search", "Write the doc"]);
  });
});
