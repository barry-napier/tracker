#!/usr/bin/env node
/**
 * The Tracker-owned Copilot wrapper (ticket 40): reads `{prompt, model,
 * cliPath}` as JSON from stdin, drives one session through the official
 * `@github/copilot-sdk`, and emits the adapter's NDJSON protocol on stdout:
 *
 *   {type:"session", sessionId}
 *   {type:"delta", kind:"text"|"thinking", text}
 *   {type:"tool_call", callId, tool, input}
 *   {type:"tool_result", callId, tool, output, isError}
 *   {type:"result", outcome:"completed"|"failed", failureReason?, usage?}
 *
 * The result line is the phase's verdict; dying without one is a crash the
 * adapter reports as transport, so this file emits it only for endings the
 * SDK actually judged. Everything else — SDK missing, auth blow-up — goes to
 * stderr and exits non-zero.
 *
 * Deliberately dumb: every rule worth testing (stream bookkeeping, block
 * ids, tolerance) lives in WrapperMapper on the adapter side, where it runs
 * under unit tests. This file only translates SDK callbacks 1:1 into
 * protocol lines. It stays plain JS so the same file runs from src/ under
 * vitest and from build/ in the packaged app.
 */

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

/** First executable named `copilot` on PATH, or undefined. The SDK's bundled
 * runtime is deliberately not packaged (it is a 245MB platform binary — the
 * whole reason the app ships without it), so the user's own CLI is the only
 * default. */
function findCopilotOnPath() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "copilot");
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not this dir.
    }
  }
  return undefined;
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const config = JSON.parse(await readStdin());
const { CopilotClient, RuntimeConnection, approveAll } = await import("@github/copilot-sdk");

const cliPath = config.cliPath ?? findCopilotOnPath();
if (cliPath === undefined) {
  process.stderr.write(
    "copilot CLI not found on PATH — install GitHub Copilot CLI or set a binary path in settings\n",
  );
  process.exit(1);
}

const client = new CopilotClient({
  // cwd is the phase's worktree — the adapter spawned us there.
  connection: RuntimeConnection.forStdio({ path: cliPath }),
  logLevel: "error",
});

// SIGTERM is the orchestrator cancelling. Stop the runtime we spawned so the
// SDK's CLI child does not outlive the phase, then exit; the adapter's
// SIGKILL backstop covers us if this cleanup wedges.
let terminating = false;
process.on("SIGTERM", () => {
  if (terminating) return;
  terminating = true;
  client.forceStop().finally(() => process.exit(143));
});

await client.start();

// Probe mode: `{probe: true, cliPath}` on stdin. getAuthStatus and
// listModels are the SDK's own zero-token endpoints — no session, no model
// call. One line out, then gone.
if (config.probe === true) {
  const auth = await client.getAuthStatus();
  let models;
  try {
    models = (await client.listModels()).map((model) => model.id).filter(Boolean);
  } catch {
    // Model listing is color; auth is the verdict. An SDK that can't list
    // (older CLI runtime) still answers the question that matters.
  }
  out({
    type: "probe",
    ok: auth.isAuthenticated === true,
    account: auth.statusMessage ?? auth.login,
    models,
  });
  await client.stop();
  process.exit(0);
}

const session = await client.createSession({
  // Pinned explicitly: tool operations resolve against the SESSION's working
  // directory, which does not reliably inherit the runtime process cwd — the
  // live suite caught the agent writing its contract file elsewhere.
  workingDirectory: process.cwd(),
  ...(config.model ? { model: config.model } : {}),
  streaming: true,
  // Full-tool-allowance posture, like the other adapters: there is nobody to
  // answer a permission prompt mid-phase. Isolation is the orchestrator's
  // job — the phase runs in a throwaway git worktree.
  onPermissionRequest: approveAll,
  // The SDK's default persona pauses to ask clarifying questions — the live
  // suite caught it ending a turn with "could you provide more details"
  // instead of acting. Same hazard the CLI's --no-ask-user exists for
  // (issue 03); appended, so the SDK's own guardrails stay intact.
  systemMessage: {
    content:
      "You are running unattended inside an automated pipeline. No human can " +
      "reply mid-run: never end your turn to ask for clarification or " +
      "approval. Make reasonable assumptions, act with the tools available, " +
      "and complete the task you were given.",
  },
});
out({ type: "session", sessionId: session.sessionId });

/** The last session.error seen — the failure reason if the turn ends badly. */
let sessionError;
/** Premium-request accounting: the SDK reports per-call model multipliers. */
const usage = { premiumRequests: 0, inputTokens: 0, outputTokens: 0 };
/** Tool names by call id, so results carry the tool's name, not an id. */
const toolNames = new Map();
// Deltas and finals both arrive (finals always, deltas when streaming
// works). Forward deltas; fall back to a final only when NO delta of that
// kind has arrived all session — the flags are deliberately never reset,
// because the runtime re-emits finals per agent-loop turn with accumulated
// content (observed live: a per-turn reset rendered the whole reasoning
// text a second time). A model either streams or it doesn't.
let sawTextDelta = false;
let sawReasoningDelta = false;

session.on((event) => {
  switch (event.type) {
    case "assistant.message_delta":
      sawTextDelta = true;
      out({ type: "delta", kind: "text", text: event.data.deltaContent ?? "" });
      break;
    case "assistant.reasoning_delta":
      sawReasoningDelta = true;
      out({ type: "delta", kind: "thinking", text: event.data.deltaContent ?? "" });
      break;
    case "assistant.message":
      if (!sawTextDelta && event.data.content) {
        out({ type: "delta", kind: "text", text: event.data.content });
      }
      break;
    case "assistant.reasoning":
      if (!sawReasoningDelta && event.data.content) {
        out({ type: "delta", kind: "thinking", text: event.data.content });
      }
      break;
    case "tool.execution_start":
      toolNames.set(event.data.toolCallId, event.data.toolName);
      out({
        type: "tool_call",
        callId: event.data.toolCallId,
        tool: event.data.toolName,
        input: JSON.stringify(event.data.arguments ?? {}),
      });
      break;
    case "tool.execution_complete":
      out({
        type: "tool_result",
        callId: event.data.toolCallId,
        tool: toolNames.get(event.data.toolCallId) ?? event.data.toolCallId,
        output: event.data.success
          ? (event.data.result?.content ?? "")
          : (event.data.error?.message ?? ""),
        isError: !event.data.success,
      });
      break;
    case "session.error":
      sessionError = event.data;
      break;
    case "assistant.usage":
      // `cost` is the billing multiplier per API call — premium requests,
      // the only spend unit Copilot reports (issue 03: no USD anywhere).
      usage.premiumRequests += event.data.cost ?? 0;
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      break;
    default:
      break; // Unknown event types are the SDK's business, not the phase's.
  }
});

// sendAndWait resolves on session.idle — SDK completion is the success
// signal (the research: exit codes and stderr footers are not contracts).
await session.sendAndWait({ prompt: config.prompt });

out(
  sessionError
    ? {
        type: "result",
        outcome: "failed",
        failureReason: `${sessionError.errorType}: ${sessionError.message}`,
        usage,
      }
    : { type: "result", outcome: "completed", usage },
);

await session.disconnect();
await client.stop();
process.exit(0);
