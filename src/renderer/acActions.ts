import type { AcceptanceCriterion } from "../server/types.ts";
import { apiPost } from "./api.ts";

/** One AC action against the store; errors surface, success runs onDone. */
export function settleAc(route: string, body: unknown, onDone: () => void = () => {}): void {
  apiPost(route, body)
    .then(onDone)
    .catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
}

/**
 * The waive flow shared by the drawer and the wizard: human-only, reason
 * mandatory (CONTEXT.md) — an empty or cancelled prompt waives nothing.
 */
export function waiveWithPrompt(
  criterion: Pick<AcceptanceCriterion, "id" | "text">,
  onDone: () => void = () => {},
): void {
  const reason = window.prompt(`Waive "${criterion.text}" — reason (required):`);
  if (reason === null || reason.trim() === "") return;
  settleAc(`/api/acs/${criterion.id}/waive`, { reason: reason.trim() }, onDone);
}
