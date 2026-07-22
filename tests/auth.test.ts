import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { GitHubAuth, PlaintextCipher, type SecretCipher } from "../src/server/auth.ts";
import { EventBus } from "../src/server/bus.ts";
import { migrate } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { api, bootServer, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

function memoryStore(): Store {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return new Store(db, new EventBus());
}

/**
 * A scripted GitHub: device/code always succeeds; each access_token call
 * shifts the next response off the queue; profile endpoints are canned.
 */
function fakeGitHub(tokenResponses: Array<Record<string, unknown>>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/login/device/code")) {
      return json({
        device_code: "dev-123",
        user_code: "2B83-8EC4",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      return json(tokenResponses.shift() ?? { error: "authorization_pending" });
    }
    if (url.endsWith("/user/emails")) {
      return json([{ email: "barry@example.com", primary: true }]);
    }
    if (url.endsWith("/user")) {
      return json({ login: "barry-napier", name: "Barry Napier", email: null, avatar_url: "https://a/x.png" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test("device flow: pending → slow_down → authorized persists the account", async () => {
  const store = memoryStore();
  const auth = new GitHubAuth(
    store,
    new PlaintextCipher(),
    fakeGitHub([
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_secret", scope: "read:user,user:email" },
    ]),
    "client-id",
  );

  const session = await auth.startDeviceFlow();
  expect(session.userCode).toBe("2B83-8EC4");
  expect(session.interval).toBe(5);

  expect((await auth.pollOnce(session.sessionId)).status).toBe("pending");
  expect((await auth.pollOnce(session.sessionId)).status).toBe("slow_down");
  const done = await auth.pollOnce(session.sessionId);
  expect(done.status).toBe("authorized");
  // Primary email came from /user/emails since /user's was null.
  expect(done.user).toEqual({
    login: "barry-napier",
    name: "Barry Napier",
    email: "barry@example.com",
    avatarUrl: "https://a/x.png",
  });

  const account = store.getAuthAccount()!;
  expect(new TextDecoder().decode(account.tokenCiphertext)).toBe("gho_secret");
  expect(account.plaintextFallback).toBe(true); // PlaintextCipher declares itself
  expect(auth.status()).toEqual({ authenticated: true, user: done.user });

  // The session is spent: further polls read as expired, not replayable.
  expect((await auth.pollOnce(session.sessionId)).status).toBe("expired");
});

test("denied and expired sessions terminate cleanly", async () => {
  const store = memoryStore();
  const denied = new GitHubAuth(store, new PlaintextCipher(), fakeGitHub([{ error: "access_denied" }]), "id");
  const s1 = await denied.startDeviceFlow();
  expect((await denied.pollOnce(s1.sessionId)).status).toBe("denied");
  expect(denied.status().authenticated).toBe(false);

  const expired = new GitHubAuth(store, new PlaintextCipher(), fakeGitHub([{ error: "expired_token" }]), "id");
  const s2 = await expired.startDeviceFlow();
  expect((await expired.pollOnce(s2.sessionId)).status).toBe("expired");
  expect((await expired.pollOnce("no-such-session")).status).toBe("expired");
});

test("the cipher seam encrypts what the store holds", async () => {
  const rot13: SecretCipher = {
    available: true,
    encrypt: (s) => new TextEncoder().encode([...s].reverse().join("")),
    decrypt: (b) => [...new TextDecoder().decode(b)].reverse().join(""),
  };
  const store = memoryStore();
  const auth = new GitHubAuth(store, rot13, fakeGitHub([{ access_token: "tok", scope: "" }]), "id");
  const session = await auth.startDeviceFlow();
  await auth.pollOnce(session.sessionId);
  const account = store.getAuthAccount()!;
  expect(new TextDecoder().decode(account.tokenCiphertext)).toBe("kot");
  expect(account.plaintextFallback).toBe(false);
  expect(rot13.decrypt(account.tokenCiphertext)).toBe("tok");
});

test("sign-out deletes the account; status flips back", async () => {
  const store = memoryStore();
  const auth = new GitHubAuth(store, new PlaintextCipher(), fakeGitHub([{ access_token: "t", scope: "" }]), "id");
  const session = await auth.startDeviceFlow();
  await auth.pollOnce(session.sessionId);
  expect(auth.status().authenticated).toBe(true);
  auth.signOut();
  expect(auth.status()).toEqual({ authenticated: false });
  expect(store.getAuthAccount()).toBeNull();
});

test("HTTP surface: status starts unauthenticated, signout is idempotent", async () => {
  const server = await bootServer();
  const status = await api(server, "GET", "/api/auth/status");
  expect(status.status).toBe(200);
  expect(status.json.authenticated).toBe(false);
  expect(status.json.required).toBe(true);

  const poll = await api(server, "POST", "/api/auth/device/poll", {});
  expect(poll.status).toBe(400);

  const signout = await api(server, "POST", "/api/auth/signout", {});
  expect(signout.status).toBe(200);
  expect(signout.json).toEqual({ ok: true });
});
