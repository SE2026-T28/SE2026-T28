import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIntegrationTestContext } from "./helpers.js";
import { authenticateUser } from "../src/users/authentication.js";

test("registered account completes login, consent and one-use S256 code", async (t) => {
  const context = await createIntegrationTestContext(authenticateUser);
  try {
    const issuer = context.baseUrl;
    const redirectUri = "http://localhost:5173/callback";
    const clientId = "app04-react-demo";
    const email = context.fixtures.email();
    const password = "correct-test-password";
    const jar = new Map<string, string>();
    const request = async (url: string | URL, init: RequestInit = {}) => {
      const response = await fetch(url, { ...init, redirect: "manual", headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0];
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const registered = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
    assert.equal(registered.status, 201);
    const registration = await registered.json() as { user: { id: string; email: string } };
    const userId = registration.user.id;
    const auth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: "openid email", state: "flow-state", nonce: "flow-nonce", code_challenge: challenge, code_challenge_method: "S256" })) auth.searchParams.set(key, value);
    let response = await request(auth);
    let location = response.headers.get("location")!;
    assert.match(location, /^\/interaction\//);

    let html = await (await request(new URL(location, issuer))).text();
    let csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const post = async (path: string, fields: Record<string, string>) => request(new URL(path, issuer), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    const wrong = await post(`${location}/login`, { email, password: "wrong", csrf });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("location"), null);
    const wrongHtml = await wrong.text();
    const unknown = await post(`${location}/login`, { email: `unknown-${email}`, password, csrf });
    assert.equal(unknown.status, 401);
    assert.equal(await unknown.text(), wrongHtml);
    response = await post(`${location}/login`, { email, password, csrf });
    assert.equal(response.status, 303);
    location = response.headers.get("location")!;
    response = await request(new URL(location, issuer));
    location = response.headers.get("location")!;
    if (location.startsWith("/interaction/")) {
      html = await (await request(new URL(location, issuer))).text();
      assert.match(html, /Cấp quyền/);
      csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      const unicodeCsrf = await post(`${location}/consent`, { allow: "yes", csrf: "é".repeat(64) });
      assert.equal(unicodeCsrf.status, 403);
      assert.equal(unicodeCsrf.headers.get("location"), null);
      response = await post(`${location}/consent`, { allow: "yes", csrf });
      assert.equal(response.status, 303);
      response = await request(new URL(response.headers.get("location")!, issuer));
      location = response.headers.get("location")!;
    }
    const callback = new URL(location, issuer);
    assert.equal(callback.origin, "http://localhost:5173");
    assert.equal(callback.searchParams.get("state"), "flow-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const token = (authorizationCode: string, codeVerifier: string) => fetch(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:5173" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: authorizationCode, redirect_uri: redirectUri, code_verifier: codeVerifier }) });
    const first = await token(code, verifier);
    assert.equal(first.status, 200);
    const payload = await first.json() as { id_token: string; access_token: string };
    const claims = JSON.parse(Buffer.from(payload.id_token.split(".")[1], "base64url").toString()) as Record<string, unknown>;
    assert.equal(claims.sub, userId);
    assert.notEqual(claims.email_verified, true);
    const userInfo = await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${payload.access_token}` } });
    assert.equal(userInfo.status, 200);
    const info = await userInfo.json() as Record<string, unknown>;
    assert.equal(info.sub, userId);
    assert.equal(info.email, email);
    const replay = await token(code, verifier);
    assert.notEqual(replay.status, 200);

    // Existing session and grant may skip prompts, but still issue a fresh code
    // bound to the new S256 challenge.
    const secondAuth = await request(auth);
    let secondLocation = new URL(secondAuth.headers.get("location")!, issuer);
    for (let i = 0; i < 10 && secondLocation.origin === issuer; i++) {
      let continuation;
      if (secondLocation.pathname.startsWith("/interaction/")) {
        const formHtml = await (await request(secondLocation)).text();
        const formCsrf = formHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
        assert.ok(formCsrf);
        continuation = formHtml.includes("name=\"password\"")
          ? await post(`${secondLocation.pathname}/login`, { email, password, csrf: formCsrf })
          : await post(`${secondLocation.pathname}/consent`, { allow: "yes", csrf: formCsrf });
      } else {
        continuation = await request(secondLocation);
      }
      secondLocation = new URL(continuation.headers.get("location")!, issuer);
    }
    assert.equal(secondLocation.origin, "http://localhost:5173", secondLocation.pathname);
    const secondCode = secondLocation.searchParams.get("code");
    assert.ok(secondCode);
    const wrongVerifier = await token(secondCode, "x".repeat(43));
    assert.notEqual(wrongVerifier.status, 200);

    const issuedCodes = new Set([code, secondCode]);
    for (const [id, omitVerifier] of [["M2-04a", false], ["M2-04b", true]] as const) {
      await t.test(id, async () => {
        const freshVerifier = randomBytes(32).toString("base64url");
        const freshChallenge = createHash("sha256").update(freshVerifier).digest("base64url");
        const freshState = randomBytes(16).toString("base64url");
        const authorization = new URL(auth);
        authorization.searchParams.set("code_challenge", freshChallenge);
        authorization.searchParams.set("state", freshState);
        authorization.searchParams.set("nonce", randomBytes(16).toString("base64url"));

        let nextResponse = await request(authorization);
        let freshCode: string | null = null;
        for (let redirects = 0; redirects < 10; redirects++) {
          assert.equal(nextResponse.status, 303);
          const next = nextResponse.headers.get("location");
          assert.ok(next, "Expected a redirect");
          const destination = new URL(next, issuer);
          if (destination.origin !== issuer) {
            assert.ok(destination.origin + destination.pathname === redirectUri, "Unexpected callback");
            assert.ok(destination.searchParams.get("state") === freshState, "Callback state mismatch");
            assert.ok(!destination.searchParams.has("error"), "Authorization returned an error");
            freshCode = destination.searchParams.get("code");
            break;
          }
          nextResponse = await request(destination);
        }
        assert.ok(freshCode && !issuedCodes.has(freshCode), "Expected a fresh authorization code");
        issuedCodes.add(freshCode);

        const params = new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId, code: freshCode, redirect_uri: redirectUri,
        });
        if (!omitVerifier) {
          const incorrectVerifier = (freshVerifier[0] === "A" ? "B" : "A") + freshVerifier.slice(1);
          params.set("code_verifier", incorrectVerifier);
        }
        const exchange = () => fetch(`${issuer}/token`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:5173" },
          body: params,
        });
        const rejected = await exchange();
        const body: unknown = await rejected.json().catch(() => null);
        const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const error = fields.error;
        const oauthError = error === "invalid_grant" || error === "invalid_request"
          ? error : error === undefined ? "missing" : "unexpected";
        const tokenPresent = ["access_token", "id_token", "refresh_token"].some(key => Object.hasOwn(fields, key));
        t.diagnostic(`${id}: status=${rejected.status} oauthError=${oauthError} tokenPresent=${tokenPresent}`);
        assert.equal(rejected.status, 400);
        // oidc-provider 9.12.2 routes both missing and mismatched verifiers for
        // a PKCE-bound code through checkPKCE and returns InvalidGrant.
        assert.equal(oauthError, "invalid_grant");
        assert.equal(tokenPresent, false);

        // PKCE is checked before the Provider consumes the code. Change only the verifier.
        params.set("code_verifier", freshVerifier);
        const accepted = await exchange();
        const acceptedBody: unknown = await accepted.json().catch(() => null);
        const tokens = acceptedBody && typeof acceptedBody === "object"
          ? acceptedBody as Record<string, unknown> : {};
        const hasAccessToken = typeof tokens.access_token === "string" && tokens.access_token.length > 0;
        const hasIdToken = typeof tokens.id_token === "string" && tokens.id_token.length > 0;
        const acceptedTokenPresent = ["access_token", "id_token", "refresh_token"]
          .some(key => Object.hasOwn(tokens, key));
        t.diagnostic(`${id} positive: status=${accepted.status} tokenPresent=${acceptedTokenPresent}`);
        assert.equal(accepted.status, 200);
        assert.ok(hasAccessToken && hasIdToken, "Expected access and ID tokens");
        assert.ok(typeof tokens.token_type === "string" && tokens.token_type.toLowerCase() === "bearer",
          "Expected Bearer token type");
        assert.ok(typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0,
          "Expected a positive token lifetime");
        assert.ok(!Object.hasOwn(tokens, "error"), "Successful token response must not contain an OAuth error");
      });
    }
  } finally {
    await context.close();
  }
});
