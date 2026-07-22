import { useEffect, useState } from "react";
import type { UpdateState } from "../updates/updateState.ts";
import { pillAction, pillLabel, shouldShowPill } from "./updatePill.ts";

interface UpdateBridge {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
  onState(handler: (state: UpdateState) => void): () => void;
}

// Same ad-hoc bridge typing as TerminalDrawer/RightSidebar — the preload
// surface is untyped, each consumer names the slice it uses.
function updateBridge(): UpdateBridge | undefined {
  return (window as { tracker?: { update?: UpdateBridge } }).tracker?.update;
}

function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = updateBridge();
    if (!bridge) return;
    // Subscribe first, then seed — a push between the two just wins.
    const unsubscribe = bridge.onState(setState);
    void bridge.getState().then(setState).catch(() => {});
    return unsubscribe;
  }, []);
  return state;
}

/** Topbar pill: "Update vX" → "Downloading N%" → "Restart to update". */
export function UpdatePill(): React.ReactNode {
  const state = useUpdateState();
  if (!state || !shouldShowPill(state)) return null;

  const action = pillAction(state);
  const onClick = (): void => {
    const bridge = updateBridge();
    if (!bridge) return;
    if (action === "download" || action === "retry") void bridge.download();
    else if (action === "install") {
      if (window.confirm(`Restart Tracker to install v${state.availableVersion ?? "?"}?`)) {
        void bridge.install();
      }
    }
  };

  return (
    <button
      type="button"
      className="badge update-pill"
      disabled={action === "none"}
      title={state.errorContext === "download" && state.message ? state.message : undefined}
      onClick={onClick}
    >
      {pillLabel(state)}
    </button>
  );
}
