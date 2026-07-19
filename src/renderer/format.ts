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

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  "claude-code": "Claude Code",
  kiro: "Kiro CLI",
  copilot: "Copilot CLI",
};
