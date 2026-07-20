#!/usr/bin/env node
// acp-driver.mjs — spawns `kiro-cli acp`, passes the MCP stub in session/new,
// prompts the agent to call declare_outcome, and reports what happened.
// Message shapes mirror Tracker's kiro adapter (src/server/providers/kiro.ts).
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "mcp-stub.mjs");
const SPIKE_LOG = join(HERE, "evidence.jsonl");
const CWD = join(HERE, "workspace");
mkdirSync(CWD, { recursive: true });
writeFileSync(SPIKE_LOG, ""); // fresh evidence per run

const child = spawn("kiro-cli", ["acp", "--trust-all-tools"], {
  cwd: CWD,
  env: { ...process.env, SPIKE_LOG },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 0;
const pending = new Map();
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

const say = (...a) => console.log("[driver]", ...a);

let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // agent-to-client request
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
        const allow = options.find((o) => typeof o?.kind === "string" && o.kind.startsWith("allow"));
        say("permission requested — answering", allow ? "allow" : "cancel");
        send({
          id: msg.id,
          result: {
            outcome: allow
              ? { outcome: "selected", optionId: allow.optionId }
              : { outcome: "cancelled" },
          },
        });
      } else {
        send({ id: msg.id, error: { code: -32601, message: "method not supported" } });
      }
      return;
    }
    // response to ours
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const w = pending.get(msg.id);
      if (!w) return;
      pending.delete(msg.id);
      if ("error" in msg) w.reject(new Error(JSON.stringify(msg.error)));
      else w.resolve(msg.result);
      return;
    }
    // notifications — surface tool activity and kiro's MCP extension events
    if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        say(`session/update: ${u.sessionUpdate} — ${u.title ?? u.toolCallId ?? ""} [${u.status ?? ""}]`);
      } else if (u?.sessionUpdate === "agent_message_chunk") {
        const t = u.content?.text ?? "";
        if (t.trim() !== "") process.stdout.write(t);
      } else {
        say(`session/update: ${u?.sessionUpdate}`);
      }
    } else if (typeof msg.method === "string" && msg.method.startsWith("_kiro.dev/mcp")) {
      say("kiro MCP event:", msg.method, JSON.stringify(msg.params).slice(0, 200));
    }
  }
});

let stderrTail = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-2000)));
child.on("close", (code) => {
  say(`kiro-cli exited (${code})`);
  if (stderrTail.trim()) say("stderr tail:", stderrTail.trim().slice(-500));
});

const deadline = setTimeout(() => {
  say("TIMEOUT — killing kiro-cli");
  child.kill("SIGTERM");
  setTimeout(() => process.exit(2), 2000);
}, 240_000);

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  say("initialize ok — mcpCapabilities:", JSON.stringify(init.agentCapabilities?.mcpCapabilities));

  const session = await request("session/new", {
    cwd: CWD,
    mcpServers: [
      { name: "tracker", command: process.execPath, args: [STUB], env: [{ name: "SPIKE_LOG", value: SPIKE_LOG }] },
    ],
  });
  say("session/new ok — sessionId:", session.sessionId);

  const response = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text: "You have an MCP tool named declare_outcome from the 'tracker' server. Call it exactly once with outcome='success' and reason='ACP MCP spike'. After the tool returns, reply with the single word DONE and stop. Do not read or write any files.",
      },
    ],
  });
  console.log();
  say("session/prompt finished — stopReason:", response.stopReason);
} catch (e) {
  say("ERROR:", e.message);
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  setTimeout(() => {
    say("--- evidence.jsonl ---");
    if (existsSync(SPIKE_LOG)) {
      const lines = readFileSync(SPIKE_LOG, "utf8").trim().split("\n").filter(Boolean);
      for (const l of lines) console.log(l);
      const called = lines.some((l) => l.includes('"TOOL_CALL"'));
      say(called ? "VERDICT: declare_outcome WAS called via MCP ✓" : "VERDICT: no tools/call arrived ✗");
      process.exit(called ? 0 : 1);
    } else {
      say("VERDICT: stub never spawned (no evidence file) ✗");
      process.exit(1);
    }
  }, 1500);
}
