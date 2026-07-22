// Pure pill logic for the topbar update pill — kept DOM-free for tests.
import type { UpdateState } from "../updates/updateState.ts";

export type PillAction = "download" | "install" | "retry" | "none";

// Check failures stay silent (the poll will try again); only surface states
// the user can act on, plus retryable download failures.
export function shouldShowPill(state: UpdateState | null): boolean {
  if (!state) return false;
  switch (state.status) {
    case "available":
    case "downloading":
    case "downloaded":
      return true;
    default:
      return false;
  }
}

export function pillLabel(state: UpdateState): string {
  switch (state.status) {
    case "available":
      return state.errorContext === "download"
        ? "Update failed — retry"
        : `Update v${state.availableVersion ?? "?"}`;
    case "downloading":
      return `Downloading ${state.downloadPercent ?? 0}%`;
    case "downloaded":
      return "Restart to update";
    default:
      return "";
  }
}

export function pillAction(state: UpdateState): PillAction {
  switch (state.status) {
    case "available":
      return state.errorContext === "download" ? "retry" : "download";
    case "downloaded":
      return "install";
    default:
      return "none";
  }
}
