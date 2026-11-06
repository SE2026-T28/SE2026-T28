import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  type CryptoKey,
} from "jose";
import { ErrorResponse, Log, User, type UserManager } from "oidc-client-ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserManager } from "./auth";
import type { OidcConfig } from "./config";
import {
  ERROR_MESSAGES,
  VERIFIED_KEY,
  handleCallback,
  handleCallbackOnce,
  login,
  logout,
  restoreSession,
  type SessionDeps,
} from "./session";
import { resolveRemoteKeys, verifyIdToken } from "./verify";

const config: OidcConfig = {
  authority: "http://localhost:3000",
  clientId: "app04-react-demo",
  redirectUri: "http://localhost:5173/callback",
  postLogoutRedirectUri: "http://localhost:5173/",
  scope: "openid profile email",
};

const metadata = {
  issuer: "http://localhost:3000",
  authorization_endpoint: "http://localhost:3000/auth",
  token_endpoint: "http://localhost:3000/token",
  jwks_uri: "http://localhost:3000/jwks",
  id_token_signing_alg_values_supported: ["RS256"],
};

const CODE = "SECRET-AUTH-CODE-123";
const NOW = new Date("2026-11-05T10:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

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
  deps = {
    resolveKeys: async () => ({ keys, algorithms: ["RS256"] }),
    now: NOW,
  };
});

interface MintOpts {
  claims?: JWTPayload;
  key?: CryptoKey;
  alg?: string;
  omit?: string[];
}

async function mint(nonce: string | undefined, o: MintOpts = {}): Promise<string> {
  const claims: JWTPayload = {
    sub: "user-1",
    iss: config.authority,
    aud: config.clientId,
    iat: nowSec,
    exp: nowSec + 600,
    ...(nonce === undefined ? {} : { nonce }),
    ...o.claims,
  };
  for (const k of o.omit ?? []) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "k1" })
    .sign(o.key ?? signKey);
}

function makeUm(): UserManager {
  return createUserManager(config, { metadata });
}

// Real login request through oidc-client-ts: returns the authorize URL params.
async function startLogin(um: UserManager) {
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  } as unknown as Location);
  void login(um);
  await vi.waitFor(() => expect(assign).toHaveBeenCalled());
  return new URL(assign.mock.calls[0][0] as string);
}

function stubTokenEndpoint(idToken: string | (() => Promise<string>)) {
  const fetchMock = vi.fn(async () => {
    const id_token = typeof idToken === "string" ? idToken : await idToken();
    return new Response(
      JSON.stringify({
        access_token: "SECRET-ACCESS-TOKEN",
        token_type: "Bearer",
        id_token,
        expires_in: 3600,
        scope: "openid",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callbackUrl(state: string, extra = `code=${CODE}`) {
  return `${config.redirectUri}?${extra}&state=${state}`;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Log.reset();
});

function expectNoLeak(...values: unknown[]) {
  const text = JSON.stringify(values);
  expect(text).not.toContain(CODE);
  expect(text).not.toContain("SECRET-ACCESS-TOKEN");
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT text
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function storedNonce(um: UserManager, state: string) {
  return JSON.parse((await um.settings.stateStore.get(state))!).nonce as string;
}

describe("login", () => {
  it("passes a fresh random nonce, keeps PKCE S256 and state", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      window.sessionStorage.clear();
      const um = makeUm();
      const url = await startLogin(um);
      const p = url.searchParams;
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("code_challenge")).toBeTruthy();
      expect(p.get("state")).toBeTruthy();
      const nonce = p.get("nonce")!;
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits base64url
      expect(await storedNonce(um, p.get("state")!)).toBe(nonce); // bound to this state
      seen.push(nonce);
      vi.restoreAllMocks();
    }
    expect(new Set(seen).size).toBe(3);
  });
});

describe("handleCallback success and token checks", () => {
  async function run(mintOpts: MintOpts = {}, nonceOverride?: string | null) {
    const um = makeUm();
    const url = await startLogin(um);
    const nonce = url.searchParams.get("nonce")!;
    const state = url.searchParams.get("state")!;
    const tokenNonce = nonceOverride === null ? undefined : (nonceOverride ?? nonce);
    stubTokenEndpoint(await mint(tokenNonce, mintOpts));
    const result = await handleCallback(um, callbackUrl(state), deps);
    return { um, result, state };
  }

  it("accepts a valid token and exposes sub", async () => {
    const { um, result, state } = await run();
    expect(result).toEqual({ ok: true, session: { sub: "user-1" } });
    expect(await um.getUser()).not.toBeNull();
    expect(await um.settings.stateStore.get(state)).toBeNull(); // state single-use
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBe(
      await sha256Hex((await um.getUser())!.id_token!),
    );
    expectNoLeak(result);
  });

  it("exposes email only when present in the verified token", async () => {
    const { result } = await run({ claims: { email: "a@b.test" } });
    expect(result).toEqual({
      ok: true,
      session: { sub: "user-1", email: "a@b.test" },
    });
  });

  const bad: [string, MintOpts, string][] = [
    ["signed by another key", { key: undefined }, "token_invalid"],
    ["wrong issuer", { claims: { iss: "http://evil.test" } }, "token_invalid"],
    ["wrong audience", { claims: { aud: "other-client" } }, "token_invalid"],
    ["expired", { claims: { exp: nowSec - 3600 } }, "token_invalid"],
    ["missing sub", { omit: ["sub"] }, "token_invalid"],
    ["missing exp", { omit: ["exp"] }, "token_invalid"],
    ["iat in the future", { claims: { iat: nowSec + 3600 } }, "token_invalid"],
  ];
  for (const [name, opts, error] of bad) {
    it(`rejects token: ${name} and removes the stored user`, async () => {
      const o =
        name === "signed by another key" ? { key: otherKey } : opts;
      const { um, result } = await run(o);
      expect(result).toMatchObject({ ok: false, error });
      expect(await um.getUser()).toBeNull();
      expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
      expectNoLeak(result);
    });
  }

  it("rejects HS256 token", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const nonce = url.searchParams.get("nonce")!;
    const hs = await new SignJWT({
      sub: "user-1",
      iss: config.authority,
      aud: config.clientId,
      iat: nowSec,
      exp: nowSec + 600,
      nonce,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
    stubTokenEndpoint(hs);
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(result).toMatchObject({ ok: false, error: "token_invalid" });
    expect(await um.getUser()).toBeNull();
  });

  it("rejects alg none token", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    const none = `${b64({ alg: "none" })}.${b64({
      sub: "user-1",
      iss: config.authority,
      aud: config.clientId,
      iat: nowSec,
      exp: nowSec + 600,
      nonce: url.searchParams.get("nonce"),
    })}.`;
    stubTokenEndpoint(none);
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(result).toMatchObject({ ok: false, error: "token_invalid" });
    expect(await um.getUser()).toBeNull();
  });

  it("rejects wrong nonce (library check)", async () => {
    const { um, result } = await run({}, "attacker-nonce");
    expect(result).toMatchObject({ ok: false, error: "nonce_mismatch" });
    expect(await um.getUser()).toBeNull();
  });

  it("rejects missing nonce claim", async () => {
    const { um, result } = await run({}, null);
    expect(result).toMatchObject({ ok: false, error: "nonce_mismatch" });
    expect(await um.getUser()).toBeNull();
  });

  it("fails closed before the code exchange when the library state has no nonce", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const fetchMock = stubTokenEndpoint(await mint("whatever"));
    const state = url.searchParams.get("state")!;
    const stored = JSON.parse((await um.settings.stateStore.get(state))!);
    delete stored.nonce;
    await um.settings.stateStore.set(state, JSON.stringify(stored));
    const result = await handleCallback(um, callbackUrl(state), deps);
    expect(result).toMatchObject({ ok: false, error: "nonce_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await um.settings.stateStore.get(state)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("a second login does not break the first (nonce bound to state)", async () => {
    const um = makeUm();
    const first = await startLogin(um);
    vi.restoreAllMocks();
    const second = await startLogin(um);
    expect(second.searchParams.get("nonce")).not.toBe(first.searchParams.get("nonce"));
    stubTokenEndpoint(await mint(first.searchParams.get("nonce")!));
    const result = await handleCallback(um, callbackUrl(first.searchParams.get("state")!), deps);
    expect(result).toEqual({ ok: true, session: { sub: "user-1" } });
  });

  // The library compares nonce only when its stored copy is set; stub it away to test OUR check alone.
  describe("own nonce check in isolation", () => {
    async function runIsolated(tokenNonce: string | undefined) {
      const um = makeUm();
      const url = await startLogin(um);
      const idToken = await mint(tokenNonce);
      vi.spyOn(um, "signinRedirectCallback").mockResolvedValue(
        new User({
          id_token: idToken,
          access_token: "SECRET-ACCESS-TOKEN",
          token_type: "Bearer",
          profile: { sub: "user-1", iss: "x", aud: "x", exp: 0, iat: 0 },
          expires_at: nowSec + 3600,
        }),
      );
      const state = url.searchParams.get("state")!;
      return { um, result: await handleCallback(um, callbackUrl(state), deps) };
    }

    for (const [name, nonce] of [
      ["missing", undefined],
      ["empty", ""],
      ["wrong", "attacker-nonce"],
    ] as const) {
      it(`rejects token nonce: ${name}`, async () => {
        const { um, result } = await runIsolated(nonce);
        expect(result).toMatchObject({ ok: false, error: "nonce_mismatch" });
        expect(await um.getUser()).toBeNull();
        expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
      });
    }
  });

  it("maps IdP ErrorResponse to exchange_failed without inspecting its text", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    vi.spyOn(um, "signinRedirectCallback").mockRejectedValue(
      new ErrorResponse({ error: "invalid_grant", error_description: "nonce ID Token" }),
    );
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(result).toEqual({ ok: false, error: "exchange_failed" });
  });

  it("maps a non-JWT id_token (jwt-decode error) to token_invalid", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    stubTokenEndpoint("not-a-jwt");
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(result).toMatchObject({ ok: false, error: "token_invalid" });
    expect(await um.getUser()).toBeNull();
  });

  it("unexpected throws end in the single fail path (user and marker removed)", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    window.sessionStorage.setItem(VERIFIED_KEY, "old");
    stubTokenEndpoint(await mint(url.searchParams.get("nonce")!));
    const failing: SessionDeps = {
      ...deps,
      resolveKeys: async () => {
        throw new TypeError("boom");
      },
    };
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), failing);
    expect(result).toMatchObject({ ok: false, error: "token_invalid" });
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    const um2 = makeUm();
    vi.spyOn(um2.settings.stateStore, "get").mockRejectedValue(new Error("storage down"));
    expect(await handleCallback(um2, callbackUrl("s"), deps)).toEqual({
      ok: false,
      error: "exchange_failed",
    });
  });

  describe("azp (OIDC Core 3.1.3.7)", () => {
    const cases: [string, JWTPayload, boolean][] = [
      ["multiple aud without azp", { aud: [config.clientId, "other"] }, false],
      ["multiple aud, azp for another client", { aud: [config.clientId, "other"], azp: "other" }, false],
      ["multiple aud with our azp", { aud: [config.clientId, "other"], azp: config.clientId }, true],
      ["single aud, azp for another client", { azp: "other" }, false],
      ["single aud with our azp", { azp: config.clientId }, true],
    ];
    for (const [name, claims, ok] of cases) {
      it(`${ok ? "accepts" : "rejects"}: ${name}`, async () => {
        const { um, result } = await run({ claims });
        if (ok) expect(result.ok).toBe(true);
        else {
          expect(result).toMatchObject({ ok: false, error: "token_invalid" });
          expect(await um.getUser()).toBeNull();
        }
      });
    }
  });

  it("maps token endpoint failure to a generic error", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: `bad ${CODE}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const result = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(result).toEqual({ ok: false, error: "exchange_failed" });
    expectNoLeak(result);
  });
});

describe("logging", () => {
  it("the app never configures oidc-client-ts logging", () => {
    const sources = import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.*"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/setLogger|Log\.setLevel/);
    }
  });

  it("neither the library (DEBUG) nor our code prints the code or tokens", async () => {
    const lines: string[] = [];
    const sink = (...a: unknown[]) => void lines.push(JSON.stringify(a));
    Log.setLogger({ debug: sink, info: sink, warn: sink, error: sink });
    Log.setLevel(Log.DEBUG);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation(sink);
    }
    const um = makeUm();
    const url = await startLogin(um);
    stubTokenEndpoint(await mint("wrong-nonce"));
    await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(lines.length).toBeGreaterThan(0); // logging really was on
    expectNoLeak(lines);
  });
});

describe("verifyIdToken nonce", () => {
  it("rejects an empty expected nonce even if the token has an empty nonce", async () => {
    const { keys } = await deps.resolveKeys!(makeUm());
    const opts = {
      keys,
      algorithms: ["RS256"],
      issuer: config.authority,
      clientId: config.clientId,
      now: NOW,
    };
    await expect(verifyIdToken(await mint(""), { ...opts, nonce: "" })).rejects.toMatchObject({
      category: "nonce_mismatch",
    });
    await expect(
      verifyIdToken(await mint(undefined), { ...opts, nonce: "" }),
    ).rejects.toMatchObject({ category: "nonce_mismatch" });
  });
});

describe("handleCallback request errors", () => {
  // A verified session as restoreSession expects it: stored user plus matching marker.
  async function seedVerifiedSession(um: UserManager) {
    const idToken = await mint("n");
    await um.storeUser(
      new User({
        id_token: idToken,
        access_token: "a",
        token_type: "Bearer",
        profile: { sub: "user-1", iss: config.authority, aud: config.clientId, exp: 1, iat: 1 },
      }),
    );
    window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
    return idToken;
  }

  it.each([
    ["no state", `${config.redirectUri}?code=${CODE}`, "state_missing"],
    ["unknown state", `${config.redirectUri}?code=${CODE}&state=nope`, "state_invalid"],
    ["error without state", `${config.redirectUri}?error=access_denied`, "oauth_error"],
    ["error with unknown state", `${config.redirectUri}?error=access_denied&state=nope`, "oauth_error"],
  ])("crafted link (%s) keeps an existing verified session", async (_n, url, error) => {
    const um = makeUm();
    const idToken = await seedVerifiedSession(um);
    const result = await handleCallback(um, url, deps);
    expect(result).toMatchObject({ ok: false, error });
    expect((await um.getUser())?.id_token).toBe(idToken);
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBe(await sha256Hex(idToken));
    expect(await restoreSession(um, deps)).toEqual({ sub: "user-1" });
  });

  it("OAuth error with a matching state clears user and marker", async () => {
    const um = makeUm();
    await seedVerifiedSession(um);
    const url = await startLogin(um);
    const state = url.searchParams.get("state")!;
    const result = await handleCallback(um, `${config.redirectUri}?error=access_denied&state=${state}`, deps);
    expect(result).toMatchObject({ ok: false, error: "oauth_error" });
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("failure after the state matched removes user and marker", async () => {
    const um = makeUm();
    await seedVerifiedSession(um);
    const url = await startLogin(um);
    const state = url.searchParams.get("state")!;
    const result = await handleCallback(um, `${config.redirectUri}?state=${state}`, deps); // no code
    expect(result).toMatchObject({ ok: false, error: "code_missing" });
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("OAuth error param: fixed message, allowlisted code, state cleared", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const state = url.searchParams.get("state")!;
    const fetchMock = stubTokenEndpoint("x");
    const result = await handleCallback(
      um,
      `${config.redirectUri}?error=access_denied&error_description=${CODE}&state=${state}`,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "oauth_error", oauthCode: "access_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await um.settings.stateStore.get(state)).toBeNull();
    expectNoLeak(result, ERROR_MESSAGES[result.ok ? "oauth_error" : result.error]);
  });

  it("OAuth error with unknown code hides the code", async () => {
    const result = await handleCallback(
      makeUm(),
      `${config.redirectUri}?error=${CODE}`,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "oauth_error", oauthCode: undefined });
    expectNoLeak(result);
  });

  it("missing state", async () => {
    const fetchMock = stubTokenEndpoint("x");
    const result = await handleCallback(makeUm(), `${config.redirectUri}?code=${CODE}`, deps);
    expect(result).toEqual({ ok: false, error: "state_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoLeak(result);
  });

  it("unknown state", async () => {
    const fetchMock = stubTokenEndpoint("x");
    const result = await handleCallback(makeUm(), callbackUrl("nope"), deps);
    expect(result).toEqual({ ok: false, error: "state_invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoLeak(result);
  });

  it("missing code", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const state = url.searchParams.get("state")!;
    const fetchMock = stubTokenEndpoint("x");
    const result = await handleCallback(um, `${config.redirectUri}?state=${state}`, deps);
    expect(result).toEqual({ ok: false, error: "code_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await um.settings.stateStore.get(state)).toBeNull();
  });

  it("a failed new login (state matched) removes a previously stored user", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    stubTokenEndpoint(await mint(url.searchParams.get("nonce")!));
    const ok = await handleCallback(um, callbackUrl(url.searchParams.get("state")!), deps);
    expect(ok.ok).toBe(true);
    const url2 = await startLogin(um);
    stubTokenEndpoint("not-a-jwt");
    const bad = await handleCallback(um, callbackUrl(url2.searchParams.get("state")!), deps);
    expect(bad.ok).toBe(false);
    expect(await um.getUser()).toBeNull();
  });
});

describe("handleCallbackOnce", () => {
  it("exchanges the code once for repeated calls (StrictMode)", async () => {
    const um = makeUm();
    const url = await startLogin(um);
    const fetchMock = stubTokenEndpoint(await mint(url.searchParams.get("nonce")!));
    const cb = callbackUrl(url.searchParams.get("state")!);
    const [a, b] = await Promise.all([
      handleCallbackOnce(um, cb, deps),
      handleCallbackOnce(um, cb, deps),
    ]);
    expect(a).toBe(b);
    expect(a.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("restoreSession", () => {
  async function loggedIn(tokenOpts: MintOpts = {}, marker: "match" | "none" | "other" = "match") {
    const um = makeUm();
    const url = await startLogin(um);
    stubTokenEndpoint(await mint(url.searchParams.get("nonce")!, tokenOpts));
    // seed the stored user with a possibly bad token, bypassing our verification
    const { User } = await import("oidc-client-ts");
    const idToken = await mint(undefined, tokenOpts);
    await um.storeUser(
      new User({
        id_token: idToken,
        access_token: "SECRET-ACCESS-TOKEN",
        token_type: "Bearer",
        profile: { sub: "user-1", iss: "x", aud: "x", exp: 0, iat: 0 },
        expires_at: nowSec + 3600,
      }),
    );
    if (marker === "match") window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
    if (marker === "other") window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex("x"));
    return um;
  }

  it("stored user without verified marker -> untrusted and removed", async () => {
    const um = await loggedIn({}, "none");
    expect(await restoreSession(um, deps)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("verified marker for another token -> untrusted and removed", async () => {
    const um = await loggedIn({}, "other");
    expect(await restoreSession(um, deps)).toBeNull();
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("logout removes user and marker", async () => {
    const um = await loggedIn();
    await logout(um);
    expect(await um.getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("trusts a stored user with a valid token", async () => {
    const um = await loggedIn();
    expect(await restoreSession(um, deps)).toEqual({ sub: "user-1" });
    expect(await um.getUser()).not.toBeNull();
  });

  it("no stored user -> null", async () => {
    expect(await restoreSession(makeUm(), deps)).toBeNull();
  });

  it("expired token -> null and user removed", async () => {
    const um = await loggedIn({ claims: { exp: nowSec - 3600 } });
    expect(await restoreSession(um, deps)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("wrong signature -> null and user removed", async () => {
    const um = await loggedIn({ key: otherKey });
    expect(await restoreSession(um, deps)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("tampered payload -> null and user removed", async () => {
    const um = await loggedIn();
    const user = (await um.getUser())!;
    const [h, p, s] = user.id_token!.split(".");
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    claims.sub = "admin";
    const forged = `${h}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.${s}`;
    user.id_token = forged;
    await um.storeUser(user);
    window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(forged)); // marker alone must not suffice
    expect(await restoreSession(um, deps)).toBeNull();
    expect(await um.getUser()).toBeNull();
  });

  it("wrong audience -> null", async () => {
    const um = await loggedIn({ claims: { aud: "other" } });
    expect(await restoreSession(um, deps)).toBeNull();
  });
});

describe("resolveRemoteKeys", () => {
  it("rejects when Discovery advertises no supported alg", async () => {
    const um = createUserManager(config, {
      metadata: { ...metadata, id_token_signing_alg_values_supported: ["none", "HS256"] } as never,
    });
    await expect(resolveRemoteKeys(um)).rejects.toMatchObject({ category: "token_invalid" });
  });

  it("rejects when Discovery has no jwks_uri", async () => {
    const um = createUserManager(config, {
      metadata: { ...metadata, jwks_uri: undefined },
    });
    await expect(resolveRemoteKeys(um)).rejects.toMatchObject({ category: "token_invalid" });
  });

  it("builds key material from Discovery", async () => {
    const um = createUserManager(config, { metadata });
    const m = await resolveRemoteKeys(um);
    expect(m.algorithms).toEqual(["RS256"]);
    expect(await resolveRemoteKeys(um)).toBe(m); // cached
    // a new UserManager with the same jwks_uri reuses the key set
    expect(await resolveRemoteKeys(createUserManager(config, { metadata }))).toBe(m);
  });
});
