import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import { Log, User, type UserManager } from "oidc-client-ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserManager } from "./auth";
import type { OidcConfig } from "./config";
import { loadProfile, resetProfileForTests } from "./profile";
import {
  LOGOUT_PENDING_KEY,
  LOGOUT_WARNING_KEY,
  LOGOUT_REFRESH_WAIT_MS,
  VERIFIED_KEY,
  endLogoutGuard,
  handleCallback,
  login,
  logout,
  processLogoutReturn,
  refreshSession,
  resetInflightForTests,
  resetRefreshForTests,
  restoreSession,
  verifyRefreshedIdToken,
  type SessionDeps,
} from "./session";

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
const PROFILE_URL = "http://localhost:3000/api/protected/profile";
const SECRET_AT = "SECRET-ACCESS-TOKEN-OLD";
const SECRET_RT = "SECRET-REFRESH-TOKEN-OLD";
const nowSec = () => Math.floor(Date.now() / 1000);

let signKey: CryptoKey;
let otherKey: CryptoKey;
let deps: SessionDeps;

beforeAll(async () => {
  const a = await generateKeyPair("RS256", { extractable: true });
  const b = await generateKeyPair("RS256", { extractable: true });
  signKey = a.privateKey;
  otherKey = b.privateKey;
  const jwk: JWK = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  deps = { resolveKeys: async () => ({ keys, algorithms: ["RS256"] }) };
});

function mint(
  claims: JWTPayload = {},
  o: { key?: CryptoKey; nonce?: string } = {},
): Promise<string> {
  return new SignJWT({
    sub: "user-1",
    iss: config.authority,
    aud: config.clientId,
    iat: nowSec(),
    exp: nowSec() + 600,
    ...(o.nonce === undefined ? {} : { nonce: o.nonce }),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(o.key ?? signKey);
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeUm(): UserManager {
  return createUserManager(config, { metadata });
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(String(url), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function bodyOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body));
}

const callsTo = (m: ReturnType<typeof stubFetch>, suffix: string) =>
  m.mock.calls.filter(([u]) => String(u).endsWith(suffix));

interface SeedOpts {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number;
  marker?: boolean;
}

async function seed(um: UserManager, o: SeedOpts = {}) {
  const idToken = o.idToken ?? (await mint());
  await um.storeUser(
    new User({
      id_token: idToken,
      access_token: o.accessToken ?? SECRET_AT,
      ...(o.refreshToken === null ? {} : { refresh_token: o.refreshToken ?? SECRET_RT }),
      token_type: "Bearer",
      scope: config.scope,
      profile: { sub: "user-1", iss: config.authority, aud: config.clientId, exp: 0, iat: 0 },
      expires_at: o.expiresAt ?? nowSec() + 300,
    }),
  );
  if (o.marker !== false) window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
  return idToken;
}

function refreshResponse(over: Record<string, unknown> = {}) {
  return jsonRes({
    access_token: "NEW-ACCESS-TOKEN",
    refresh_token: "NEW-REFRESH-TOKEN",
    token_type: "Bearer",
    expires_in: 300,
    scope: config.scope,
    ...over,
  });
}

const session = { sub: "user-1" };

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetRefreshForTests();
  resetProfileForTests();
  resetInflightForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Log.reset();
});

function captureNavigation() {
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  } as unknown as Location);
  return assign;
}

// signoutRedirect's promise never settles once the browser navigates away: wait for the navigation.
async function runLogout(um: UserManager, assign: ReturnType<typeof vi.fn>) {
  void logout(um);
  await vi.waitFor(() => expect(assign).toHaveBeenCalled());
}

describe("C3 login request", () => {
  it("authorize URL has resource, prompt=consent, api:read + offline_access, S256", async () => {
    const um = makeUm();
    const assign = captureNavigation();
    void login(um, config.apiResource);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    const p = new URL(assign.mock.calls[0][0] as string).searchParams;
    expect(p.get("resource")).toBe("http://localhost:3000/api");
    expect(p.get("prompt")).toBe("consent");
    const scopes = p.get("scope")!.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["openid", "api:read", "offline_access"]));
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("nonce")).toBeTruthy();
  });

  it("clears stale logout flags before redirecting to the Provider", async () => {
    window.sessionStorage.setItem(LOGOUT_PENDING_KEY, "1");
    window.sessionStorage.setItem(LOGOUT_WARNING_KEY, "1");
    const assign = captureNavigation();
    void login(makeUm(), config.apiResource);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBeNull();
  });

  it("the code exchange body carries resource and the PKCE verifier", async () => {
    const um = makeUm();
    const assign = captureNavigation();
    void login(um, config.apiResource);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    const params = new URL(assign.mock.calls[0][0] as string).searchParams;
    const fetchMock = stubFetch(async () =>
      jsonRes({
        access_token: SECRET_AT,
        refresh_token: SECRET_RT,
        token_type: "Bearer",
        id_token: await mint({}, { nonce: params.get("nonce")! }),
        expires_in: 300,
        scope: config.scope,
      }),
    );
    const r = await handleCallback(
      um,
      `${config.redirectUri}?code=abc&state=${params.get("state")}`,
      deps,
    );
    expect(r.ok).toBe(true);
    const body = bodyOf(fetchMock.mock.calls[0][1]);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("resource")).toBe("http://localhost:3000/api");
    expect(body.get("code_verifier")).toBeTruthy();
  });
});

describe("C4 refreshSession", () => {
  it("re-verifies the new ID Token (no nonce), rotates tokens and updates the marker", async () => {
    const um = makeUm();
    const oldId = await seed(um);
    const newId = await mint({ jti: "second" }); // refresh ID Token: no nonce
    const fetchMock = stubFetch(() => refreshResponse({ id_token: newId }));
    const r = await refreshSession(um, config.apiResource, "user-1", deps);
    expect(r).toEqual({ ok: true, accessToken: "NEW-ACCESS-TOKEN" });
    const body = bodyOf(fetchMock.mock.calls[0][1]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(SECRET_RT);
    expect(body.get("resource")).toBe("http://localhost:3000/api");
    const stored = await um.getUser();
    expect(stored?.refresh_token).toBe("NEW-REFRESH-TOKEN"); // rotation replaced the old one
    expect(stored?.id_token).toBe(newId);
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBe(await sha256Hex(newId));
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).not.toBe(await sha256Hex(oldId));
    // a reload restores the refreshed session through the normal M2 path
    expect(await restoreSession(um, deps)).toEqual({ sub: "user-1" });
  });

  it("a response without id_token keeps the verified marker consistent", async () => {
    const um = makeUm();
    const id = await seed(um);
    stubFetch(() => refreshResponse());
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBe(await sha256Hex(id));
    expect(await restoreSession(um, deps)).toEqual({ sub: "user-1" });
  });

  const bad: Array<[string, () => Promise<string>]> = [
    ["wrong signature", () => mint({}, { key: otherKey })],
    ["wrong audience", () => mint({ aud: "someone-else" })],
    ["wrong issuer", () => mint({ iss: "http://evil.example" })],
    ["expired", () => mint({ exp: nowSec() - 3600, iat: nowSec() - 7200 })],
    ["different sub", () => mint({ sub: "user-2" })],
  ];
  for (const [name, make] of bad) {
    it(`rejects a refreshed ID Token (${name}) and clears the session`, async () => {
      const um = makeUm();
      await seed(um);
      stubFetch(async () => refreshResponse({ id_token: await make() }));
      const r = await refreshSession(um, config.apiResource, "user-1", deps);
      expect(r.ok).toBe(false);
      expect(await um.getUser()).toBeNull();
      expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    });
  }

  it("a refreshed ID Token with a nonce that differs from the original is rejected", async () => {
    const um = makeUm();
    await seed(um, { idToken: await mint({}, { nonce: "original-nonce" }) });
    stubFetch(async () =>
      refreshResponse({ id_token: await mint({ jti: "r" }, { nonce: "other-nonce" }) }),
    );
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(false);
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("a refreshed ID Token repeating the original nonce is accepted", async () => {
    const um = makeUm();
    await seed(um, { idToken: await mint({}, { nonce: "original-nonce" }) });
    stubFetch(async () =>
      refreshResponse({ id_token: await mint({ jti: "r" }, { nonce: "original-nonce" }) }),
    );
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
  });

  describe("verifyRefreshedIdToken (our own checks, library bypassed)", () => {
    it("rejects a different sub", async () => {
      const um = makeUm();
      const original = await mint({}, { nonce: "n1" });
      await expect(
        verifyRefreshedIdToken(um, await mint({ sub: "user-2" }), "user-1", original, deps),
      ).rejects.toMatchObject({ category: "token_invalid" });
    });

    it("accepts the same sub with no nonce claim", async () => {
      const um = makeUm();
      await expect(
        verifyRefreshedIdToken(um, await mint({ jti: "x" }), "user-1", await mint({}, { nonce: "n1" }), deps),
      ).resolves.toBeUndefined();
    });

    it("accepts a nonce equal to the original", async () => {
      const um = makeUm();
      await expect(
        verifyRefreshedIdToken(
          um,
          await mint({ jti: "x" }, { nonce: "n1" }),
          "user-1",
          await mint({}, { nonce: "n1" }),
          deps,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects a nonce that differs from the original", async () => {
      const um = makeUm();
      await expect(
        verifyRefreshedIdToken(
          um,
          await mint({}, { nonce: "n2" }),
          "user-1",
          await mint({}, { nonce: "n1" }),
          deps,
        ),
      ).rejects.toMatchObject({ category: "nonce_mismatch" });
    });

    it("rejects a nonce when the original ID Token had none", async () => {
      const um = makeUm();
      await expect(
        verifyRefreshedIdToken(um, await mint({}, { nonce: "n2" }), "user-1", await mint(), deps),
      ).rejects.toMatchObject({ category: "nonce_mismatch" });
    });
  });

  it("invalid_grant clears user and marker", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => jsonRes({ error: "invalid_grant", error_description: "SECRET-TEXT" }, 400));
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(false);
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("a network failure during refresh clears the session", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(false);
    expect(await um.getUser()).toBeNull();
  });

  it("no refresh token -> session cleared, no request", async () => {
    const um = makeUm();
    await seed(um, { refreshToken: null });
    const fetchMock = stubFetch(() => refreshResponse());
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await um.getUser()).toBeNull();
  });

  it("is single-flight: concurrent callers share one refresh request", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(async () => refreshResponse({ id_token: await mint() }));
    const results = await Promise.all([
      refreshSession(um, config.apiResource, "user-1", deps, SECRET_AT),
      refreshSession(um, config.apiResource, "user-1", deps, SECRET_AT),
      refreshSession(um, config.apiResource, "user-1", deps, SECRET_AT),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("reuses a token another caller already refreshed instead of rotating again", async () => {
    const um = makeUm();
    await seed(um, { accessToken: "ALREADY-REFRESHED" });
    const fetchMock = stubFetch(() => refreshResponse());
    const r = await refreshSession(um, config.apiResource, "user-1", deps, SECRET_AT);
    expect(r).toEqual({ ok: true, accessToken: "ALREADY-REFRESHED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("C3 loadProfile", () => {
  it("200: Bearer header only, no token in the URL, sub matches", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(() => jsonRes({ sub: "user-1" }));
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "ok",
      sub: "user-1",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(PROFILE_URL);
    expect(new URL(String(url)).search).toBe("");
    expect(String(url)).not.toContain(SECRET_AT);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET_AT}`);
    expect(init?.credentials).toBe("omit");
  });

  it("rejects a sub that differs from the verified ID Token sub", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => jsonRes({ sub: "user-2" }));
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({ status: "error" });
  });

  const badBodies: Array<[string, unknown]> = [
    ["extra field", { sub: "user-1", email: "x@y.z" }],
    ["missing sub", {}],
    ["non-string sub", { sub: 1 }],
    ["empty sub", { sub: "" }],
    ["array", ["user-1"]],
    ["null", null],
  ];
  for (const [name, body] of badBodies) {
    it(`rejects a 200 body with ${name}`, async () => {
      const um = makeUm();
      await seed(um);
      stubFetch(() => jsonRes(body));
      expect((await loadProfile(um, config.apiResource, session, deps)).status).toBe("error");
    });
  }

  it("rejects a 200 that is not JSON", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response("<html>SECRET-SERVER-TEXT</html>", { status: 200 }));
    expect((await loadProfile(um, config.apiResource, session, deps)).status).toBe("error");
  });

  it("401 -> one refresh -> retry succeeds with the new token", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(async (url, init) => {
      if (url.endsWith("/token")) return refreshResponse({ id_token: await mint() });
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer NEW-ACCESS-TOKEN"
        ? jsonRes({ sub: "user-1" })
        : jsonRes({ error: "invalid_token" }, 401);
    });
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "ok",
      sub: "user-1",
    });
    expect(callsTo(fetchMock, "/token")).toHaveLength(1);
    expect(callsTo(fetchMock, "/protected/profile")).toHaveLength(2);
    expect((await um.getUser())?.refresh_token).toBe("NEW-REFRESH-TOKEN");
  });

  it("401 -> refresh invalid_grant -> expired, everything cleared", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch((url) =>
      url.endsWith("/token")
        ? jsonRes({ error: "invalid_grant" }, 400)
        : jsonRes({ error: "invalid_token" }, 401),
    );
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "expired",
    });
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("401 again after the refresh -> expired, exactly one refresh", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(async (url) =>
      url.endsWith("/token")
        ? refreshResponse({ id_token: await mint() })
        : jsonRes({ error: "invalid_token" }, 401),
    );
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "expired",
    });
    expect(callsTo(fetchMock, "/token")).toHaveLength(1);
    expect(callsTo(fetchMock, "/protected/profile")).toHaveLength(2);
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("an already expired Access Token is refreshed before the first API call", async () => {
    const um = makeUm();
    await seed(um, { expiresAt: nowSec() - 10 });
    const fetchMock = stubFetch(async (url, init) => {
      if (url.endsWith("/token")) return refreshResponse({ id_token: await mint() });
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer NEW-ACCESS-TOKEN",
      );
      return jsonRes({ sub: "user-1" });
    });
    expect((await loadProfile(um, config.apiResource, session, deps)).status).toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toBe(metadata.token_endpoint);
    expect(callsTo(fetchMock, "/protected/profile")).toHaveLength(1);
  });

  it("403: forbidden, no data, no refresh, session kept", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(() => jsonRes({ error: "insufficient_scope" }, 403));
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "forbidden",
    });
    expect(callsTo(fetchMock, "/token")).toHaveLength(0);
    expect(await um.getUser()).not.toBeNull();
  });

  it("500 and a CORS rejection (fetch rejects with TypeError) are generic error outcomes", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => jsonRes({ error: "server_error" }, 500));
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({ status: "error" });
    resetProfileForTests();
    // a browser never exposes the API's 403 origin_not_allowed: the CORS failure surfaces as a
    // network-level TypeError, not as a response
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({ status: "error" });
    expect(await um.getUser()).not.toBeNull();
  });

  it("network error: generic error, session kept", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({ status: "error" });
    expect(await um.getUser()).not.toBeNull();
  });

  it("no stored user -> expired", async () => {
    const um = makeUm();
    const fetchMock = stubFetch(() => jsonRes({ sub: "user-1" }));
    expect(await loadProfile(um, config.apiResource, session, deps)).toEqual({
      status: "expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("concurrent loads (StrictMode) share one API call", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(() => jsonRes({ sub: "user-1" }));
    const [a, b] = await Promise.all([
      loadProfile(um, config.apiResource, session, deps),
      loadProfile(um, config.apiResource, session, deps),
    ]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("concurrent loads for different users are not merged", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(() => jsonRes({ sub: "user-1" }));
    const [a, b] = await Promise.all([
      loadProfile(um, config.apiResource, { sub: "user-1" }, deps),
      loadProfile(um, config.apiResource, { sub: "user-2" }, deps),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ status: "ok", sub: "user-1" });
    expect(b).toEqual({ status: "error" }); // user-2's load is judged against user-2's sub
  });

  it("concurrent 401s trigger a single refresh", async () => {
    const um = makeUm();
    await seed(um);
    const fetchMock = stubFetch(async (url, init) => {
      if (url.endsWith("/token")) return refreshResponse({ id_token: await mint() });
      return (init?.headers as Record<string, string>).Authorization === "Bearer NEW-ACCESS-TOKEN"
        ? jsonRes({ sub: "user-1" })
        : jsonRes({ error: "invalid_token" }, 401);
    });
    resetProfileForTests();
    // bypass loadProfile's own dedupe: two independent loads racing on the shared refresh
    const first = loadProfile(um, config.apiResource, session, deps);
    resetProfileForTests();
    const second = loadProfile(um, config.apiResource, session, deps);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(callsTo(fetchMock, "/token")).toHaveLength(1);
  });
});

describe("C5 logout", () => {
  it("revokes the refresh token first, clears state, then redirects with id_token_hint", async () => {
    const um = makeUm();
    const idToken = await seed(um);
    const order: string[] = [];
    let revokeBody: URLSearchParams | undefined;
    let stateAtNavigation: Array<string | null> = [];
    const userKey = `oidc.user:${config.authority}:${config.clientId}`;
    stubFetch(async (url, init) => {
      if (url.endsWith("/token/revocation")) {
        order.push("revoke");
        revokeBody = bodyOf(init);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const assign = vi.fn((url: string) => {
      order.push("navigate");
      // snapshot: at the moment of navigation the client state must already be gone
      stateAtNavigation = [
        window.sessionStorage.getItem(userKey),
        window.sessionStorage.getItem(VERIFIED_KEY),
      ];
      void url;
    });
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);

    void logout(um);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(order).toEqual(["revoke", "navigate"]);
    expect(revokeBody?.get("token")).toBe(SECRET_RT);
    expect(revokeBody?.get("token_type_hint")).toBe("refresh_token");
    expect(stateAtNavigation).toEqual([null, null]);
    const u = new URL(assign.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe(metadata.end_session_endpoint);
    expect(u.searchParams.get("id_token_hint")).toBe(idToken);
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe(config.postLogoutRedirectUri);
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe("1");
  });

  it("revocation failure still logs out and records a non-sensitive warning flag", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => jsonRes({ error: "server_error" }, 500));
    const assign = captureNavigation();
    await runLogout(um, assign);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBe("1");
    const dump = JSON.stringify({ ...window.sessionStorage });
    expect(dump).not.toContain(SECRET_RT);
    expect(dump).not.toContain(SECRET_AT);
  });

  it("revocation network error is handled the same way", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const assign = captureNavigation();
    await runLogout(um, assign);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBe("1");
  });

  it("without a refresh token the access token is revoked instead", async () => {
    const um = makeUm();
    await seed(um, { refreshToken: null });
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    await runLogout(um, captureNavigation());
    expect(bodyOf(fetchMock.mock.calls[0][1]).get("token_type_hint")).toBe("access_token");
  });

  it("no end_session_endpoint: local logout only, no pending flag", async () => {
    const um = createUserManager(config, {
      metadata: { ...metadata, end_session_endpoint: undefined },
    });
    await seed(um);
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await logout(um)).toBe("local_only");
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it("waits for an in-flight refresh and revokes the rotated refresh token", async () => {
    const um = makeUm();
    await seed(um);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    let revokeBody: URLSearchParams | undefined;
    stubFetch(async (url, init) => {
      if (url.endsWith("/token/revocation")) {
        order.push("revoke");
        revokeBody = bodyOf(init);
        return new Response(null, { status: 200 });
      }
      order.push("token");
      await gate;
      return refreshResponse({ id_token: await mint({ jti: "r" }) });
    });
    const assign = captureNavigation();
    const refresh = refreshSession(um, config.apiResource, "user-1", deps);
    await vi.waitFor(() => expect(order).toEqual(["token"]));
    void logout(um);
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["token"]); // logout is still waiting for the refresh
    release();
    expect((await refresh).ok).toBe(true);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(order).toEqual(["token", "revoke"]);
    expect(revokeBody?.get("token")).toBe("NEW-REFRESH-TOKEN"); // the rotated token, not the stale one
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("a refresh requested after logout started is refused and writes nothing", async () => {
    const um = makeUm();
    await seed(um);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let revokeSeen = false;
    const fetchMock = stubFetch(async (url) => {
      if (url.endsWith("/token/revocation")) {
        revokeSeen = true;
        await gate;
        return new Response(null, { status: 200 });
      }
      return refreshResponse({ id_token: await mint({ jti: "late" }) });
    });
    const assign = captureNavigation();
    void logout(um);
    await vi.waitFor(() => expect(revokeSeen).toBe(true));
    expect(await refreshSession(um, config.apiResource, "user-1", deps, SECRET_AT)).toEqual({
      ok: false,
    });
    expect(callsTo(fetchMock, "/token")).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("local_only: clears again after a failed signoutRedirect and re-enables refresh", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: 200 }));
    vi.spyOn(um, "signoutRedirect").mockImplementation(async () => {
      await seed(um); // a late write that landed while the redirect was being attempted
      throw new Error("no end_session_endpoint");
    });
    expect(await logout(um)).toBe("local_only");
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    expect(await restoreSession(um, deps)).toBeNull(); // a reload does not bring the session back
    await seed(um);
    stubFetch(async () => refreshResponse({ id_token: await mint({ jti: "again" }) }));
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
  });

  it("after logout a reload finds no session", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: 200 }));
    await runLogout(um, captureNavigation());
    expect(await restoreSession(makeUm(), deps)).toBeNull();
  });
});

describe("C5 post-logout return", () => {
  async function loggedOut(revokeStatus: number) {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: revokeStatus }));
    const assign = captureNavigation();
    await runLogout(um, assign);
    const state = new URL(assign.mock.calls[0][0] as string).searchParams.get("state")!;
    vi.restoreAllMocks();
    return { um: makeUm(), state }; // fresh UserManager = fresh page load
  }

  it("Provider echoes state: signout callback processed, URL scrubbed, flags consumed", async () => {
    const { um, state } = await loggedOut(200);
    window.history.pushState(null, "", `/?state=${state}`);
    const r = await processLogoutReturn(um, window.location.href);
    expect(r).toEqual({ returned: true, revokeFailed: false });
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(await um.settings.stateStore.get(state)).toBeNull(); // library state consumed
  });

  it("Provider does not echo state: still recognised via our flag", async () => {
    const { um } = await loggedOut(200);
    window.history.pushState(null, "", "/");
    expect(await processLogoutReturn(um, window.location.href)).toEqual({
      returned: true,
      revokeFailed: false,
    });
  });

  it("unknown state is ignored without throwing", async () => {
    const { um } = await loggedOut(200);
    const r = await processLogoutReturn(um, `${config.postLogoutRedirectUri}?state=forged`);
    expect(r.returned).toBe(true);
  });

  it("carries the revocation-failed warning once", async () => {
    const { um } = await loggedOut(500);
    expect((await processLogoutReturn(um, config.postLogoutRedirectUri)).revokeFailed).toBe(true);
    expect(await processLogoutReturn(um, config.postLogoutRedirectUri)).toEqual({
      returned: false,
      revokeFailed: false,
    });
  });

  it("a plain visit (no pending logout) is not a logout return", async () => {
    const um = makeUm();
    expect(await processLogoutReturn(um, `${config.postLogoutRedirectUri}?state=x`)).toEqual({
      returned: false,
      revokeFailed: false,
    });
  });
});

describe("storage", () => {
  it("localStorage stays empty through login, refresh, API call and logout", async () => {
    const um = makeUm();
    const assign = captureNavigation();
    void login(um, config.apiResource);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    const params = new URL(assign.mock.calls[0][0] as string).searchParams;
    vi.restoreAllMocks();
    stubFetch(async (url) => {
      if (url.endsWith("/protected/profile")) return jsonRes({ sub: "user-1" });
      if (url.endsWith("/token/revocation")) return new Response(null, { status: 200 });
      return jsonRes({
        access_token: SECRET_AT,
        refresh_token: SECRET_RT,
        token_type: "Bearer",
        id_token: await mint({}, { nonce: params.get("nonce")! }),
        expires_in: 300,
        scope: config.scope,
      });
    });
    const cb = await handleCallback(
      um,
      `${config.redirectUri}?code=c&state=${params.get("state")}`,
      deps,
    );
    expect(cb.ok).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
    expect((await loadProfile(um, config.apiResource, session, deps)).status).toBe("ok");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBeGreaterThan(0); // tokens live here
    await runLogout(um, captureNavigation());
    expect(window.localStorage.length).toBe(0);
  });
});

describe("C5 logout hardening", () => {
  it("endLogoutGuard: a page restored after a redirected logout can refresh again", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: 200 }));
    await runLogout(um, captureNavigation()); // "redirected": the guard stays set
    await seed(um); // the user logged in on another page meanwhile
    expect(await refreshSession(um, config.apiResource, "user-1", deps)).toEqual({ ok: false });
    endLogoutGuard(); // what the bfcache restore handler does
    stubFetch(async () => refreshResponse({ id_token: await mint({ jti: "restored" }) }));
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
    expect(await um.getUser()).not.toBeNull();
  });

  it("a hung refresh delays logout by at most the bounded wait; the late result writes nothing", async () => {
    const um = makeUm();
    await seed(um);
    const idToken = await mint({ jti: "late" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    stubFetch(async (url) => {
      if (url.endsWith("/token/revocation")) {
        order.push("revoke");
        return new Response(null, { status: 200 });
      }
      order.push("token");
      await gate;
      return refreshResponse({ id_token: idToken });
    });
    const assign = captureNavigation();
    const refresh = refreshSession(um, config.apiResource, "user-1", deps);
    await vi.waitFor(() => expect(order).toEqual(["token"]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      void logout(um);
      await vi.advanceTimersByTimeAsync(LOGOUT_REFRESH_WAIT_MS - 1);
      expect(order).toEqual(["token"]); // still waiting
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(order).toEqual(["token", "revoke"]); // logout went on without the refresh
    expect(await um.getUser()).toBeNull();
    release(); // the token endpoint finally answers
    expect(await refresh).toEqual({ ok: false });
    expect(await um.getUser()).toBeNull(); // the library stored the new user; doRefresh removed it
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("a logout that cannot clear resets the guard so refresh works again", async () => {
    const um = makeUm();
    await seed(um);
    stubFetch(() => new Response(null, { status: 200 }));
    const broken = {
      length: 0,
      key: () => null,
      clear: () => {},
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("storage denied");
      },
    } as unknown as Storage;
    // removeUser succeeds and the read-back looks clean: only the failed removeItem makes this fail closed
    expect(await logout(um, broken)).toBe("clear_failed"); // reported, never thrown, never a success
    await seed(um);
    stubFetch(async () => refreshResponse({ id_token: await mint({ jti: "after-throw" }) }));
    expect((await refreshSession(um, config.apiResource, "user-1", deps)).ok).toBe(true);
  });
});
