import type { ProviderName } from "../server/types.ts";
import claudeCodeLogo from "./logos/claude-code.svg";
import copilotLogo from "./logos/copilot.svg";
import kiroLogo from "./logos/kiro.svg";

/** The vendored brand marks (logos/README.md) — same set Settings and
 *  Automations use, so a provider looks identical on every surface. */
const PROVIDER_LOGOS: Record<ProviderName, string> = {
  "claude-code": claudeCodeLogo,
  kiro: kiroLogo,
  copilot: copilotLogo,
};

export function ProviderIcon({ provider, size = 16 }: { provider: ProviderName; size?: number }) {
  return (
    <img
      className={`providericon providericon-${provider}`}
      src={PROVIDER_LOGOS[provider]}
      alt=""
      width={size}
      height={size}
    />
  );
}
