import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../provider.ts";
import type { ProviderRegistry } from "../provider.ts";
import { PROVIDERS } from "../types.ts";
import { FakeProvider } from "./fake.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop-gap registry for the dev app until the real adapter slices land
 * (Claude Code stream-json, Kiro ACP, Copilot SDK): every provider name maps
 * to a FakeProvider that walks a small scripted conversation — slowly, so
 * the drawer's live log view has something to stream — honors the Phase
 * Contract, and completes.
 */
export function demoProviders(): ProviderRegistry {
  const registry: ProviderRegistry = {};
  for (const name of PROVIDERS) {
    registry[name] = new FakeProvider(async function* ({ prompt, cwd }) {
      // The phase rides in the prompt's contract instruction, as it will
      // for real agents; block ids are per-phase so a run's log never collides.
      const phase = /write kb\/([a-z]+)\.md/.exec(prompt)?.[1] ?? "implement";
      let id = 0;
      const block = (content: Extract<AgentEvent, { type: "block.open" }>["block"]) => {
        id += 1;
        return { open: { type: "block.open" as const, blockId: `${phase}-demo-${id}`, block: content } };
      };

      const p = block({ kind: "prompt", text: prompt });
      yield p.open;
      yield { type: "block.close", blockId: p.open.blockId };
      await sleep(900);

      const think = block({ kind: "thinking", text: "Reading the ticket and the worktree." });
      yield think.open;
      yield { type: "block.close", blockId: think.open.blockId };
      await sleep(900);

      const text = block({ kind: "text", text: "" });
      yield text.open;
      for (const word of `This is the ${name} demo provider — no real agent is attached yet, so I am narrating a scripted ${phase} phase instead.`.split(
        " ",
      )) {
        yield { type: "block.delta", blockId: text.open.blockId, textDelta: `${word} ` };
        await sleep(250);
      }
      yield { type: "block.close", blockId: text.open.blockId };

      const call = block({ kind: "tool_call", tool: "write_file", input: `{"path":"kb/${phase}.md"}` });
      yield call.open;
      yield { type: "block.close", blockId: call.open.blockId };
      mkdirSync(path.join(cwd, "kb"), { recursive: true });
      writeFileSync(
        path.join(cwd, "kb", `${phase}.md`),
        `# ${phase}\n\nScripted demo phase — no real work happened.\n`,
      );
      await sleep(700);

      const result = block({ kind: "tool_result", tool: "write_file", output: `wrote kb/${phase}.md`, isError: false });
      yield result.open;
      yield { type: "block.close", blockId: result.open.blockId };

      return { outcome: "completed" as const };
    });
  }
  return registry;
}
