import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { App } from "./App";
import { ConfigError, type OidcConfig } from "./config";
import { getUserManager, resetRuntimeForTests } from "./runtime";
import { ERROR_MESSAGES, VERIFIED_KEY, login } from "./session";

const config: OidcConfig = {
  authority: "http://localhost:3000",
  clientId: "app04-react-demo",
  redirectUri: "http://localhost:5173/callback",
  postLogoutRedirectUri: "http://localhost:5173/",
  scope: "openid profile email",
};

const metadata = {
  issuer: config.authority,
  authorization_endpoint: "http://localhost:3000/auth",
  token_endpoint: "http://localhost:3000/token",
  jwks_uri: "http://localhost:3000/jwks",
  id_token_signing_alg_values_supported: ["RS256"],
};

const mocks = vi.hoisted(() => ({ keys: null as unknown, configError: null as Error | null }));

vi.mock("./config", async (orig) => ({
  ...(await orig<typeof import("./config")>()),
  loadConfig: () => {
    if (mocks.configError) throw mocks.configError;
    return config;
  },
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

const CODE = "SECRET-AUTH-CODE-123";
const DESCRIPTION = "SECRET-ERROR-DESCRIPTION";
const nowSec = Math.floor(Date.now() / 1000);

let signKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  mocks.keys = createLocalJWKSet({ keys: [jwk] });
});

function mint(nonce: string, claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: "user-1",
    iss: config.authority,
    aud: config.clientId,
    iat: nowSec,
    exp: nowSec + 600,
    nonce,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(signKey);
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Starts a real login on the shared UserManager and returns its authorize params.
async function beginLogin() {
  const assign = vi.fn();
  const spy = vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  } as unknown as Location);
  void login(getUserManager());
  await vi.waitFor(() => expect(assign).toHaveBeenCalled());
  spy.mockRestore();
  return new URL(assign.mock.calls[0][0] as string).searchParams;
}

function stubTokenEndpoint(idToken: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "SECRET-ACCESS-TOKEN",
          token_type: "Bearer",
          id_token: idToken,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function gotoCallback(query: string) {
  window.history.pushState(null, "", `/callback?${query}`);
}

function renderStrict() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.pushState(null, "", "/");
  mocks.configError = null;
  resetRuntimeForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectNoSecrets() {
  const text = document.body.innerHTML + window.location.href;
  expect(text).not.toContain(CODE);
  expect(text).not.toContain(DESCRIPTION);
  expect(text).not.toContain("SECRET-ACCESS-TOKEN");
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
}

describe("Callback (StrictMode)", () => {
  it("hides the dashboard while pending, exchanges once, shows it after success", async () => {
    const params = await beginLogin();
    const state = params.get("state")!;
    const fetchMock = stubTokenEndpoint(await mint(params.get("nonce")!));
    gotoCallback(`code=${CODE}&state=${state}`);

    renderStrict();
    // address bar scrubbed on the first render, before the exchange finishes
    expect(window.location.href).not.toContain("code=");
    expect(window.location.href).not.toContain("state=");
    expect(screen.getByText("Signing in…")).toBeTruthy();
    expect(screen.queryByText("Logged in")).toBeNull();

    await screen.findByText("Logged in");
    expect(screen.getByText("user-1")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeTruthy();
    expectNoSecrets();
  });

  it("never shows the dashboard after a failed verification and clears the user", async () => {
    const params = await beginLogin();
    stubTokenEndpoint(await mint("attacker-nonce"));
    gotoCallback(`code=${CODE}&state=${params.get("state")}`);

    renderStrict();
    expect(screen.queryByText("Logged in")).toBeNull();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Login failed: ${ERROR_MESSAGES.nonce_mismatch}`);
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(await getUserManager().getUser()).toBeNull();
    expect(window.sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
    expectNoSecrets();
  });

  it("OAuth error: fixed message plus allowlisted code only", async () => {
    gotoCallback(`error=access_denied&error_description=${DESCRIPTION}&state=x`);
    renderStrict();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      `Login failed: ${ERROR_MESSAGES.oauth_error} (access_denied)`,
    );
    expectNoSecrets();
  });

  it("OAuth error with a non-allowlisted code hides it", async () => {
    gotoCallback(`error=${DESCRIPTION}&state=x`);
    renderStrict();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Login failed: ${ERROR_MESSAGES.oauth_error}`);
    expectNoSecrets();
  });

  it("a later re-render keeps the Callback route and does not re-run the exchange", async () => {
    const params = await beginLogin();
    const fetchMock = stubTokenEndpoint(await mint(params.get("nonce")!));
    gotoCallback(`code=${CODE}&state=${params.get("state")}`);
    const { rerender } = renderStrict();
    await screen.findByText("Logged in");
    rerender(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.getByText("Logged in")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Home", () => {
  async function seedUser(withMarker: boolean) {
    const params = await beginLogin();
    const idToken = await mint(params.get("nonce")!);
    await getUserManager().storeUser(
      new User({
        id_token: idToken,
        access_token: "SECRET-ACCESS-TOKEN",
        token_type: "Bearer",
        profile: { sub: "user-1", iss: "x", aud: "x", exp: 0, iat: 0 },
        expires_at: nowSec + 3600,
      }),
    );
    if (withMarker) window.sessionStorage.setItem(VERIFIED_KEY, await sha256Hex(idToken));
  }

  it("shows the dashboard for a verified stored session", async () => {
    await seedUser(true);
    renderStrict();
    await screen.findByText("Logged in");
  });

  it("hides the dashboard for a stored user that was never verified", async () => {
    await seedUser(false);
    renderStrict();
    await screen.findByRole("button", { name: "Login" });
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(await getUserManager().getUser()).toBeNull();
  });

  it("shows no dashboard while restoring", async () => {
    renderStrict();
    expect(screen.queryByText("Logged in")).toBeNull();
    await screen.findByRole("button", { name: "Login" });
  });

  it("disables Login while the redirect is pending (no double start)", async () => {
    const spy = vi
      .spyOn(getUserManager(), "signinRedirect")
      .mockImplementation(() => new Promise(() => {}));
    renderStrict();
    const button = (await screen.findByRole("button", { name: "Login" })) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("login failure shows a fixed message, never library text", async () => {
    vi.spyOn(getUserManager(), "signinRedirect").mockRejectedValue(
      new Error(`Not Found (404): {"secret":"${DESCRIPTION}"} http://localhost:3000/x`),
    );
    renderStrict();
    fireEvent.click(await screen.findByRole("button", { name: "Login" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Login failed: Could not start the login.");
    expectNoSecrets();
    expect((screen.getByRole("button", { name: "Login" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("config error on load: no blank page, hint shown, Login retries once fixed", async () => {
    mocks.configError = new ConfigError("Missing env var(s): VITE_OIDC_AUTHORITY.");
    renderStrict();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("VITE_OIDC_AUTHORITY");
    expect(screen.queryByText("Logged in")).toBeNull();
    const button = screen.getByRole("button", { name: "Login" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("VITE_OIDC_AUTHORITY"));
    expect(button.disabled).toBe(false);

    mocks.configError = null;
    const spy = vi
      .spyOn(getUserManager(), "signinRedirect")
      .mockImplementation(() => new Promise(() => {}));
    fireEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Callback with config error", () => {
  it("shows a fixed failure message, no dashboard, no env text", async () => {
    mocks.configError = new ConfigError("Missing env var(s): VITE_OIDC_AUTHORITY.");
    gotoCallback(`code=${CODE}&state=abc`);
    renderStrict();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Login failed: ${ERROR_MESSAGES.exchange_failed}`);
    expect(screen.queryByText("Logged in")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to login" })).toBeTruthy();
    expectNoSecrets();
  });
});
