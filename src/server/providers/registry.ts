import type { ProviderRegistry } from "../provider.ts";
import type { ProviderConfig, ProviderName } from "../types.ts";
import { ClaudeCodeProvider, type ClaudeCodeConfig } from "./claude-code.ts";
import { CopilotProvider, type CopilotConfig } from "./copilot.ts";
import { KiroProvider, type KiroConfig } from "./kiro.ts";

/** Reads the app-level config for a provider, live — never cached at boot. */
export type ProviderConfigReader = (provider: ProviderName) => ProviderConfig;

/**
 * ProviderConfig and ClaudeCodeConfig carry the same fields and differ only
 * in how they spell "absent" — and that difference is the point of the
 * translation. A stored row is a SQL row: every column exists, and null is
 * the value meaning unset. An adapter's config is an argv builder's input,
 * where a field is either present or not there at all. Collapsing them would
 * make `buildArgs` test `=== null` and start emitting `--model null` the
 * first time someone forgot.
 */
export function toClaudeCodeConfig(stored: ProviderConfig): ClaudeCodeConfig {
  return {
    binaryPath: stored.binaryPath ?? undefined,
    model: stored.model ?? undefined,
    maxBudgetUsd: stored.maxBudgetUsd ?? undefined,
    env: stored.env,
  };
}

/** Same translation, Kiro's shape — it has no budget field to carry. */
export function toKiroConfig(stored: ProviderConfig): KiroConfig {
  return {
    binaryPath: stored.binaryPath ?? undefined,
    model: stored.model ?? undefined,
    env: stored.env,
  };
}

/**
 * Same translation, Copilot's shape. binaryPath means the copilot CLI
 * runtime the SDK spawns (unset = the one bundled with the SDK); the
 * wrapper path is the adapter's own, never operator config.
 */
export function toCopilotConfig(stored: ProviderConfig): CopilotConfig {
  return {
    cliPath: stored.binaryPath ?? undefined,
    model: stored.model ?? undefined,
    env: stored.env,
  };
}

/**
 * The registry the desktop app runs with — every provider real as of ticket
 * 40: Claude Code (38), Kiro over ACP (39), Copilot over the SDK (40). The
 * demo stop-gap registry retired with it.
 */
export function appProviders(config: ProviderConfigReader): ProviderRegistry {
  return {
    "claude-code": new ClaudeCodeProvider(() => toClaudeCodeConfig(config("claude-code"))),
    kiro: new KiroProvider(() => toKiroConfig(config("kiro"))),
    copilot: new CopilotProvider(() => toCopilotConfig(config("copilot"))),
  };
}
