import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Provider } from "oidc-provider";
import { registerOidcAudit } from "../src/audit/oidc-events.js";
import type { AuditEventInput } from "../src/audit/service.js";

test("Provider audit hooks map completed operations to safe events", async () => {
  const provider = new EventEmitter() as unknown as Provider;
  const actorId = randomUUID();
  const events: AuditEventInput[] = [];
  const hook = registerOidcAudit(provider, "app04-react-demo", async event => {
    events.push(event);
    return { ok: true, eventId: randomUUID() };
  });
  const rawToken = "secret-test-token-must-not-be-recorded";
  provider.emit("grant.success", { oidc: {
    entities: { AccessToken: { accountId: actorId, scope: "openid api:read", rawToken } },
    params: { grant_type: "authorization_code" },
  } });
  provider.emit("grant.revoked", { oidc: {
    entities: { RefreshToken: { accountId: actorId, rawToken } }, params: {},
  } });
  provider.emit("end_session.success", { oidc: {
    entities: { Session: { accountId: actorId } }, params: { logout: "yes" },
  } });
  await hook.drain();
  assert.deepEqual(events.map(event => event.eventType), ["token.issued", "token.revoked", "logout.completed"]);
  assert.ok(events.every(event => event.actorId === actorId && event.clientId === "app04-react-demo" && event.correlationId));
  assert.deepEqual(events[0]?.metadata, {
    tokenType: "access_token", grantType: "authorization_code", scopes: ["openid", "api:read"],
  });
  assert.deepEqual(events[1]?.metadata, { tokenType: "refresh_token", revocationConfirmed: true });
  assert.deepEqual(events[2]?.metadata, { sessionEnded: true });
  assert.ok(!JSON.stringify(events).includes(rawToken));
});

test("audit persistence failure cannot alter an already completed Provider operation", async () => {
  const provider = new EventEmitter() as unknown as Provider;
  let failures = 0;
  const hook = registerOidcAudit(provider, "app04-react-demo", async () => {
    throw new Error("database-secret-detail");
  }, () => { failures++; });
  assert.equal(provider.emit("grant.success", { oidc: {
    entities: { AccessToken: { accountId: randomUUID(), scope: "api:read" } },
    params: { grant_type: "refresh_token" },
  } }), true);
  await hook.drain();
  assert.equal(failures, 1);
});
