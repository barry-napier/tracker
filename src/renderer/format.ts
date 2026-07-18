import type { ProviderName, Repo } from "../server/types.ts";

/** Repos have no name of their own — display the path's last segment. */
export function repoName(repo: Repo): string {
  return repo.path.split("/").filter(Boolean).at(-1) ?? repo.path;
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  "claude-code": "Claude Code",
  kiro: "Kiro CLI",
  copilot: "Copilot CLI",
};
