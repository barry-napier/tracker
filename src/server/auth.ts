import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { AuthUser } from "./types.ts";

/**
 * Encryption seam for the stored GitHub token (ADR-0006). Electron main
 * injects a safeStorage-backed cipher; outside Electron (tests, bare dev
 * server) the plaintext fallback below keeps the flow working and the row
 * records that no OS crypto protected it.
 */
export interface SecretCipher {
  available: boolean;
  encrypt(plaintext: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

export class PlaintextCipher implements SecretCipher {
  available = false;
  encrypt(plaintext: string): Uint8Array {
    return new TextEncoder().encode(plaintext);
  }
  decrypt(ciphertext: Uint8Array): string {
    return new TextDecoder().decode(ciphertext);
  }
}

/** Public OAuth client id (device flow needs no secret); env-overridable. */
export const GITHUB_CLIENT_ID =
  process.env.TRACKER_GITHUB_CLIENT_ID ?? "Ov23liXiOVex0B4mAJPv";

/** Identity only — repo operations stay on the gh CLI (ADR-0006). */
const SCOPES = "read:user user:email";

export type DevicePollStatus =
  | "pending"
  | "slow_down"
  | "authorized"
  | "expired"
  | "denied";

export interface DeviceSession {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface PendingSession {
  deviceCode: string;
  expiresAt: number;
}

/**
 * GitHub OAuth device flow + the single stored account. The renderer drives
 * polling cadence; each pollOnce does exactly one upstream request, so the
 * server holds no timers — only the device_code, in memory, keyed by an
 * opaque session id that is all the renderer ever sees.
 */
export class GitHubAuth {
  private readonly sessions = new Map<string, PendingSession>();

  constructor(
    private readonly store: Store,
    private readonly cipher: SecretCipher,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clientId: string = GITHUB_CLIENT_ID,
  ) {}

  async startDeviceFlow(): Promise<DeviceSession> {
    const response = await this.fetchImpl("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: SCOPES }),
    });
    if (!response.ok) throw new Error(`device code request failed: ${response.status}`);
    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      deviceCode: data.device_code,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    return {
      sessionId,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  async pollOnce(sessionId: string): Promise<{ status: DevicePollStatus; user?: AuthUser }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "expired" };
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return { status: "expired" };
    }
    const response = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        device_code: session.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!response.ok) throw new Error(`token poll failed: ${response.status}`);
    const data = (await response.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (data.access_token !== undefined) {
      const user = await this.fetchProfile(data.access_token);
      this.store.saveAuthAccount({
        user,
        tokenCiphertext: this.cipher.encrypt(data.access_token),
        plaintextFallback: !this.cipher.available,
        scopes: data.scope ?? SCOPES,
      });
      this.sessions.delete(sessionId);
      return { status: "authorized", user };
    }
    switch (data.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down" };
      case "expired_token":
        this.sessions.delete(sessionId);
        return { status: "expired" };
      case "access_denied":
        this.sessions.delete(sessionId);
        return { status: "denied" };
      default:
        throw new Error(`unexpected device-flow error: ${data.error ?? "no error field"}`);
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** From the cached row — never the network, so the gate renders instantly. */
  status(): { authenticated: boolean; user?: AuthUser } {
    const account = this.store.getAuthAccount();
    return account === null
      ? { authenticated: false }
      : { authenticated: true, user: account.user };
  }

  /**
   * Local sign-out only: revoking the grant server-side needs the client
   * secret, which a public device-flow client deliberately has none of.
   */
  signOut(): void {
    this.store.deleteAuthAccount();
  }

  private async fetchProfile(token: string): Promise<AuthUser> {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    };
    const userResponse = await this.fetchImpl("https://api.github.com/user", { headers });
    if (!userResponse.ok) throw new Error(`profile fetch failed: ${userResponse.status}`);
    const profile = (await userResponse.json()) as {
      login: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    };
    // /user.email is null unless the profile email is public; the primary
    // address lives behind /user/emails (granted by user:email). Best-effort:
    // an error here should not fail an otherwise-complete sign-in.
    let email = profile.email;
    if (email === null) {
      try {
        const emailsResponse = await this.fetchImpl("https://api.github.com/user/emails", { headers });
        if (emailsResponse.ok) {
          const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean }>;
          email = emails.find((entry) => entry.primary)?.email ?? emails[0]?.email ?? null;
        }
      } catch {
        // Offline-ish or scope-stripped: profile without email is still a profile.
      }
    }
    return {
      login: profile.login,
      name: profile.name,
      email,
      avatarUrl: profile.avatar_url,
    };
  }
}
