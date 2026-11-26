import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { authenticateUser } from "../src/users/authentication.js";
import { createIntegrationTestContext } from "./helpers.js";

test("S3 real HTTP code security, expiry and error redaction", { timeout: 180000 }, async t => {
  const context = await createIntegrationTestContext(authenticateUser);
  try {
    const issuer = context.baseUrl;
    const clientId = "app04-react-demo";
    const redirectUri = "http://localhost:5173/callback";
    const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json() as { authorization_endpoint: string; token_endpoint: string };
    for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint]) {
      assert.equal(new URL(endpoint).origin, issuer);
    }
    const email = context.fixtures.email();
    const password = "S3-fixture-only-password";
    const registered = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000),
    }));
    assert.equal(registered.status, 201);
    const jar = new Map<string, string>();
    const request = async (url: URL | string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
      headers.set("connection", "close");
      const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0];
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    const issued = new Set<string>();
    async function newCode() {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(16).toString("base64url");
      const auth = new URL(discovery.authorization_endpoint);
      for (const [key, value] of Object.entries({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
        scope: "openid email", prompt: "consent", state, nonce: randomBytes(16).toString("base64url"),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      })) auth.searchParams.set(key, value);
      let response = await request(auth);
      for (let step = 0; step < 12; step++) {
        assert.equal(response.status, 303);
        const location = response.headers.get("location");
        assert.ok(location, "Expected authorization redirect");
        const next = new URL(location, issuer);
        if (next.origin !== issuer) {
          assert.ok(next.origin + next.pathname === redirectUri, "Unexpected callback destination");
          assert.ok(next.searchParams.get("state") === state, "Callback state mismatch");
          assert.ok(!next.searchParams.has("error"), "Authorization failed");
          const code = next.searchParams.get("code");
          assert.ok(code && !issued.has(code), "Expected a fresh code");
          issued.add(code);
          return { code, verifier };
        }
        if (next.pathname.startsWith("/interaction/")) {
          const form = await request(next);
          assert.equal(form.status, 200);
          const html = await form.text();
          const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
          assert.ok(csrf, "Expected interaction CSRF field");
          const login = html.includes('name="password"');
          const fields: Record<string, string> = login ? { email, password, csrf } : { allow: "yes", csrf };
          response = await request(new URL(`${next.pathname}/${login ? "login" : "consent"}`, issuer), {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields),
          });
        } else response = await request(next);
      }
      throw new Error("Authorization redirect bound exceeded");
    }
    const exchange = (fields: Record<string, string>) => fetch(discovery.token_endpoint, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, ...fields }),
    });
    const tokenKeys = ["access_token", "id_token", "refresh_token"];
    const rejected = async (id: string, response: Response, expected: "invalid_request" | "invalid_grant", secrets: string[]) => {
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { throw new Error("Expected OAuth JSON error response"); }
      assert.ok(body && typeof body === "object", "Expected OAuth JSON error");
      const fields = body as Record<string, unknown>;
      const error = fields.error === "invalid_request" || fields.error === "invalid_grant" ? fields.error : "unexpected";
      const tokenPresent = tokenKeys.some(key => Object.hasOwn(fields, key));
      t.diagnostic(`${id}: status=${response.status} oauthError=${error} tokenPresent=${tokenPresent}`);
      assert.equal(response.status, 400);
      assert.equal(error, expected);
      assert.equal(tokenPresent, false);
      assert.ok(!response.headers.has("location"), "Token error must not redirect");
      assert.ok(!secrets.some(secret => text.includes(secret)), "Sensitive value reflected in OAuth error");
    };
    const accepted = async (id: string, response: Response) => {
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.ok(typeof body.access_token === "string" && body.access_token.length > 0, "Expected Access Token");
      assert.ok(typeof body.id_token === "string" && body.id_token.length > 0, "Expected ID Token");
      assert.ok(typeof body.token_type === "string" && body.token_type.toLowerCase() === "bearer", "Expected Bearer type");
      assert.ok(typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0);
      assert.ok(!Object.hasOwn(body, "error"));
      t.diagnostic(`${id}: status=200 tokenPresent=true`);
    };
    await t.test("S3-01 S256 positive control", async () => {
      const { code, verifier } = await newCode();
      await accepted("S3-01", await exchange({ code, code_verifier: verifier }));
    });
    await t.test("S3-02 missing code", async () => {
      await rejected("S3-02", await exchange({ code_verifier: "x".repeat(43) }), "invalid_request", [password]);
    });
    await t.test("S3-03 unissued code", async () => {
      const code = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      await rejected("S3-03", await exchange({ code, code_verifier: verifier }), "invalid_grant", [code, verifier, password]);
    });
    await t.test("S3-04 replay of successfully exchanged code", async () => {
      const { code, verifier } = await newCode();
      await accepted("S3-04 first", await exchange({ code, code_verifier: verifier }));
      await rejected("S3-04 replay", await exchange({ code, code_verifier: verifier }), "invalid_grant", [code, verifier, password]);
    });
    await t.test("S3-07 redirect binding with same-code positive control", async () => {
      const { code, verifier } = await newCode();
      await rejected("S3-07", await exchange({ code, code_verifier: verifier, redirect_uri: `${redirectUri}/wrong` }),
        "invalid_grant", [code, verifier, password]);
      await accepted("S3-07 control", await exchange({ code, code_verifier: verifier }));
    });
    await t.test("S3-05 unused code expires with real elapsed time", { timeout: 110000 }, async () => {
      const { code, verifier } = await newCode();
      const started = performance.now();
      // oidc-provider 9.12.2 defaults: AuthorizationCodeTTL=60s, clockTolerance=15s.
      // Current createApp does not override either. Never shorten production TTL.
      await delay(60000);
      await delay(17000);
      assert.ok(performance.now() - started >= 77000, "Code expiry wait was too short");
      await rejected("S3-05", await exchange({ code, code_verifier: verifier }), "invalid_grant", [code, verifier, password]);
      const control = await newCode();
      await accepted("S3-05 fresh control", await exchange({ code: control.code, code_verifier: control.verifier }));
      t.diagnostic("S3-05: elapsedAtLeast77Seconds=true codePreviouslyUsed=false");
    });
  } finally { await context.close(); }
});
