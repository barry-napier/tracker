import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ProviderInstance, ProviderName } from "./types.ts";

/**
 * The binary each adapter spawns when no binaryPath is configured — the same
 * fallbacks the adapters themselves use (claude-code.ts, kiro.ts,
 * copilot-wrapper.mjs). Copilot's SDK-bundled runtime is no longer packaged
 * (245MB platform binary), so the wrapper resolves `copilot` on PATH.
 */
const DEFAULT_BINARIES: Record<ProviderName, string | null> = {
  "claude-code": "claude",
  kiro: "kiro-cli",
  copilot: "copilot",
};

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Would this instance's spawn find its binary? A PATH-shaped answer only —
 * no process is started, no auth checked (that's the adapter's probe(), a
 * later slice). An instance's env may override PATH for the child, so that
 * PATH is the one searched.
 *
 * Returns null when available, else the human-facing reason.
 */
export function availabilityReason(instance: ProviderInstance): string | null {
  const target = instance.binaryPath ?? DEFAULT_BINARIES[instance.driver];
  if (target === null) return null; // SDK-bundled runtime; nothing to resolve.
  if (path.isAbsolute(target)) {
    return isExecutableFile(target)
      ? null
      : `${instance.displayName} — Unavailable. \`${target}\` is not an executable file.`;
  }
  const searchPath = instance.env.PATH ?? process.env.PATH ?? "";
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir !== "" && isExecutableFile(path.join(dir, target))) return null;
  }
  return `${instance.displayName} — Unavailable. \`${target}\` is not installed or not on PATH.`;
}
