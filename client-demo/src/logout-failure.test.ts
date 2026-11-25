import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { User, WebStorageStateStore, type UserManager } from "oidc-client-ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserManager } from "./auth";
import type { OidcConfig } from "./config";
import {
  LOGOUT_PENDING_KEY,
  LOGOUT_REFRESH_WAIT_MS,
  LOGOUT_WARNING_KEY,
  VERIFIED_KEY,
  logout,
  refreshSession,
  resetInflightForTests,
  resetRefreshForTests,
  restoreSession,
  type SessionDeps,
} from "./session";

// PR #30 review 6022783087: logout() must never report success while the user or the verified
// marker is still stored. Each case injects a storage / library failure and asserts the FINAL storage
// state plus the outcome handed to the UI.

const config: OidcConfig = {
  authority: "http://localhost:3000",
  clientId: "app04-react-demo",
  redirectUri: "http://localhost:5173/callback",
  postLogoutRedirectUri: "http://localhost:5173/",
  scope: "openid profile email api:read offline_access",
  apiResource: "http://localhost:3000/api",
};
const metadata = {
  issuer: "http://localhost:3000",
  authorization_endpoint: "http://localhost:3000/auth",
  token_endpoint: "http://localhost:3000/token",
  jwks_uri: "http://localhost:3000/jwks",
  revocation_endpoint: "http://localhost:3000/token/revocation",
  end_session_endpoint: "http://localhost:3000/session/end",
  id_token_signing_alg_values_supported: ["RS256"],
};
const USER_KEY = `oidc.user:${config.authority}:${config.clientId}`;
const nowSec = () => Math.floor(Date.now() / 1000);

let signKey: CryptoKey;
let deps: SessionDeps;
beforeAll(async () => {
  const a = await generateKeyPair("RS256", { extractable: true });
  signKey = a.privateKey;
  const jwk: JWK = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  deps = { resolveKeys: async () => ({ keys: createLocalJWKSet({ keys: [jwk] }), algorithms: ["RS256"] }) };
});

const mint = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ sub: "user-1", iss: config.authority, aud: config.clientId, iat: nowSec(), exp: nowSec() + 600, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(signKey);

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Method = "getItem" | "setItem" | "removeItem";
type FaultStorage = Storage & { fail: Partial<Record<Method, (key: string) => boolean>> };

// Storage over the real sessionStorage whose methods throw while their predicate says so.
function faultyStorage(): FaultStorage {
  const real = window.sessionStorage;
  const fail: FaultStorage["fail"] = {};
  const wrap =
    (m: Method) =>
    (key: string, value?: string): unknown => {
      if (fail[m]?.(String(key))) {
        const quota = m === "setItem";
        throw new DOMException(quota ? "quota" : "denied", quota ? "QuotaExceededError" : "SecurityError");
      }
      return m === "setItem" ? real.setItem(key, value as string) : real[m](key);
    };
  return {
    get length() {
      return real.length;
    },
    key: (i: number) => real.key(i),
    clear: () => real.clear(),
    getItem: wrap("getItem"),
    setItem: wrap("setItem"),
    removeItem: wrap("removeItem"),
    fail,
  } as unknown as FaultStorage;
}

function makeUm(store: Storage = window.sessionStorage, extra: Record<string, unknown> = {}): UserManager {
  return createUserManager(config, {
    metadata,
    userStore: new WebStorageStateStore({ store }),
    stateStore: new WebStorageStateStore({ store }),
    ...extra,
  });
}

async function seed(um: UserManager) {
  const idToken = await mint();
  await um.storeUser(
    new User({
      id_token: idToken,
      access_token: "SECRET-AT",
      refresh_token: "SECRET-RT",
      token_type: "Bearer",
      scope: config.scope,
      profile: { sub: "user-1", iss: config.authority, aud: config.clientId, exp: 0, iat: 0 },
      expires_at: nowSec() + 300,
    }),
  );
  window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
}

const ok = () => new Response(null, { status: 200 });
function stubFetch(h: (url: string) => Response | Promise<Response> = ok) {
  const m = vi.fn(async (url: RequestInfo | URL) => h(String(url)));
  vi.stubGlobal("fetch", m);
  return m;
}
const hasUser = () => window.sessionStorage.getItem(USER_KEY) !== null;
const hasMarker = () => window.sessionStorage.getItem(VERIFIED_KEY) !== null;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetRefreshForTests();
  resetInflightForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("logout failure branches (PR #30 review 6022783087)", () => {
  it("marker removeItem throws: clear_failed, marker still present, no redirect, no pending flag", async () => {
    const st = faultyStorage();
    st.fail.removeItem = (k) => k === VERIFIED_KEY;
    const um = makeUm();
    await seed(um);
    stubFetch();
    const redirect = vi.spyOn(um, "signoutRedirect");
    expect(await logout(um, st)).toBe("clear_failed");
    expect(hasMarker()).toBe(true); // honest: the outcome says so
    expect(hasUser()).toBe(false); // the user was still wiped (steps are independent)
    expect(redirect).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it("userManager.removeUser rejects: clear_failed, user still stored, no redirect", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    vi.spyOn(um, "removeUser").mockRejectedValue(new Error("boom"));
    const redirect = vi.spyOn(um, "signoutRedirect");
    expect(await logout(um)).toBe("clear_failed");
    expect(hasUser()).toBe(true);
    expect(hasMarker()).toBe(false); // marker clearing is not skipped by the removeUser failure
    expect(redirect).not.toHaveBeenCalled();
  });

  it("user store removeItem throws SecurityError: clear_failed, user still stored", async () => {
    const ust = faultyStorage();
    const um = makeUm(ust);
    await seed(um);
    stubFetch();
    ust.fail.removeItem = (k) => k === USER_KEY;
    expect(await logout(um)).toBe("clear_failed");
    expect(hasUser()).toBe(true);
    expect(hasMarker()).toBe(false);
  });

  it("user store getItem throws (cannot read back): clear_failed (fail closed)", async () => {
    const ust = faultyStorage();
    const um = makeUm(ust);
    await seed(um);
    stubFetch();
    ust.fail.getItem = (k) => k === USER_KEY;
    expect(await logout(um)).toBe("clear_failed");
  });

  it("marker getItem throws (cannot verify marker gone): clear_failed", async () => {
    const st = faultyStorage();
    const um = makeUm();
    await seed(um);
    stubFetch();
    st.fail.getItem = (k) => k === VERIFIED_KEY;
    expect(await logout(um, st)).toBe("clear_failed");
  });

  it("whole storage denied for logout (every method throws): clear_failed, never throws", async () => {
    const st = faultyStorage();
    const um = makeUm();
    await seed(um);
    stubFetch();
    st.fail.getItem = st.fail.setItem = st.fail.removeItem = () => true;
    vi.spyOn(um, "removeUser").mockRejectedValue(new DOMException("denied", "SecurityError"));
    await expect(logout(um, st)).resolves.toBe("clear_failed");
    expect(hasUser()).toBe(true);
  });

  it("revocation fails AND clear fails: clear_failed, no revoke-failed flag, not logged out", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: 500 }));
    vi.spyOn(um, "removeUser").mockRejectedValue(new Error("boom"));
    expect(await logout(um)).toBe("clear_failed");
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBeNull();
    expect(hasUser()).toBe(true);
  });

  it("clear_failed resets the guard: a refresh can run again", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    const remove = vi.spyOn(um, "removeUser").mockRejectedValueOnce(new Error("boom"));
    expect(await logout(um)).toBe("clear_failed");
    remove.mockRestore();
    await seed(um);
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "NEW-AT",
            refresh_token: "NEW-RT",
            token_type: "Bearer",
            expires_in: 300,
            scope: config.scope,
            id_token: await mint({ jti: "x" }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
  });

  it("localStorage access throwing does not matter: logout does not use it and still redirects", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(um, "signoutRedirect").mockResolvedValue();
    expect(await logout(um)).toBe("redirected");
    spy.mockRestore();
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
  });

  it("QuotaExceeded when writing our flags: flags are best effort, logout still redirects cleared", async () => {
    const st = faultyStorage();
    const um = makeUm();
    await seed(um);
    stubFetch();
    st.fail.setItem = () => true;
    vi.spyOn(um, "signoutRedirect").mockResolvedValue();
    expect(await logout(um, st)).toBe("redirected");
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
  });

  it("signoutRedirect fails after a clean local clear: local_only, nothing stored, no pending flag", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    vi.spyOn(um, "signoutRedirect").mockRejectedValue(new Error("IdP unreachable"));
    expect(await logout(um)).toBe("local_only");
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it("signoutRedirect fails and the re-clear fails (late write): clear_failed, never local_only", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    vi.spyOn(um, "signoutRedirect").mockImplementation(async () => {
      await seed(um); // late write that the second removeUser cannot remove
      vi.spyOn(um, "removeUser").mockRejectedValue(new Error("boom"));
      throw new Error("IdP unreachable");
    });
    expect(await logout(um)).toBe("clear_failed");
    expect(hasUser()).toBe(true);
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it("end_session_endpoint missing from metadata: local_only, state cleared, reload finds no session", async () => {
    const um = makeUm(window.sessionStorage, { metadata: { ...metadata, end_session_endpoint: undefined } });
    await seed(um);
    stubFetch();
    expect(await logout(um)).toBe("local_only");
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(await restoreSession(makeUm(), deps)).toBeNull();
  });

  it("removeItem throws but read-back looks clean: clear_failed (fails closed, no removeUser mock)", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    const st = {
      length: 0,
      key: () => null,
      clear: () => {},
      getItem: () => null, // read-back claims the marker is gone
      setItem: () => {},
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(await logout(um, st)).toBe("clear_failed");
  });
});

// Review of PR #30: a refresh that outlives the bounded logout wait must not resurrect the session
// after logout gave up (local_only / clear_failed reset logoutActive; the epoch still marks it stale).
describe("late refresh after a bounded-wait logout that stays on the page", () => {
  const tokenBody = async () =>
    new Response(
      JSON.stringify({
        access_token: "LATE-AT",
        refresh_token: "LATE-RT",
        token_type: "Bearer",
        expires_in: 300,
        scope: config.scope,
        id_token: await mint({ jti: "late" }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  async function hungRefresh(um: UserManager) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let tokenHit = false;
    stubFetch(async (url) => {
      if (url.endsWith("/token/revocation")) return new Response(null, { status: 200 });
      tokenHit = true;
      await gate;
      return tokenBody();
    });
    const refresh = refreshSession(um, config.apiResource, "user-1", deps);
    await vi.waitFor(() => expect(tokenHit).toBe(true));
    return { refresh, release };
  }

  async function runTimedOutLogout(um: UserManager): Promise<string> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = logout(um);
      await vi.advanceTimersByTimeAsync(LOGOUT_REFRESH_WAIT_MS);
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it("local_only (signoutRedirect rejects): releasing the refresh leaves no user, no marker, result not ok", async () => {
    const um = makeUm();
    await seed(um);
    const { refresh, release } = await hungRefresh(um);
    vi.spyOn(um, "signoutRedirect").mockRejectedValue(new Error("IdP unreachable"));
    expect(await runTimedOutLogout(um)).toBe("local_only");
    release();
    expect((await refresh).ok).toBe(false);
    expect(await um.getUser()).toBeNull();
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
    expect(await restoreSession(makeUm(), deps)).toBeNull(); // a reload finds nothing
  });

  it("local_only (no end_session_endpoint): late refresh cannot bring the session back", async () => {
    const um = makeUm(window.sessionStorage, { metadata: { ...metadata, end_session_endpoint: undefined } });
    await seed(um);
    const { refresh, release } = await hungRefresh(um);
    expect(await runTimedOutLogout(um)).toBe("local_only");
    release();
    expect((await refresh).ok).toBe(false);
    expect(hasUser()).toBe(false);
    expect(hasMarker()).toBe(false);
  });

  it("clear_failed: late refresh result is discarded too (marker never written, not ok)", async () => {
    const um = makeUm();
    await seed(um);
    const { refresh, release } = await hungRefresh(um);
    vi.spyOn(um, "removeUser").mockRejectedValueOnce(new Error("boom")); // logout's clear fails once
    expect(await runTimedOutLogout(um)).toBe("clear_failed");
    release();
    expect((await refresh).ok).toBe(false);
    expect(hasMarker()).toBe(false);
    expect(hasUser()).toBe(false); // doRefresh's own best-effort removeUser worked and wiped it
  });

  it("a refresh started after the failed logout is not affected by the epoch", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch();
    vi.spyOn(um, "signoutRedirect").mockRejectedValue(new Error("IdP unreachable"));
    expect(await logout(um)).toBe("local_only");
    await seed(um); // user logs in again
    stubFetch(tokenBody);
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
    expect(hasMarker()).toBe(true);
  });
});
