import type { AgentEvent, Provider } from "./provider.ts";
import type { DraftGraph } from "./types.ts";

/**
 * The workflow-edit chat: one provider phase per message. The model gets the
 * draft graph as JSON plus the user's ask, and must answer with a fenced JSON
 * block carrying a short reply and the full replacement graph. No streaming
 * and no session memory — each turn re-sends the current graph, so the draft
 * itself is the conversation state that matters.
 */

export interface ChatOutcome {
  ok: true;
  reply: string;
  graph: DraftGraph;
}
export interface ChatFailure {
  ok: false;
  error: string;
}

/** The graph vocabulary, stated once for the model. Kept in sync by the
 *  shape check on save: drift here surfaces as a 502, never a bad draft. */
const SCHEMA_HELP = `A workflow graph is JSON: {"nodes": [...], "edges": [...]}.
Node: {"key": string (stable identity — NEVER change existing keys), "type": "trigger" | "agent_phase",
  "name": string, "promptTemplate": string | null, "emitsChecks": boolean,
  "bootsPreview": boolean, "gateRequirements": string[] (artifact paths this stage owes),
  "steps": [{"type": one of "search-global" | "search-project" | "search-code" | "search-web" | "action" | "author",
             "title": string, "prompt": string}]}.
Edge: {"from": node key, "to": node key, "conditionLabel": string | null (branch label)}.
Rules: exactly one trigger node ("ticket-claimed") and it is fixed — never rename, remove,
or point an edge INTO it. New agent_phase nodes need fresh unique keys (e.g. "phase-review").
Stages run as one agent session each; steps compile into the stage prompt.

Branching: a run walks ONE path. A node with several outgoing edges is a split point and
every one of those edges must carry a distinct conditionLabel — the labels are the outcomes
that node's agent chooses between at runtime, and the run follows the matching edge (the
other branches never run). Write labels as the answers to the question the stage settles
(e.g. "needs research" / "straightforward"). Never mix labeled and unlabeled edges out of
one node; a non-branching node has exactly one unlabeled outgoing edge. A single labeled
edge is invalid — a branch needs at least two choices.
To INSERT a stage between two connected stages, repoint the existing edge(s) — do not
create a parallel path. Graphs are acyclic: never add an edge that closes a loop; retries
are the orchestrator's job, not the graph's.
A publishable graph also needs every path from the trigger to reach at least one stage
with emitsChecks true — the verification gates arm from those. Scaffolding an incomplete
draft is fine (missing prompts, unnamed branches); the editor shows what still blocks
publish. Prefer scaffolding what was asked over inventing prompts the user didn't describe.`;

export function buildChatPrompt(graph: DraftGraph, message: string): string {
  return `You are editing a Tracker workflow definition. Do not use any tools, do not read or write files — answer from the JSON below alone.

${SCHEMA_HELP}

Current draft graph:
\`\`\`json
${JSON.stringify(graph, null, 2)}
\`\`\`

The user asks:
${message}

Apply the request to the graph. Answer with exactly one fenced JSON block and nothing else after it:
\`\`\`json
{"reply": "<one or two sentences on what you changed, or why you changed nothing>",
 "graph": <the full updated graph — every node and edge, not a diff>}
\`\`\``;
}

/** The last fenced JSON block wins — models sometimes think out loud first. */
export function parseChatResponse(text: string): ChatOutcome | ChatFailure {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = blocks.at(-1)?.[1] ?? text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "the model's answer contained no parseable JSON block" };
  }
  const body = parsed as { reply?: unknown; graph?: unknown };
  if (typeof body.reply !== "string" || typeof body.graph !== "object" || body.graph === null) {
    return { ok: false, error: "the model's JSON was missing reply or graph" };
  }
  return { ok: true, reply: body.reply, graph: body.graph as DraftGraph };
}

/** Concatenated `text` blocks — the answer, wherever the provider put it. */
export async function collectText(events: AsyncIterable<AgentEvent>): Promise<string> {
  const open = new Map<string, { kind: string; text: string }>();
  const closed: string[] = [];
  for await (const event of events) {
    if (event.type === "block.open") {
      open.set(event.blockId, { kind: event.block.kind, text: "text" in event.block ? event.block.text : "" });
    } else if (event.type === "block.delta") {
      const block = open.get(event.blockId);
      if (block) block.text += event.textDelta;
    } else {
      const block = open.get(event.blockId);
      open.delete(event.blockId);
      if (block?.kind === "text") closed.push(block.text);
    }
  }
  // A provider that never closed its blocks still gets its text counted.
  for (const block of open.values()) if (block.kind === "text") closed.push(block.text);
  return closed.join("\n");
}

/**
 * One chat turn. cwd is a scratch directory — the prompt forbids tool use,
 * but a provider that ignores that must land its mess somewhere harmless.
 */
export async function runWorkflowChat(
  provider: Provider,
  graph: DraftGraph,
  message: string,
  cwd: string,
  timeoutMs = 180_000,
  model?: string,
): Promise<ChatOutcome | ChatFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handle = provider.runPhase(buildChatPrompt(graph, message), cwd, {
      signal: controller.signal,
      // The composer's model chip; undefined = the instance's pinned model.
      model,
    });
    const [text, result] = await Promise.all([collectText(handle.events), handle.done]);
    if (result.outcome !== "completed") {
      return {
        ok: false,
        error: result.failureReason ?? `the provider ${result.outcome === "cancelled" ? "timed out" : result.outcome}`,
      };
    }
    return parseChatResponse(text);
  } finally {
    clearTimeout(timer);
  }
}
