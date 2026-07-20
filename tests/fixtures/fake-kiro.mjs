#!/usr/bin/env node
/**
 * A stand-in for `kiro-cli acp`: newline-delimited JSON-RPC 2.0 over stdio,
 * shaped after the live handshake verified in issue 02 (initialize →
 * session/new with cwd → session/prompt → session/update stream → stopReason).
 * Same rationale as fake-claude.mjs — the whole transport runs under test
 * with no tokens — and the same warning: this fixture shares its author's
 * assumptions, so the live suite stays the wire-format authority.
 *
 * FAKE_KIRO_MODE selects the ending:
 *   success          (default) streams, writes the contract file, end_turn
 *   refusal          streams, then answers the prompt with stopReason refusal
 *   hang             streams, then never answers; ignores session/cancel too,
 *                    so only the adapter's SIGTERM ends the phase
 *   cancel-graceful  like hang, but session/cancel resolves the prompt with
 *                    stopReason cancelled — the graceful half of the contract
 *   crash-mid        streams one chunk, then dies without a response
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.env.FAKE_KIRO_MODE ?? "success";
const SESSION = "fake-kiro-session-1";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (payload) =>
  send({ method: "session/update", params: { sessionId: SESSION, update: payload } });
const chunk = (kind, text) => update({ sessionUpdate: kind, content: { type: "text", text } });

let promptId;
let promptText = "";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "Fake Kiro", version: "0.0.0" },
      },
    });
    return;
  }

  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: SESSION, modes: [] } });
    return;
  }

  if (message.method === "session/cancel") {
    // The graceful half: resolve the open prompt as cancelled. hang mode
    // ignores this on purpose — the adapter's kill timer is under test.
    if (mode === "cancel-graceful" && promptId !== undefined) {
      send({ id: promptId, result: { stopReason: "cancelled" } });
      promptId = undefined;
    }
    return;
  }

  if (message.method === "session/prompt") {
    promptId = message.id;
    promptText = message.params?.prompt?.[0]?.text ?? "";

    chunk("agent_thought_chunk", "Working out ");
    chunk("agent_thought_chunk", "what this phase owes.");
    chunk("agent_message_chunk", "Writing ");
    chunk("agent_message_chunk", "the contract file ");
    chunk("agent_message_chunk", `(model=${modelArg() ?? "(none)"}).`);

    if (mode === "crash-mid") process.exit(1);
    if (mode === "hang" || mode === "cancel-graceful") return; // stream stays open

    const contract = /write (kb\/[\w-]+\.md)/i.exec(promptText)?.[1];
    if (contract) {
      const target = path.join(process.cwd(), contract);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "# contract\n\nWritten by the fake kiro binary.\n");
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: `Write ${contract}`,
        kind: "edit",
        status: "pending",
        rawInput: { path: contract },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `wrote ${contract}` } }],
      });
    }

    send({
      id: promptId,
      result: { stopReason: mode === "refusal" ? "refusal" : "end_turn" },
    });
    promptId = undefined;
  }
});

function modelArg() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--model");
  return at === -1 ? undefined : argv[at + 1];
}
