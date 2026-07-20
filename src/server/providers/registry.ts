import type { ProviderRegistry } from "../provider.ts";
import type { ProviderConfig, ProviderName } from "../types.ts";
import { ClaudeCodeProvider, type ClaudeCodeConfig } from "./claude-code.ts";
import { demoProviders } from "./demo.ts";

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

/**
 * The registry the desktop app runs with. Claude Code is a real adapter from
 * ticket 38 on; Kiro and Copilot stay scripted until their own slices (39,
 * 40) land, so the board still walks a full workflow on any provider.
 */
export function appProviders(config: ProviderConfigReader): ProviderRegistry {
  return {
    ...demoProviders(),
    "claude-code": new ClaudeCodeProvider(() => toClaudeCodeConfig(config("claude-code"))),
  };
}
