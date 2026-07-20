import { afterEach, describe, expect, test } from "vitest";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { parseChatResponse } from "../src/server/workflow-chat.ts";
import type { DraftGraph } from "../src/server/types.ts";
import { api, bootServer, cleanups, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

/** A provider that answers every phase with the given final text. */
function chattyProvider(text: string): FakeProvider {
  return new FakeProvider(async function* () {
    yield { type: "block.open", blockId: "b1", block: { kind: "text", text } };
    yield { type: "block.close", blockId: "b1" };
    return { outcome: "completed" };
  });
}

/** The seeded RPIRD graph with one extra stage bolted on the end. */
function extendedGraph(graph: DraftGraph): DraftGraph {
  const last = graph.nodes.at(-1)!;
  return {
    nodes: [
      ...graph.nodes,
      {
        key: "phase-review",
        type: "agent_phase",
        name: "review",
        promptTemplate: "review the work",
        emitsChecks: false,
        bootsPreview: false,
        gateRequirements: [],
        steps: [
          { type: "search-code", title: "read the diff", prompt: "read the branch diff" },
          { type: "author", title: "write findings", prompt: "write kb/review.md" },
        ],
      },
    ],
    edges: [...graph.edges, { from: last.key, to: "phase-review", conditionLabel: null }],
  };
}

describe("workflow draft chat", () => {
  test("a model answer updates the draft and returns the reply", async () => {
    // The fake echoes a valid replacement graph: the seeded default's graph
    // with a review stage appended. Fetch it first to build the canned answer.
    const probe = await bootServer();
    const head = (await api(probe, "GET", "/api/workflows/1/head")).json;
    await runCleanups();

    const updated = extendedGraph(head.graph as DraftGraph);
    const answer = `Some preamble the model insisted on.\n\`\`\`json\n${JSON.stringify({
      reply: "Added a review stage after the last one.",
      graph: updated,
    })}\n\`\`\``;
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(answer) },
    });

    const response = await api(server, "POST", "/api/workflows/1/draft/chat", {
      message: "add a review stage at the end",
    });
    expect(response.status).toBe(200);
    expect(response.json.reply).toBe("Added a review stage after the last one.");
    expect(response.json.draft.graph.nodes.map((n: { key: string }) => n.key)).toContain(
      "phase-review",
    );

    // The draft persisted — the editor's next GET sees the model's graph.
    const draft = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(draft.graph.nodes).toHaveLength(updated.nodes.length);
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: { id: number }) => w.id === 1).hasDraft).toBe(true);
  });

  test("a failed chat on a draftless workflow leaves no draft behind", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider("I refuse to answer in JSON.") },
    });
    const response = await api(server, "POST", "/api/workflows/1/draft/chat", {
      message: "do something",
    });
    expect(response.status).toBe(502);
    const listed = (await api(server, "GET", "/api/workflows")).json;
    expect(listed.find((w: { id: number }) => w.id === 1).hasDraft).toBe(false);
  });

  test("unparseable model output is a 502 and the draft is untouched", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider("I refuse to answer in JSON.") },
    });
    const before = (await api(server, "GET", "/api/workflows/1/draft")).json;
    const response = await api(server, "POST", "/api/workflows/1/draft/chat", {
      message: "do something",
    });
    expect(response.status).toBe(502);
    const after = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(after.graph).toEqual(before.graph);
  });

  test("a graph that fails the shape check is a 502, not a saved draft", async () => {
    const answer = `\`\`\`json\n${JSON.stringify({
      reply: "Done!",
      graph: { nodes: "not a list", edges: [] },
    })}\n\`\`\``;
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(answer) },
    });
    const response = await api(server, "POST", "/api/workflows/1/draft/chat", {
      message: "break it",
    });
    expect(response.status).toBe(502);
    expect(response.json.error).toMatch(/invalid graph/);
  });

  test("a graph the publish validator rejects is refused with its reason, draft untouched", async () => {
    // Bolt a second trigger onto the seeded graph — shape-valid, semantically wrong.
    const probe = await bootServer();
    const head = (await api(probe, "GET", "/api/workflows/1/head")).json;
    await runCleanups();

    const graph = head.graph as DraftGraph;
    const doubled: DraftGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...graph.nodes.find((n) => n.type === "trigger")!, key: "trigger-2" },
      ],
    };
    const answer = `\`\`\`json\n${JSON.stringify({ reply: "Added a trigger.", graph: doubled })}\n\`\`\``;
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(answer) },
    });
    const before = (await api(server, "GET", "/api/workflows/1/draft")).json;
    const response = await api(server, "POST", "/api/workflows/1/draft/chat", {
      message: "add another trigger",
    });
    expect(response.status).toBe(422);
    expect(response.json.error).toMatch(/second trigger/);
    const after = (await api(server, "GET", "/api/workflows/1/draft")).json;
    expect(after.graph).toEqual(before.graph);
  });

  test("no registered provider is a 503; a blank message a 400", async () => {
    const server = await bootServer();
    expect(
      (await api(server, "POST", "/api/workflows/1/draft/chat", { message: "hi" })).status,
    ).toBe(503);
    expect(
      (await api(server, "POST", "/api/workflows/1/draft/chat", { message: "  " })).status,
    ).toBe(400);
  });
});

describe("parseChatResponse", () => {
  test("takes the last fenced block and requires reply + graph", () => {
    const good = parseChatResponse(
      'thinking...\n```json\n{"wrong": 1}\n```\ntake two:\n```json\n{"reply": "ok", "graph": {"nodes": [], "edges": []}}\n```',
    );
    expect(good).toMatchObject({ ok: true, reply: "ok" });
    expect(parseChatResponse("no json here").ok).toBe(false);
    expect(parseChatResponse('```json\n{"reply": "but no graph"}\n```').ok).toBe(false);
  });
});
