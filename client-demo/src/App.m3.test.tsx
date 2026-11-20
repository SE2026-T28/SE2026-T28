import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { User } from "oidc-client-ts";
import { StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App, LOGOUT_LOCAL_ONLY, LOGOUT_WARNING, PROFILE_MESSAGES } from "./App";
import type { OidcConfig } from "./config";
import { getUserManager, resetRuntimeForTests } from "./runtime";
import { LOGOUT_PENDING_KEY, LOGOUT_WARNING_KEY, VERIFIED_KEY } from "./session";

const config: OidcConfig = {
  authority: "http://localhost:3000",
  clientId: "app04-react-demo",
  redirectUri: "http://localhost:5173/callback",
  postLogoutRedirectUri: "http://localhost:5173/",
  scope: "openid profile email api:read offline_access",
  apiResource: "http://localhost:3000/api",
};
const metadata = {
  issuer: config.authority,
  authorization_endpoint: "http://localhost:3000/auth",
  token_endpoint: "http://localhost:3000/token",
  jwks_uri: "http://localhost:3000/jwks",
  revocation_endpoint: "http://localhost:3000/token/revocation",
  end_session_endpoint: "http://localhost:3000/session/end",
  id_token_signing_alg_values_supported: ["RS256"],
};
const mocks = vi.hoisted(() => ({ keys: null as unknown }));

vi.mock("./config", async (orig) => ({
  ...(await orig<typeof import("./config")>()),
  loadConfig: () => config,
}));
vi.mock("./auth", async (orig) => {
  const real = await orig<typeof import("./auth")>();
  return {
    ...real,
    createUserManager: (c: OidcConfig) => real.createUserManager(c, { metadata }),
  };
});
vi.mock("./verify", async (orig) => ({
  ...(await orig<typeof import("./verify")>()),
  resolveRemoteKeys: async () => ({ keys: mocks.keys, algorithms: ["RS256"] }),
}));

const SECRET_AT = "SECRET-ACCESS-TOKEN";
const SECRET_RT = "SECRET-REFRESH-TOKEN";
const nowSec = () => Math.floor(Date.now() / 1000);
let signKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  mocks.keys = createLocalJWKSet({ keys: [jwk] });
});

const mint = () =>
  new SignJWT({
    sub: "user-1",
    iss: config.authority,
    aud: config.clientId,
    iat: nowSec(),
    exp: nowSec() + 600,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(signKey);

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedVerifiedUser() {
  const idToken = await mint();
  await getUserManager().storeUser(
    new User({
      id_token: idToken,
      access_token: SECRET_AT,
      refresh_token: SECRET_RT,
      token_type: "Bearer",
      scope: config.scope,
      profile: { sub: "user-1", iss: "x", aud: "x", exp: 0, iat: 0 },
      expires_at: nowSec() + 300,
    }),
  );
  window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stub(handler: (url: string) => Response | Promise<Response>) {
  const m = vi.fn(async (url: RequestInfo | URL) => handler(String(url)));
  vi.stubGlobal("fetch", m);
  return m;
}
const calls = (m: ReturnType<typeof stub>, suffix: string) =>
  m.mock.calls.filter(([u]) => String(u).endsWith(suffix));

function renderStrict() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

function spyNavigation() {
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    href: window.location.href, // prototype getters are not copied by the spread
    assign,
  } as unknown as Location);
  return assign;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.pushState(null, "", "/");
  resetRuntimeForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectNoSecrets() {
  const text = document.body.innerHTML + window.location.href;
  expect(text).not.toContain(SECRET_AT);
  expect(text).not.toContain(SECRET_RT);
  expect(text).not.toContain("SERVER-TEXT");
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
}

describe("protected profile states", () => {
  it("shows loading, then the API data for a verified user", async () => {
    await seedVerifiedUser();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stub(async () => {
      await gate;
      return json({ sub: "user-1" });
    });
    renderStrict();
    await screen.findByText("Loading profile…");
    expect(screen.queryByTestId("api-sub")).toBeNull();
    release();
    expect((await screen.findByTestId("api-sub")).textContent).toBe("user-1");
    expectNoSecrets();
  });

  it("an unverified stored user never reaches the API or the dashboard", async () => {
    await seedVerifiedUser();
    window.sessionStorage.removeItem(VERIFIED_KEY);
    const fetchMock = stub(() => json({ sub: "user-1" }));
    renderStrict();
    await screen.findByRole("button", { name: "Login" });
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(calls(fetchMock, "/protected/profile")).toHaveLength(0);
  });

  it("sub mismatch: fixed error, the foreign sub is never rendered", async () => {
    await seedVerifiedUser();
    stub(() => json({ sub: "someone-else" }));
    renderStrict();
    expect((await screen.findByRole("alert")).textContent).toBe(PROFILE_MESSAGES.error);
    expect(document.body.innerHTML).not.toContain("someone-else");
    expect(screen.queryByTestId("api-sub")).toBeNull();
  });

  it("403: safe message, no data", async () => {
    await seedVerifiedUser();
    stub(() => json({ error: "insufficient_scope" }, 403));
    renderStrict();
    expect((await screen.findByRole("alert")).textContent).toBe(PROFILE_MESSAGES.forbidden);
    expect(screen.queryByTestId("api-sub")).toBeNull();
  });

  it("500: fixed message without server text; Retry loads again", async () => {
    await seedVerifiedUser();
    let fail = true;
    stub(() =>
      fail ? new Response("SERVER-TEXT", { status: 500 }) : json({ sub: "user-1" }),
    );
    renderStrict();
    expect((await screen.findByRole("alert")).textContent).toBe(PROFILE_MESSAGES.error);
    expectNoSecrets();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByTestId("api-sub")).textContent).toBe("user-1");
  });

  it("network error: fixed message", async () => {
    await seedVerifiedUser();
    stub(() => {
      throw new TypeError("Failed to fetch SERVER-TEXT");
    });
    renderStrict();
    expect((await screen.findByRole("alert")).textContent).toBe(PROFILE_MESSAGES.error);
    expectNoSecrets();
  });

  it("401 + refresh failure: session expired view, no dashboard, nothing stored", async () => {
    await seedVerifiedUser();
    stub((url) =>
      url.endsWith("/token") ? json({ error: "invalid_grant" }, 400) : json({}, 401),
    );
    renderStrict();
    expect((await screen.findByRole("status")).textContent).toBe(PROFILE_MESSAGES.expired);
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
    expect(await getUserManager().getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("401 + refresh success: retried and rendered; StrictMode causes one refresh", async () => {
    await seedVerifiedUser();
    let profileCalls = 0;
    const fetchMock = stub(async (url) =>
      url.endsWith("/token")
        ? json({
            access_token: "NEW-AT",
            refresh_token: "NEW-RT",
            id_token: await mint(),
            token_type: "Bearer",
            expires_in: 300,
            scope: config.scope,
          })
        : json({ sub: "user-1" }, profileCalls++ === 0 ? 401 : 200),
    );
    renderStrict();
    expect((await screen.findByTestId("api-sub")).textContent).toBe("user-1");
    expect(calls(fetchMock, "/token")).toHaveLength(1);
    expectNoSecrets();
  });
});

describe("logout UI", () => {
  it("Logout revokes, clears, redirects; no protected data stays on screen", async () => {
    await seedVerifiedUser();
    const fetchMock = stub((url) =>
      url.endsWith("/token/revocation") ? new Response(null, { status: 200 }) : json({ sub: "user-1" }),
    );
    renderStrict();
    await screen.findByTestId("api-sub");
    const assign = spyNavigation();
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock, "/token/revocation")).toHaveLength(1);
    expect(String(assign.mock.calls[0][0])).toContain("id_token_hint=");
    expect(await getUserManager().getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("Provider without end_session: local logout notice, no protected data", async () => {
    await seedVerifiedUser();
    stub(() => json({ sub: "user-1" }));
    renderStrict();
    await screen.findByTestId("api-sub");
    vi.spyOn(getUserManager(), "signoutRedirect").mockRejectedValue(new Error("no endpoint"));
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect((await screen.findByText(LOGOUT_LOCAL_ONLY)).textContent).toBe(LOGOUT_LOCAL_ONLY);
    expect(screen.queryByTestId("api-sub")).toBeNull();
    expect(screen.queryByText("Logged in")).toBeNull();
  });

  it("return from the Provider: logged-out state, URL scrubbed, no dashboard", async () => {
    window.sessionStorage.setItem(LOGOUT_PENDING_KEY, "1");
    window.history.pushState(null, "", "/?state=abc");
    stub(() => json({ sub: "user-1" }));
    renderStrict();
    expect((await screen.findByRole("status")).textContent).toBe("You are logged out.");
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Logged in")).toBeNull();
  });

  it("return after a failed revocation shows the 300 s warning once", async () => {
    window.sessionStorage.setItem(LOGOUT_PENDING_KEY, "1");
    window.sessionStorage.setItem(LOGOUT_WARNING_KEY, "1");
    stub(() => json({}));
    renderStrict();
    expect((await screen.findByRole("alert")).textContent).toBe(LOGOUT_WARNING);
    expect(LOGOUT_WARNING).toContain("300 seconds");
    cleanup();
    resetRuntimeForTests();
    renderStrict(); // reload: the flag was consumed
    await screen.findByRole("button", { name: "Login" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reload after logout shows no protected data", async () => {
    await seedVerifiedUser();
    stub(() => new Response(null, { status: 200 }));
    spyNavigation();
    const um = getUserManager();
    const { logout } = await import("./session");
    void logout(um);
    await waitFor(async () => expect(await um.getUser()).toBeNull());
    vi.restoreAllMocks();
    resetRuntimeForTests();
    window.history.pushState(null, "", "/");
    renderStrict();
    await screen.findByRole("button", { name: "Login" });
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(screen.queryByTestId("api-sub")).toBeNull();
  });

  it("bfcache restore (pageshow persisted) after logout hides protected data", async () => {
    await seedVerifiedUser();
    stub((url) =>
      url.endsWith("/token/revocation") ? new Response(null, { status: 200 }) : json({ sub: "user-1" }),
    );
    renderStrict();
    await screen.findByTestId("api-sub");
    // the user logged out (elsewhere/after navigation) while this page sat in bfcache
    await getUserManager().removeUser();
    window.sessionStorage.removeItem(VERIFIED_KEY);
    await act(async () => {
      const ev = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(ev, "persisted", { value: true });
      window.dispatchEvent(ev);
    });
    await screen.findByRole("button", { name: "Login" });
    expect(screen.queryByTestId("api-sub")).toBeNull();
    expect(screen.queryByText("Logged in")).toBeNull();
  });

  it("Logout removes protected data before navigation; Back (bfcache) restores a usable Login", async () => {
    await seedVerifiedUser();
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((r) => (releaseRevoke = r));
    stub(async (url) => {
      if (url.endsWith("/token/revocation")) {
        await revokeGate;
        return new Response(null, { status: 200 });
      }
      return json({ sub: "user-1" });
    });
    renderStrict();
    await screen.findByTestId("api-sub");
    const assign = spyNavigation();
    fireEvent.click(screen.getByRole("button", { name: "Logout" })); // the real button path
    // revocation is still pending and nothing has navigated: protected data is already gone
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("api-sub")).toBeNull();
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(screen.getByText("Logging out…")).toBeTruthy();
    releaseRevoke();
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    // the frozen page snapshot (what bfcache keeps) holds no protected data
    expect(screen.queryByTestId("api-sub")).toBeNull();
    expect(screen.queryByText("user-1")).toBeNull();
    expect(document.body.textContent).not.toContain("user-1");
    // Back: the frozen page is shown again
    await act(async () => {
      const ev = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(ev, "persisted", { value: true });
      window.dispatchEvent(ev);
      // synchronously after the event: still no protected data and no stale "Logging out…"
      expect(screen.queryByTestId("api-sub")).toBeNull();
    });
    const login = await screen.findByRole("button", { name: "Login" });
    expect((login as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("api-sub")).toBeNull();
    expect(screen.queryByText("Logging out…")).toBeNull();
    // the logout flags were consumed here, so a later reload cannot log a new session out
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("You are logged out.");
  });

  it("a persisted pageshow after a failed-revocation logout shows the warning and consumes the flags", async () => {
    await seedVerifiedUser();
    stub((url) =>
      url.endsWith("/token/revocation") ? new Response(null, { status: 500 }) : json({ sub: "user-1" }),
    );
    renderStrict();
    await screen.findByTestId("api-sub");
    const assign = spyNavigation();
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBe("1");
    await act(async () => {
      const ev = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(ev, "persisted", { value: true });
      window.dispatchEvent(ev);
    });
    expect((await screen.findByRole("alert")).textContent).toBe(LOGOUT_WARNING);
    expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LOGOUT_WARNING_KEY)).toBeNull();
  });

  it("a non-persisted pageshow keeps a valid session", async () => {
    await seedVerifiedUser();
    stub(() => json({ sub: "user-1" }));
    renderStrict();
    await screen.findByTestId("api-sub");
    await act(async () => {
      const ev = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(ev, "persisted", { value: false });
      window.dispatchEvent(ev);
    });
    expect(screen.getByTestId("api-sub")).toBeTruthy();
  });
});

describe("bfcache restore after logout", () => {
  async function pageshowPersisted() {
    await act(async () => {
      const ev = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(ev, "persisted", { value: true });
      window.dispatchEvent(ev);
    });
  }

  it("a restored page can refresh a session that was logged in elsewhere (guard reset)", async () => {
    await seedVerifiedUser();
    let armed = false; // after the logout the profile API answers 401 once to force a refresh
    stub(async (url) => {
      if (url.endsWith("/token/revocation")) return new Response(null, { status: 200 });
      if (url.endsWith("/token")) {
        return json({
          access_token: "NEW-AT",
          refresh_token: "NEW-RT",
          id_token: await mint(),
          token_type: "Bearer",
          expires_in: 300,
          scope: config.scope,
        });
      }
      if (armed) {
        armed = false;
        return json({ sub: "user-1" }, 401);
      }
      return json({ sub: "user-1" });
    });
    renderStrict();
    await screen.findByTestId("api-sub");
    const assign = spyNavigation();
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1)); // "redirected": guard stays set
    await seedVerifiedUser(); // the user logged in on another page (login() clears the logout flags)
    window.sessionStorage.removeItem(LOGOUT_PENDING_KEY);
    window.sessionStorage.removeItem(LOGOUT_WARNING_KEY);
    armed = true;
    await pageshowPersisted();
    expect((await screen.findByTestId("api-sub")).textContent).toBe("user-1");
    expect(screen.queryByText(PROFILE_MESSAGES.expired)).toBeNull();
  });

  it("a persisted pageshow clears the previous notice", async () => {
    await seedVerifiedUser();
    stub((url) =>
      url.endsWith("/token/revocation") ? json({ error: "server_error" }, 500) : json({ sub: "user-1" }),
    );
    renderStrict();
    await screen.findByTestId("api-sub");
    spyNavigation();
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(window.sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe("1"));
    await pageshowPersisted(); // consumes the flags: shows the revocation warning
    expect((await screen.findByRole("alert")).textContent).toBe(LOGOUT_WARNING);
    // second restore, no logout flags this time: the old warning must not stay
    await pageshowPersisted();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("You are logged out."));
    expect(screen.queryByText(LOGOUT_WARNING)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
