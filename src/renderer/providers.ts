import { useEffect, useState } from "react";
import type { ProviderInstanceStatus, ProviderName } from "../server/types.ts";
import { apiGet } from "./api.ts";
import claudeCodeLogo from "./logos/claude-code.svg";
import copilotLogo from "./logos/copilot.svg";
import kiroLogo from "./logos/kiro.svg";

/** Vendored brand marks, keyed by driver (see logos/README.md for sources). */
export const PROVIDER_LOGOS: Record<ProviderName, string> = {
  "claude-code": claudeCodeLogo,
  kiro: kiroLogo,
  copilot: copilotLogo,
};

/**
 * The add-provider catalog: one entry per driver the app ships an adapter
 * for. The list a user builds in Settings is instances of these.
 */
export const DRIVER_CATALOG: Array<{
  driver: ProviderName;
  label: string;
  binary: string;
  description: string;
}> = [
  {
    driver: "claude-code",
    label: "Claude Code",
    binary: "claude",
    description: "Anthropic's coding agent via the claude CLI",
  },
  {
    driver: "kiro",
    label: "Kiro CLI",
    binary: "kiro",
    description: "AWS Kiro, driven over ACP",
  },
  {
    driver: "copilot",
    label: "Copilot CLI",
    binary: "copilot",
    description: "GitHub Copilot's coding agent CLI",
  },
];

/**
 * The provider list (migration 26) for every picker that offers a provider.
 * One fetch per renderer load, shared: pickers open constantly (promote
 * cards, automations), the list changes only on a Settings edit, and stale
 * options are already server-rejected on submit. A Settings surface that
 * mutates the list refreshes the cache itself via refreshProviderInstances.
 */
let cache: ProviderInstanceStatus[] | null = null;
let inflight: Promise<ProviderInstanceStatus[]> | null = null;
const listeners = new Set<(instances: ProviderInstanceStatus[]) => void>();

async function fetchInstances(): Promise<ProviderInstanceStatus[]> {
  inflight ??= apiGet<ProviderInstanceStatus[]>("/api/provider-instances").finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function refreshProviderInstances(): Promise<ProviderInstanceStatus[]> {
  const instances = await fetchInstances();
  cache = instances;
  for (const listener of listeners) listener(instances);
  return instances;
}

export function useProviderInstances(): ProviderInstanceStatus[] | null {
  const [instances, setInstances] = useState<ProviderInstanceStatus[] | null>(cache);
  useEffect(() => {
    listeners.add(setInstances);
    if (cache === null) void refreshProviderInstances().catch(() => {});
    return () => {
      listeners.delete(setInstances);
    };
  }, []);
  return instances;
}

/**
 * Per-driver model choices for surfaces offering an ad-hoc override (the
 * builder chat's model chip). Claude Code's CLI takes stable aliases; the
 * other drivers only reveal models via a live probe, so they offer none and
 * run on the instance's pinned model. value rides RunPhaseOpts.model.
 */
export const MODEL_CHOICES: Record<ProviderName, Array<{ value: string; label: string }>> = {
  "claude-code": [
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  kiro: [],
  copilot: [],
};

/** Label for a stored provider reference; falls back to the raw id. */
export function providerLabel(
  instances: ProviderInstanceStatus[] | null,
  id: string | null,
): string {
  if (id === null) return "—";
  return instances?.find((i) => i.id === id)?.displayName ?? id;
}
