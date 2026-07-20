#!/usr/bin/env node
// mcp-stub.mjs — minimal stdio MCP server exposing one tool: declare_outcome.
// Newline-delimited JSON-RPC 2.0. Logs everything to SPIKE_LOG as evidence.
import { appendFileSync } from "node:fs";

const LOG = process.env.SPIKE_LOG ?? "/tmp/mcp-spike.log";
const log = (entry) =>
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

const TOOL = {
  name: "declare_outcome",
  description:
    "Declare the outcome of the current phase to Tracker. Call exactly once when the phase's work is done.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["success", "failure"], description: "Phase outcome" },
      reason: { type: "string", description: "One-line justification" },
    },
    required: ["outcome", "reason"],
  },
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log({ dir: "in", unparseable: line.slice(0, 200) });
      continue;
    }
    log({ dir: "in", method: msg.method, id: msg.id, params: msg.params });

    if (msg.method === "initialize") {
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tracker-stub", version: "0.0.1" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({ id: msg.id, result: { tools: [TOOL] } });
    } else if (msg.method === "tools/call") {
      log({ dir: "TOOL_CALL", name: msg.params?.name, arguments: msg.params?.arguments });
      send({
        id: msg.id,
        result: {
          content: [{ type: "text", text: "Outcome recorded by Tracker. You may finish now." }],
          isError: false,
        },
      });
    } else if (msg.method === "ping") {
      send({ id: msg.id, result: {} });
    } else if (msg.id !== undefined) {
      send({ id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
    }
    // notifications (e.g. notifications/initialized) need no reply
  }
});
process.stdin.on("end", () => process.exit(0));
