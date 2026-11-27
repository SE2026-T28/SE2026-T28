import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { completeLoginWithAudit, createInteractionAudit } from "../src/audit/interaction-events.js";
import type { AuditEventInput } from "../src/audit/service.js";

test("login and MFA audit share a correlation without treating MFA as completed login", async () => {
  const events: AuditEventInput[] = [];
  const audit = createInteractionAudit("app04-react-demo", async event => {
    events.push(event);
    return { ok: true, eventId: randomUUID() };
  });
  const actorId = randomUUID();
  const uid = "interaction-opaque-uid";
  audit.loginFailure(uid);
  audit.mfa({ eventType: "MFA_VERIFICATION_FAILED", outcome: "FAILURE", actorUserId: actorId,
    occurredAt: new Date().toISOString() }, uid);
  audit.mfa({ eventType: "MFA_VERIFICATION_SUCCESS", outcome: "SUCCESS", actorUserId: actorId,
    occurredAt: new Date().toISOString() }, uid);
  await audit.drain();
  assert.deepEqual(events.map(event => event.eventType), ["login.failure", "mfa.failure", "mfa.success"]);
  assert.equal(new Set(events.map(event => event.correlationId)).size, 1);
  assert.ok(events.every(event => event.correlationId && event.clientId === "app04-react-demo"));
  audit.loginSuccess(uid, actorId); // Called only after Provider completion resolves.
  await audit.drain();
  assert.equal(events[3]?.eventType, "login.success");
  assert.equal(events[3]?.correlationId, events[0]?.correlationId);
  assert.ok(!JSON.stringify(events).includes(uid));
});

test("audit storage failure cannot change a completed interaction", async () => {
  let failures = 0;
  const audit = createInteractionAudit("app04-react-demo", async () => ({ ok: false, error: "write_failed" }),
    () => { failures++; });
  assert.doesNotThrow(() => audit.loginSuccess("uid", randomUUID()));
  await audit.drain();
  assert.equal(failures, 1);
});

test("rejected Provider completion never writes login.success", async () => {
  const events: AuditEventInput[] = [];
  const audit = createInteractionAudit("app04-react-demo", async event => {
    events.push(event);
    return { ok: true, eventId: randomUUID() };
  });
  await assert.rejects(completeLoginWithAudit(async () => {
    throw new Error("Provider handoff failed");
  }, audit, "uid", randomUUID()));
  await audit.drain();
  assert.deepEqual(events, []);
});

test("background MFA expiry records a failure without an interaction UID", async () => {
  const events: AuditEventInput[] = [];
  const audit = createInteractionAudit("app04-react-demo", async event => {
    events.push(event);
    return { ok: true, eventId: randomUUID() };
  });
  const actorId = randomUUID();
  audit.mfa({ eventType: "MFA_CHALLENGE_EXPIRED", outcome: "EXPIRED", actorUserId: actorId,
    occurredAt: new Date().toISOString() });
  await audit.drain();
  assert.equal(events[0]?.eventType, "mfa.failure");
  assert.equal(events[0]?.actorId, actorId);
  assert.equal(events[0]?.reasonCode, "expired");
  assert.ok(events[0]?.correlationId);
});
