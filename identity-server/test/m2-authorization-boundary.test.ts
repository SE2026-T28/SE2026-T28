import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import { createApp } from "../src/app.js";

const clientId = "app04-react-demo";
const redirectUri = "http://localhost:5173/callback";
const challenge = "a".repeat(43);

let server: Server;
let authorizationEndpoint: string;

before(async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const issuer = `http://localhost:${port}`;
  server = createApp({
    port,
    issuer,
    clientId,
    redirectUri,
    postLogoutRedirectUri: "http://localhost:5173/",
    scopes: ["openid", "profile", "email"],
    corsOrigin: "http://localhost:5173",
  }).listen(port);
  await once(server, "listening");

  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const discovery = await response.json() as { authorization_endpoint: string };
  authorizationEndpoint = discovery.authorization_endpoint;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function authorize(overrides: Record<string, string | null> = {}): Promise<Response> {
  const url = new URL(authorizationEndpoint);
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state: "m2-boundary-state",
    nonce: "m2-boundary-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete params[name];
    else params[name] = value;
  }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
}

function assertPkceInvalidRequest(response: Response): void {
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.ok(location, "Provider must redirect errors for a registered callback");
  const destination = new URL(location, authorizationEndpoint);
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.has("code"), false);
  assert.equal(destination.searchParams.get("error"), "invalid_request");
  assert.equal(destination.searchParams.get("state"), "m2-boundary-state");
}

test("O1 rejects an authorization request without PKCE", { timeout: 10000 }, async () => {
  const response = await authorize({ code_challenge: null, code_challenge_method: null });
  assertPkceInvalidRequest(response);
});

test("O1 rejects a PKCE method other than S256", { timeout: 10000 }, async () => {
  const response = await authorize({ code_challenge_method: "plain" });
  assertPkceInvalidRequest(response);
});

test("O1 does not redirect to an unregistered callback", { timeout: 10000 }, async () => {
  const unregistered = "https://example.invalid/callback";
  const response = await authorize({ redirect_uri: unregistered });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
  // oidc-provider 9.12.2 renders the stable error code in its default HTML error page.
  assert.match(await response.text(), /<strong>error<\/strong>:\s*invalid_redirect_uri\b/);
});

test("O1 accepts a valid S256 request up to interaction, without issuing a code", { timeout: 10000 }, async () => {
  const response = await authorize();
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.ok(location);
  const destination = new URL(location, authorizationEndpoint);
  assert.equal(destination.origin, new URL(authorizationEndpoint).origin);
  assert.match(destination.pathname, /^\/interaction\/[^/]+$/);
  assert.equal(destination.searchParams.has("code"), false);
  assert.equal(destination.searchParams.has("error"), false);
  assert.notEqual(destination.origin + destination.pathname, redirectUri);
});
