/**
 * The live proof for the zero-token probe spike (t3code steal #1): runs
 * every real adapter's probe() against whatever is installed and signed in
 * on this machine, concurrently, and prints one line per provider. PASS
 * means the probe resolved and answered honestly — ok:false with a real
 * reason (CLI absent, logged out) is still a pass; a rejection or a hang is
 * the only failure. Exits non-zero on any failure.
 *
 *   node scripts/prove-probe.ts
 */
import { ClaudeCodeProvider } from "../src/server/providers/claude-code.ts";
import { CopilotProvider } from "../src/server/providers/copilot.ts";
import { KiroProvider } from "../src/server/providers/kiro.ts";
import type { ProbeResult, Provider } from "../src/server/provider.ts";

const providers: Record<string, Provider> = {
  "claude-code": new ClaudeCodeProvider(() => ({ env: {} })),
  kiro: new KiroProvider(() => ({ env: {} })),
  copilot: new CopilotProvider(() => ({ env: {} })),
};

let failures = 0;
await Promise.all(
  Object.entries(providers).map(async ([name, provider]) => {
    const start = Date.now();
    let result: ProbeResult;
    try {
      result = await provider.probe();
    } catch (error) {
      failures++;
      console.log(`FAIL  ${name} — probe rejected (contract breach): ${String(error)}`);
      return;
    }
    const ms = Date.now() - start;
    const detail = result.ok
      ? `ok${result.account ? ` account=${result.account}` : ""}${
          result.models ? ` models=${result.models.length} [${result.models.slice(0, 4).join(", ")}${result.models.length > 4 ? ", …" : ""}]` : ""
        }`
      : `not ok — ${result.error}`;
    console.log(`PASS  ${name} (${ms}ms) — ${detail}`);
  }),
);

process.exit(failures === 0 ? 0 : 1);
