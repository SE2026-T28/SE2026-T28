import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const env = {
  NODE_ENV: "test",
  PORT: "3000",
  OIDC_ISSUER: "http://localhost:3000",
  OIDC_CLIENT_ID: "app04-react-demo",
  OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/",
  OIDC_SCOPES: "openid profile email",
  OIDC_CORS_ORIGIN: "http://localhost:5173",
};

test("Discovery publishes the agreed issuer and public-client endpoints", async () => {
  const agreedConfig = readConfig(env);
  assert.equal(agreedConfig.issuer, "http://localhost:3000");
  assert.equal(agreedConfig.clientId, "app04-react-demo");
  assert.equal(agreedConfig.redirectUri, "http://localhost:5173/callback");
  assert.equal(agreedConfig.postLogoutRedirectUri, "http://localhost:5173/");

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");

  const issuer = `http://127.0.0.1:${port}`;
  const server = createApp({ ...agreedConfig, issuer }).listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
    const metadata = await response.json() as Record<string, unknown>;
    assert.equal(metadata.issuer, issuer);
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      assert.equal(typeof metadata[field], "string");
      assert.ok((metadata[field] as string).startsWith(`${issuer}/`));
    }
    assert.ok((metadata.scopes_supported as string[]).includes("openid"));
    assert.ok((metadata.scopes_supported as string[]).includes("profile"));
    assert.ok((metadata.scopes_supported as string[]).includes("email"));
    assert.ok((metadata.code_challenge_methods_supported as string[]).includes("S256"));

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: agreedConfig.clientId,
      code: "invalid-code",
      redirect_uri: agreedConfig.redirectUri,
      code_verifier: "a".repeat(43),
    });
    const tokenRequest = (origin: string) => fetch(`${issuer}/token`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    const allowed = await tokenRequest(agreedConfig.corsOrigin);
    assert.equal(allowed.headers.get("access-control-allow-origin"), agreedConfig.corsOrigin);
    const denied = await tokenRequest("http://localhost:5174");
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Local configuration rejects a mismatched client origin", () => {
  assert.throws(() => readConfig({ ...env, OIDC_CORS_ORIGIN: "http://localhost:5174" }), /CORS origin/);
});
