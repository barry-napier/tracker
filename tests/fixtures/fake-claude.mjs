#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary: speaks real stream-json NDJSON so the
 * adapter's whole spawn path — argv, chunked stdout, exit codes, SIGTERM —
 * runs under test without an API call. The live CLI is smoke-tested
 * separately (tests/provider-contract.test.ts); this is what keeps the
 * contract green on every `npm test`, for free and deterministically.
 *
 * FAKE_CLAUDE_MODE selects the ending:
 *   success   (default) writes the contract file, exits 0 with a success result
 *   truncated dies mid-stream with no result line
 *   error     emits a result line with is_error true
 *   garbage   interleaves malformed and unknown-type lines, then succeeds
 *   hang      streams, then waits forever — for cancellation
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const SESSION = "fake-session-1";

const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

say({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  tools: ["Read", "Write"],
  model: argv[argv.indexOf("--model") + 1] ?? "fake-model",
  session_id: SESSION,
});

if (mode === "garbage") {
  process.stdout.write("this line is not json\n");
  say({ type: "some_future_event", whatever: true });
  process.stdout.write('{"truncated": \n');
}

say({
  type: "assistant",
  message: {
    id: "msg_fake_1",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Working out what this phase owes." },
      // Echoing the resolved --model back as ordinary conversation is what
      // lets a test observe which config the adapter built this argv from.
      { type: "text", text: `model=${argv[argv.indexOf("--model") + 1] ?? "(none)"}` },
    ],
  },
  session_id: SESSION,
});

if (mode === "truncated") {
  // No result line — exactly the truncation bug the adapter must call crashed.
  // Falling off the end (rather than process.exit) still flushes what was
  // written; the point is the missing result line, not a torn pipe.
  process.exitCode = 0;
}

else if (mode === "hang") {
  // Nothing more will be written; the parent's SIGTERM is the only way out.
  setInterval(() => {}, 1 << 30);
} else {
  // The contract file the Phase Contract requires, named by the prompt the
  // way a real agent would read it.
  const contract = /write (kb\/[\w-]+\.md)/i.exec(prompt)?.[1];
  if (contract) {
    const target = path.join(process.cwd(), contract);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `# contract\n\nWritten by the fake claude binary.\n`);
    say({
      type: "assistant",
      message: {
        id: "msg_fake_2",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input: { path: contract } }],
      },
      session_id: SESSION,
    });
    say({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_fake_1", content: `wrote ${contract}`, is_error: false },
        ],
      },
      session_id: SESSION,
    });
  }

  const failed = mode === "error";
  say({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: failed ? "the fake binary was told to fail" : "done",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 20 },
    session_id: SESSION,
  });
  // Never process.exit() here: stdout to a pipe is async, and exiting discards
  // whatever is still buffered — which would tear off the result line we just
  // wrote and make every mode look like a truncated stream.
  process.exitCode = failed ? 1 : 0;
}
