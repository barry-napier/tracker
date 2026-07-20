#!/usr/bin/env node
/**
 * A stand-in for copilot-wrapper.mjs: speaks the adapter's NDJSON protocol
 * without touching the Copilot SDK, so the whole transport runs under test
 * with no auth and no premium requests. Reads the same stdin config the real
 * wrapper reads. Same warning as the other fixtures: this shares its
 * author's assumptions, so the live suite stays the wire-format authority.
 *
 * FAKE_COPILOT_MODE selects the ending:
 *   success      (default) streams, writes the contract file, result completed
 *   failed       streams, then reports a failed result (quota blown)
 *   hang         streams, then never reports; dies politely on SIGTERM
 *   ignore-term  like hang, but traps SIGTERM — only SIGKILL ends the phase
 *   crash-mid    streams one delta, then dies without a result line
 *   linger       like success, but never exits after the result line — the
 *                adapter's post-result axe is what ends the phase
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_COPILOT_MODE ?? "success";

const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const config = JSON.parse(await readStdin());

out({ type: "session", sessionId: "fake-copilot-session-1" });
out({ type: "delta", kind: "thinking", text: "Working out " });
out({ type: "delta", kind: "thinking", text: "what this phase owes." });

if (mode === "crash-mid") {
  process.stderr.write("fake wrapper told to crash\n");
  process.exit(1);
}

out({ type: "delta", kind: "text", text: "Writing " });
out({ type: "delta", kind: "text", text: "the contract file " });
out({ type: "delta", kind: "text", text: `(model=${config.model ?? "(none)"}).` });

if (mode === "hang" || mode === "ignore-term") {
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000); // stay alive until a signal ends us
} else {
  const contract = /write (kb\/[\w-]+\.md)/i.exec(config.prompt ?? "")?.[1];
  if (contract) {
    const target = path.join(process.cwd(), contract);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "# contract\n\nWritten by the fake copilot wrapper.\n");
    out({ type: "tool_call", callId: "call-1", tool: "write", input: JSON.stringify({ path: contract }) });
    out({ type: "tool_result", callId: "call-1", tool: "write", output: `wrote ${contract}`, isError: false });
  }
  // Interleaved noise the mapper must shrug off, like the other fixtures.
  process.stdout.write("not json at all\n");
  out({ type: "next-release-novelty", data: 1 });

  out(
    mode === "failed"
      ? {
          type: "result",
          outcome: "failed",
          failureReason: "quota: out of premium requests",
          usage: { premiumRequests: 2, inputTokens: 100, outputTokens: 20 },
        }
      : {
          type: "result",
          outcome: "completed",
          usage: { premiumRequests: 2, inputTokens: 100, outputTokens: 20 },
        },
  );
  // linger: the result is out but "cleanup" wedges — stay alive until killed.
  if (mode === "linger") setInterval(() => {}, 1_000);
  else process.exit(0);
}
