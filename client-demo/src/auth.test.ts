import { OidcClient } from "oidc-client-ts";
import { describe, expect, it, vi } from "vitest";
import { buildSettings, createUserManager } from "./auth";
import type { OidcConfig } from "./config";

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
};

function checkAuthorizeUrl(raw: string) {
  const url = new URL(raw);
  expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
  const p = url.searchParams;
  expect(p.get("client_id")).toBe("app04-react-demo");
  expect(p.get("redirect_uri")).toBe("http://localhost:5173/callback");
  expect(p.get("response_type")).toBe("code");
  expect(p.get("scope")).toBe("openid profile email");
  expect(p.get("code_challenge_method")).toBe("S256");
  expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(p.get("state")).toBeTruthy();
  // oidc-client-ts 3.5 never auto-generates a nonce; it is sent only when passed explicitly
  // (e.g. signinRedirect({ nonce })). C1 passes none; C2 will pass a random one.
  expect(p.has("nonce")).toBe(false);
  expect(raw).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcallback");
}

describe("buildSettings", () => {
  it("uses code flow, sessionStorage stores, no PKCE opt-out", () => {
    const s = buildSettings(config);
    expect(s.response_type).toBe("code");
    expect(s.automaticSilentRenew).toBe(false);
    expect(s.loadUserInfo).toBe(false);
    expect(s).not.toHaveProperty("disablePKCE");
    expect(s).not.toHaveProperty("client_secret");
    expect(s).not.toHaveProperty("metadata"); // endpoints come from Discovery
    window.sessionStorage.clear();
    window.localStorage.clear();
    void s.stateStore!.set("k", "v");
    void s.userStore!.set("u", "v");
    expect(window.sessionStorage.length).toBe(2);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("login request", () => {
  it("OidcClient builds an authorize URL with state, PKCE S256 and no nonce unless passed", async () => {
    const client = new OidcClient({
      ...buildSettings(config),
      metadata,
    });
    const req = await client.createSigninRequest({
      redirect_uri: config.redirectUri,
    });
    checkAuthorizeUrl(req.url);
  });

  it("OidcClient sends nonce when passed explicitly", async () => {
    const client = new OidcClient({
      ...buildSettings(config),
      metadata,
    });
    const req = await client.createSigninRequest({
      redirect_uri: config.redirectUri,
      nonce: "n-123",
    });
    expect(new URL(req.url).searchParams.get("nonce")).toBe("n-123");
  });

  it("signinRedirect navigates the window to that URL", async () => {
    const assign = vi.fn();
    window.stop = vi.fn(); // not implemented in happy-dom
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);
    const um = createUserManager(config, { metadata });
    // navigate() never settles (page is unloading), so do not await it
    void um.signinRedirect();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledOnce();
    checkAuthorizeUrl(assign.mock.calls[0][0] as string);
  });
});
