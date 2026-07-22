import type { Provider, ProviderRegistry } from "../provider.ts";
import type { ProviderInstance, ProviderName } from "../types.ts";
import { ClaudeCodeProvider, type ClaudeCodeConfig } from "./claude-code.ts";
import { CopilotProvider, type CopilotConfig } from "./copilot.ts";
import { KiroProvider, type KiroConfig } from "./kiro.ts";

/** Reads a provider instance's stored row, live — never cached at boot. */
export type ProviderInstanceReader = (id: string) => ProviderInstance | undefined;

/**
 * ProviderInstance and ClaudeCodeConfig carry the same config fields and
 * differ only in how they spell "absent" — and that difference is the point
 * of the translation. A stored row is a SQL row: every column exists, and
 * null is the value meaning unset. An adapter's config is an argv builder's
 * input, where a field is either present or not there at all. Collapsing
 * them would make `buildArgs` test `=== null` and start emitting
 * `--model null` the first time someone forgot.
 */
export function toClaudeCodeConfig(stored: ProviderInstance): ClaudeCodeConfig {
  return {
    binaryPath: stored.binaryPath ?? undefined,
    model: stored.model ?? undefined,
    maxBudgetUsd: stored.maxBudgetUsd ?? undefined,
    env: stored.env,
  };
}

/** Same translation, Kiro's shape — it has no budget field to carry. */
export function toKiroConfig(stored: ProviderInstance): KiroConfig {
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
export function toCopilotConfig(stored: ProviderInstance): CopilotConfig {
  return {
    cliPath: stored.binaryPath ?? undefined,
    model: stored.model ?? undefined,
    env: stored.env,
  };
}

/**
 * A deleted-mid-run instance must not crash the adapter's live config read;
 * all-defaults is the honest degraded answer (the run was claimed while the
 * row existed — the binary resolves on PATH exactly as an unconfigured
 * default would).
 */
function readOrDefaults(
  instances: ProviderInstanceReader,
  id: string,
  driver: ProviderName,
): ProviderInstance {
  return (
    instances(id) ?? {
      id,
      driver,
      displayName: id,
      enabled: false,
      binaryPath: null,
      model: null,
      maxBudgetUsd: null,
      env: {},
    }
  );
}

/** One adapter constructor per driver, each reading its instance's row live. */
function buildAdapter(
  instances: ProviderInstanceReader,
  id: string,
  driver: ProviderName,
): Provider {
  const read = () => readOrDefaults(instances, id, driver);
  switch (driver) {
    case "claude-code":
      return new ClaudeCodeProvider(() => toClaudeCodeConfig(read()));
    case "kiro":
      return new KiroProvider(() => toKiroConfig(read()));
    case "copilot":
      return new CopilotProvider(() => toCopilotConfig(read()));
  }
}

/**
 * The registry the desktop app runs with — no longer a fixed object (one
 * entry per driver, ticket 40) but a lazy view over the provider_instances
 * table: instances are user-addable at runtime, so adapters are constructed
 * on first lookup and cached per instance id. A Proxy keeps the registry's
 * `providers[id]` record shape every consumer (engine, app, tests) already
 * uses. Disabled or deleted instances answer undefined on every lookup —
 * exactly the "unregistered provider" shape the claim crash-path expects —
 * but the cached adapter is kept so a re-enable does not orphan a running
 * run's adapter identity.
 */
export function appProviders(instances: ProviderInstanceReader): ProviderRegistry {
  const cache = new Map<string, Provider>();
  return new Proxy({} as ProviderRegistry, {
    get(_target, id: string | symbol): Provider | undefined {
      if (typeof id !== "string") return undefined;
      const instance = instances(id);
      if (!instance || !instance.enabled) return undefined;
      let adapter = cache.get(id);
      if (!adapter) {
        adapter = buildAdapter(instances, id, instance.driver);
        cache.set(id, adapter);
      }
      return adapter;
    },
    has(_target, id) {
      return typeof id === "string" && instances(id)?.enabled === true;
    },
  });
}
