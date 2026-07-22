import type { GateStatus, ProviderName, Repo } from "../server/types.ts";

// Skip renders as "n/a", never as a green check (ticket 06): a fact-driven
// "not applicable" must not masquerade as evidence.
export const GATE_MARKS: Record<GateStatus, string> = {
  pass: "✓",
  fail: "✗",
  skip: "n/a",
};

/** Repos have no name of their own — display the path's last segment. */
export function repoName(repo: Repo): string {
  return repo.path.split("/").filter(Boolean).at(-1) ?? repo.path;
}

/** Compact relative time for list rows: "26m ago", "3h ago", "134d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Driver labels (the fixed adapter set); instance display names come from
 *  the provider list — see providers.ts's providerLabel. */
export const PROVIDER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  kiro: "Kiro CLI",
  copilot: "Copilot CLI",
};
