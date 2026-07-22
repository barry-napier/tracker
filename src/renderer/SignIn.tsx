import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../server/types.ts";
import { errorMessage } from "./api.ts";
import {
  cancelDevice,
  pollDevice,
  startDeviceFlow,
  type DeviceSession,
} from "./auth.ts";
import { Icon } from "./icons.tsx";

type FlowState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; session: DeviceSession }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/**
 * The device-flow panel (Copilot-style): start → large user code + open
 * GitHub → poll until authorized. Reused by the launch gate (SignIn) and
 * Settings → Connections. The renderer owns the polling cadence; slow_down
 * bumps the interval by 5s per GitHub's contract.
 */
export function DeviceFlowPanel({ onAuthorized }: { onAuthorized: (user: AuthUser) => void }) {
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const begin = async () => {
    setFlow({ kind: "starting" });
    try {
      const session = await startDeviceFlow();
      setFlow({ kind: "waiting", session });
      let interval = session.interval;
      const tick = async () => {
        try {
          const result = await pollDevice(session.sessionId);
          if (result.status === "authorized" && result.user) {
            stopPolling();
            onAuthorized(result.user);
            return;
          }
          if (result.status === "expired") return setFlow({ kind: "expired" });
          if (result.status === "denied") return setFlow({ kind: "denied" });
          if (result.status === "slow_down") interval += 5;
          timerRef.current = window.setTimeout(() => void tick(), interval * 1000);
        } catch (e) {
          setFlow({ kind: "error", message: errorMessage(e) });
        }
      };
      timerRef.current = window.setTimeout(() => void tick(), interval * 1000);
    } catch (e) {
      setFlow({ kind: "error", message: errorMessage(e) });
    }
  };

  const cancel = () => {
    stopPolling();
    if (flow.kind === "waiting") void cancelDevice(flow.session.sessionId).catch(() => {});
    setFlow({ kind: "idle" });
  };

  const copy = (text: string, what: "code" | "link") => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };

  if (flow.kind === "idle" || flow.kind === "starting") {
    return (
      <button
        type="button"
        className="btn btn-primary signin-primary"
        disabled={flow.kind === "starting"}
        onClick={() => void begin()}
      >
        {flow.kind === "starting" ? "Contacting GitHub…" : "Sign in to GitHub"}
      </button>
    );
  }

  if (flow.kind === "expired" || flow.kind === "denied" || flow.kind === "error") {
    return (
      <div className="signin-flow">
        <p className="banner error">
          {flow.kind === "expired" && "The code expired before authorization."}
          {flow.kind === "denied" && "Authorization was denied on GitHub."}
          {flow.kind === "error" && flow.message}
        </p>
        <button type="button" className="btn btn-primary signin-primary" onClick={() => void begin()}>
          Try again
        </button>
      </div>
    );
  }

  const { session } = flow;
  return (
    <div className="signin-flow">
      <h2 className="signin-heading">
        <strong>Authorize the app</strong> using this code.
      </h2>
      <button
        type="button"
        className="signin-code"
        title="Copy to clipboard"
        onClick={() => copy(session.userCode, "code")}
      >
        {session.userCode}
        <Icon name={copied === "code" ? "check" : "copy"} size={14} />
      </button>
      <p className="signin-status dim">Waiting for authorization…</p>
      <div className="signin-actions">
        <button
          type="button"
          className="btn btn-primary signin-primary"
          // Explicit _blank + noopener: a new tab in dev browsers, the system
          // browser in the packaged app (setWindowOpenHandler) — never a
          // same-tab navigation away from the polling screen.
          onClick={() => window.open(session.verificationUri, "_blank", "noopener")}
        >
          Open GitHub.com
        </button>
        <button type="button" className="btn" onClick={() => copy(session.verificationUri, "link")}>
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The full-window launch gate: everything else waits behind sign-in. */
export function SignIn({ onSignedIn }: { onSignedIn: (user: AuthUser) => void }) {
  return (
    <div className="signin-screen">
      <div className="signin-card">
        <h1 className="wordmark">tracker</h1>
        <p className="signin-tagline dim">
          Sign in with GitHub to get started. Your code stays on this machine — GitHub is only
          your identity.
        </p>
        <DeviceFlowPanel onAuthorized={onSignedIn} />
      </div>
    </div>
  );
}
