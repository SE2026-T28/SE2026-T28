import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { Provider } from "oidc-provider";
import { createIntegrationTestContext } from "./helpers.js";
import { getPrisma } from "../src/db/prisma.js";

test("S1 normal application mounts protected profile before Provider", async () => {
  const context = await createIntegrationTestContext();
  try {
    const response = await fetch(`${context.baseUrl}/api/protected/profile`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_token" });
  } finally { await context.close(); }
});

test("S1 opaque Provider models enforce token, Grant, account and redaction", async t => {
  const modulePath = "../src/resources/protected-profile.js";
  const { protectedProfileRouter } = await import(modulePath);
  const context = await createIntegrationTestContext();
  const issuer = context.baseUrl;
  const audience = `${issuer}/api`;
  const clientId = "app04-react-demo";
  const provider = new Provider(issuer, {
    clients: [clientId, "other-client"].map(client_id => ({
      client_id, token_endpoint_auth_method: "none", response_types: ["code"],
      grant_types: ["authorization_code"], redirect_uris: ["http://localhost:5173/callback"],
    })),
    features: { devInteractions: { enabled: false } },
  });
  const app = express();
  app.use("/api/protected", protectedProfileRouter(provider, "http://localhost:5173"));
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://localhost:${address.port}/api/protected/profile`;
  const artifacts: Array<{ destroy(): Promise<unknown> }> = [];
  try {
    const email = context.fixtures.email();
    const registration = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "S1-fixture-only-password" }),
    }));
    assert.equal(registration.status, 201);
    const { user } = await registration.json() as { user: { id: string } };
    const client = await provider.Client.find(clientId);
    assert.ok(client);
    const grant = new provider.Grant({ accountId: user.id, clientId });
    grant.addResourceScope(audience, "api:read");
    const grantId = await grant.save();
    artifacts.push(grant);
    const issue = async (overrides: Record<string, unknown> = {}) => {
      const token = new provider.AccessToken({ client, accountId: user.id, grantId,
        gty: "authorization_code", aud: audience, scope: "api:read", ...overrides });
      const raw = await token.save();
      artifacts.push(token);
      return { raw, token };
    };
    const valid = await issue();
    const request = (raw?: string, extra: Record<string, string> = {}) => fetch(url, {
      headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...extra },
    });
    const expectStatus = async (raw: string | undefined, status: number) => {
      const response = await request(raw);
      assert.equal(response.status, status, "S1 response status");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      if (status === 200) assert.deepEqual(JSON.parse(body), { sub: user.id });
      else assert.deepEqual(JSON.parse(body), { error: status === 403 ? "insufficient_scope" : "invalid_token" });
      assert.ok(!body.includes(email), "profile/errors omit email");
      assert.ok(!body.includes("passwordHash"), "profile/errors omit password hash");
      if (raw) assert.ok(!body.includes(raw), "response omits raw bearer");
    };
    await t.test("valid opaque token returns only account UUID", () => expectStatus(valid.raw, 200));
    await t.test("missing token", () => expectStatus(undefined, 401));
    await t.test("unknown token", () => expectStatus("unknown-s1-fixture", 401));
    await t.test("valid signed ID Token rejected as bearer", async () => {
      const idToken = new provider.IdToken({ sub: user.id }, { client });
      idToken.set("sub", user.id);
      const raw = await idToken.issue({ use: "idtoken" });
      await provider.IdToken.validate(raw, client);
      await expectStatus(raw, 401);
    });
    await t.test("wrong authentication scheme", async () => {
      assert.equal((await request(undefined, { authorization: `Basic ${valid.raw}` })).status, 401);
    });
    await t.test("query token never authenticates", async () => {
      assert.equal((await fetch(`${url}?access_token=fixture`)).status, 401);
    });
    for (const [name, overrides, status] of [
      ["expired token", { exp: Math.floor(Date.now() / 1000) - 120 }, 401],
      ["wrong audience", { aud: `${issuer}/other` }, 401],
      ["UserInfo token without API audience", { aud: undefined }, 401],
      ["multiple audiences", { aud: [audience, `${issuer}/other`] }, 401],
      ["missing Grant", { grantId: randomUUID() }, 401],
      ["missing account", { accountId: randomUUID() }, 401],
      ["scope substring is insufficient", { scope: "api:reader" }, 403],
      ["no API scope", { scope: "openid email" }, 403],
    ] as const) {
      await t.test(name, async () => expectStatus((await issue(overrides)).raw, status));
    }
    await t.test("wrong client", async () => {
      const other = await provider.Client.find("other-client");
      assert.ok(other);
      await expectStatus((await issue({ client: other })).raw, 401);
    });
    await t.test("Grant account mismatch", async () => {
      const other = new provider.Grant({ accountId: randomUUID(), clientId });
      artifacts.push(other);
      await expectStatus((await issue({ grantId: await other.save() })).raw, 401);
    });
    await t.test("Grant client mismatch", async () => {
      const other = new provider.Grant({ accountId: user.id, clientId: "other-client" });
      artifacts.push(other);
      await expectStatus((await issue({ grantId: await other.save() })).raw, 401);
    });
    await t.test("expired Grant", async () => {
      const expired = new provider.Grant({ accountId: user.id, clientId });
      artifacts.push(expired);
      expired.exp = Math.floor(Date.now() / 1000) - 120;
      await expectStatus((await issue({ grantId: await expired.save() })).raw, 401);
    });
    await t.test("Grant no longer authorizes API scope", async () => {
      const reduced = new provider.Grant({ accountId: user.id, clientId });
      artifacts.push(reduced);
      await expectStatus((await issue({ grantId: await reduced.save() })).raw, 403);
    });
    await t.test("revoked Access Token", async () => {
      const revoked = await issue();
      await expectStatus(revoked.raw, 200);
      await revoked.token.destroy();
      await expectStatus(revoked.raw, 401);
    });
    await t.test("revoked Grant invalidates still stored Access Token", async () => {
      const revoked = new provider.Grant({ accountId: user.id, clientId });
      revoked.addResourceScope(audience, "api:read");
      artifacts.push(revoked);
      const token = await issue({ grantId: await revoked.save() });
      await expectStatus(token.raw, 200);
      await revoked.destroy();
      await expectStatus(token.raw, 401);
    });
    await t.test("allowed React origin and Authorization preflight", async () => {
      const response = await request(valid.raw, { origin: "http://localhost:5173" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
      const preflight = await fetch(url, { method: "OPTIONS", headers: {
        origin: "http://localhost:5173", "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization");
      const foreign = await request(valid.raw, { origin: "http://evil.test" });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    });
    await t.test("dependency failure is redacted and never authorizes", async () => {
      const mock = t.mock.method(provider.AccessToken, "find", async () => {
        throw new Error(`private-dependency-detail ${valid.raw}`);
      });
      try {
        const response = await request(valid.raw);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "server_error" });
      } finally { mock.mock.restore(); }
    });
    await t.test("deleted account is rejected", async () => {
      await getPrisma().user.delete({ where: { id: user.id } });
      await expectStatus(valid.raw, 401);
    });
  } finally {
    try { for (const artifact of artifacts) await artifact.destroy(); }
    finally {
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { await context.close(); }
    }
  }
});
