import { createContext, useContext } from "react";
import type { AuthUser } from "../server/types.ts";
import { apiGet, apiPost } from "./api.ts";

export interface AuthStatus {
  authenticated: boolean;
  /** false when TRACKER_NO_AUTH=1 — the gate lets everything through. */
  required: boolean;
  user?: AuthUser;
}

export interface DeviceSession {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollStatus = "pending" | "slow_down" | "authorized" | "expired" | "denied";

export const fetchAuthStatus = () => apiGet<AuthStatus>("/api/auth/status");
export const startDeviceFlow = () => apiPost<DeviceSession>("/api/auth/device/start", {});
export const pollDevice = (sessionId: string) =>
  apiPost<{ status: DevicePollStatus; user?: AuthUser }>("/api/auth/device/poll", { sessionId });
export const cancelDevice = (sessionId: string) =>
  apiPost<{ ok: true }>("/api/auth/device/cancel", { sessionId });
export const signOut = () => apiPost<{ ok: true }>("/api/auth/signout", {});

/** The signed-in profile plus the gate's refresh hook (sign-out flips it). */
export const AuthContext = createContext<{
  user: AuthUser | null;
  refresh: () => Promise<void>;
}>({ user: null, refresh: async () => {} });

export const useAuth = () => useContext(AuthContext);
