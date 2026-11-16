import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIntegrationTestContext } from "./helpers.js";
import { authenticateUser } from "../src/users/authentication.js";

test("M3: API resource, rotated refresh, revocation and RP logout", async () => {
  const context = await createIntegrationTestContext(authenticateUser);
  try {
    const issuer = context.baseUrl;
    const resource = `${issuer}/api`;
    const email = context.fixtures.email();
    const password = "correct-test-password";
    const registered = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }));
    assert.equal(registered.status, 201);
    const jar = new Map<string, string>();
    const request = async (url: string | URL, init: RequestInit = {}) => {
      const response = await fetch(url, {
        ...init, redirect: "manual",
        headers: { ...init.headers, connection: "close", cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") },
      });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0];
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    const formPost = (path: string, fields: Record<string, string>) => request(new URL(path, issuer), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: new URLSearchParams(fields),
    });
    const verifier = randomBytes(32).toString("base64url");
    const auth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({
      client_id: "app04-react-demo", response_type: "code", redirect_uri: "http://localhost:5173/callback",
      scope: "openid profile email api:read offline_access", resource, prompt: "consent", state: "m3-state", nonce: "m3-nonce",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })) auth.searchParams.set(key, value);
    let response = await request(auth);
    let callback: URL | undefined;
    for (let step = 0; step < 12; step++) {
      assert.equal(response.status, 303);
      const next = new URL(response.headers.get("location")!, issuer);
      if (next.origin !== issuer) { callback = next; break; }
      if (next.pathname.startsWith("/interaction/")) {
        const html = await (await request(next)).text();
        const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
        assert.ok(csrf);
        response = html.includes('name="password"')
          ? await formPost(`${next.pathname}/login`, { email, password, csrf })
          : await formPost(`${next.pathname}/consent`, { allow: "yes", csrf });
      } else response = await request(next);
    }
    assert.ok(callback);
    assert.equal(callback.searchParams.get("state"), "m3-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const token = (fields: Record<string, string>) => fetch(`${issuer}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: new URLSearchParams(fields),
    });
    const first = await token({ grant_type: "authorization_code", client_id: "app04-react-demo", code,
      redirect_uri: "http://localhost:5173/callback", code_verifier: verifier, resource });
    assert.equal(first.status, 200);
    const firstTokens = await first.json() as { access_token: string; refresh_token: string; id_token: string };
    assert.ok(firstTokens.access_token && firstTokens.refresh_token && firstTokens.id_token);
    await context.restart(); // new Provider instance, same PostgreSQL and cookie key
    const sessionAuth = new URL(auth);
    sessionAuth.searchParams.set("scope", "openid email");
    sessionAuth.searchParams.delete("resource");
    sessionAuth.searchParams.delete("prompt");
    sessionAuth.searchParams.set("state", "m3-restart-state");
    const resumed = await request(sessionAuth);
    assert.equal(resumed.status, 303);
    const resumedLocation = new URL(resumed.headers.get("location")!, issuer);
    if (resumedLocation.pathname.startsWith("/interaction/")) {
      const resumedForm = await (await request(resumedLocation)).text();
      assert.ok(!resumedForm.includes('name="password"'), "Session should persist across Provider restart");
    }
    const refresh = (refreshToken: string) => token({ grant_type: "refresh_token", client_id: "app04-react-demo", refresh_token: refreshToken, resource });
    const second = await refresh(firstTokens.refresh_token);
    assert.equal(second.status, 200);
    const secondTokens = await second.json() as { refresh_token: string; access_token: string; id_token?: string };
    assert.ok(secondTokens.refresh_token && secondTokens.access_token && secondTokens.id_token);
    assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);
    const replay = await refresh(firstTokens.refresh_token);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, "invalid_grant");
    const revoke = await fetch(`${issuer}/token/revocation`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "app04-react-demo", token: secondTokens.refresh_token, token_type_hint: "refresh_token" }) });
    assert.equal(revoke.status, 200);
    const revoked = await refresh(secondTokens.refresh_token);
    assert.equal(revoked.status, 400);
    assert.equal((await revoked.json() as { error: string }).error, "invalid_grant");
    const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json() as { end_session_endpoint: string };
    assert.ok(discovery.end_session_endpoint);
    const logout = new URL(discovery.end_session_endpoint);
    logout.searchParams.set("id_token_hint", secondTokens.id_token);
    logout.searchParams.set("post_logout_redirect_uri", "http://localhost:5173/");
    const unregistered = new URL(logout);
    unregistered.searchParams.set("post_logout_redirect_uri", "http://localhost:5173/unregistered");
    const rejectedLogout = await request(unregistered);
    assert.equal(rejectedLogout.status, 400);
    assert.match(await rejectedLogout.text(), /post_logout_redirect_uri not registered/);
    const confirmation = await request(logout);
    assert.equal(confirmation.status, 200);
    const logoutHtml = await confirmation.text();
    const action = logoutHtml.match(/<form id="op.logoutForm" method="post" action="([^"]+)"/)?.[1];
    const xsrf = logoutHtml.match(/name="xsrf" value="([^"]+)"/)?.[1];
    assert.ok(action && xsrf);
    const ended = await formPost(action, { xsrf, logout: "yes" });
    assert.equal(ended.status, 303);
    assert.equal(ended.headers.get("location"), "http://localhost:5173/");
    const afterLogout = await request(sessionAuth);
    assert.equal(afterLogout.status, 303);
    const login = new URL(afterLogout.headers.get("location")!, issuer);
    assert.ok(login.pathname.startsWith("/interaction/"));
    assert.match(await (await request(login)).text(), /name="password"/);
  } finally { await context.close(); }
});
