import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAuditService, AUDIT_EVENT_TYPES, AUDIT_REASON_CODES, type AuditEventInput, type AuditRow } from "../src/audit/service.js";

test("S2 audit validates inputs before writes and never exposes sensitive data", async t => {
  const written: AuditRow[] = [];
  const audit = createAuditService(async row => { written.push(row); });
  // Deliberate boundary for hostile runtime input; valid cases use the typed recorder.
  const auditUnchecked = (input: unknown) => audit(input as AuditEventInput);
  const base = { eventType: "login.failure", outcome: "failure", reasonCode: "invalid_credentials" } as const;
  await t.test("callers cannot extend the runtime allowlists", () => {
    assert.throws(() => Reflect.apply(Array.prototype.push, AUDIT_EVENT_TYPES, ["unknown"]), TypeError);
    assert.throws(() => Reflect.apply(Array.prototype.push, AUDIT_REASON_CODES, ["fixture-secret"]), TypeError);
  });

  for (const event of [
    { eventType: "login.success", outcome: "success", metadata: { attemptCount: 0 } },
    { eventType: "login.failure", outcome: "failure", metadata: { attemptCount: 3 } },
    { eventType: "mfa.success", outcome: "success", metadata: { mfaMethod: "mock", attemptCount: 1 } },
    { eventType: "mfa.failure", outcome: "failure", metadata: { mfaMethod: "mock", attemptCount: 2 } },
    { eventType: "token.issued", outcome: "success", metadata: { tokenType: "access_token", grantType: "authorization_code", scopes: ["api:read"] } },
    { eventType: "token.revoked", outcome: "success", metadata: { tokenType: "refresh_token", revocationConfirmed: true } },
    { eventType: "logout.completed", outcome: "success", metadata: { sessionEnded: true } },
  ] as const satisfies readonly AuditEventInput[]) {
    const { eventType, metadata } = event;
    await t.test(`accepts ${eventType}`, async () => {
      const actorId = randomUUID();
      const correlationId = randomUUID();
      const result = await audit({ ...event, actorId, correlationId, clientId: "app04-react-demo" });
      assert.equal(result.ok, true);
      const row = written.at(-1)!;
      assert.equal(row.id, result.eventId);
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.equal(row.actorId, actorId);
      assert.equal(row.correlationId, correlationId);
      assert.deepEqual(row.metadata, metadata);
      assert.ok(row.occurredAt instanceof Date);
    });
  }
  await t.test("nullable fields and empty metadata", async () => {
    assert.equal((await audit({ ...base, actorId: null, clientId: null, correlationId: null, reasonCode: null })).ok, true);
    const row = written.at(-1)!;
    assert.equal(row.actorId, null);
    assert.equal(row.clientId, null);
    assert.equal(row.correlationId, null);
    assert.equal(row.reasonCode, null);
    assert.deepEqual(row.metadata, {});
  });
  await t.test("revocation failure records no successful revocation", async () => {
    assert.equal((await audit({ eventType: "token.revoked", outcome: "failure", reasonCode: "invalid_token",
      metadata: { tokenType: "refresh_token", revocationConfirmed: false } })).ok, true);
    assert.deepEqual(written.at(-1)!.metadata, { tokenType: "refresh_token", revocationConfirmed: false });
  });
  for (const key of ["password", "otp", "authorizationCode", "access_token", "refresh_token", "cookie", "Authorization", "secret", "__proto__", "constructor", "prototype"]) {
    for (const target of ["event", "metadata"] as const) {
      await t.test(`rejects non-enumerable ${target} key ${key}`, async () => {
        const metadata = {};
        const input = { ...base, metadata };
        Object.defineProperty(target === "event" ? input : metadata, key, { value: "fixture-sensitive", enumerable: false });
        const before = written.length;
        assert.deepEqual(await audit(input), { ok: false, error: "invalid_event" });
        assert.equal(written.length, before);
      });
    }
  }
  for (const target of ["event", "metadata"] as const) {
    await t.test(`rejects ${target} Symbol keys`, async () => {
      const metadata = {};
      const input = { ...base, metadata };
      Object.defineProperty(target === "event" ? input : metadata, Symbol("sensitive"), { value: "fixture-sensitive" });
      const before = written.length;
      assert.deepEqual(await audit(input), { ok: false, error: "invalid_event" });
      assert.equal(written.length, before);
    });
    await t.test(`rejects ${target} accessors without invoking them`, async () => {
      let reads = 0;
      const metadata = {};
      const input = { ...base, metadata };
      Object.defineProperty(target === "event" ? input : metadata, target === "event" ? "actorId" : "attemptCount", {
        get: () => { reads++; return "fixture-sensitive"; }, enumerable: false,
      });
      const before = written.length;
      assert.deepEqual(await audit(input), { ok: false, error: "invalid_event" });
      assert.equal(reads, 0);
      assert.equal(written.length, before);
    });
  }
  await t.test("copies validated non-enumerable allowed data properties", async () => {
    const metadata = {};
    Object.defineProperty(metadata, "attemptCount", { value: 2, enumerable: false });
    assert.equal((await audit({ ...base, metadata })).ok, true);
    assert.deepEqual(written.at(-1)!.metadata, { attemptCount: 2 });
  });
  for (const key of ["password", Symbol("sensitive")]) {
    await t.test(`rejects hidden scope-array key ${String(key)}`, async () => {
      const scopes = ["api:read"];
      Object.defineProperty(scopes, key, { value: "fixture-sensitive", enumerable: false });
      const before = written.length;
      assert.deepEqual(await auditUnchecked({ eventType: "token.issued", outcome: "success", metadata: { scopes } }),
        { ok: false, error: "invalid_event" });
      assert.equal(written.length, before);
    });
  }
  await t.test("rejects scope-array prototype pollution", async () => {
    const scopes = ["api:read"];
    Object.setPrototypeOf(scopes, { password: "fixture-sensitive" });
    const before = written.length;
    assert.deepEqual(await auditUnchecked({ eventType: "token.issued", outcome: "success", metadata: { scopes } }),
      { ok: false, error: "invalid_event" });
    assert.equal(written.length, before);
  });
  await t.test("rejects inherited prototype pollution and keeps Object.prototype clean", async () => {
    const before = written.length;
    const polluted = Object.create({ password: "fixture-sensitive" });
    assert.deepEqual(await audit({ ...base, metadata: polluted }), { ok: false, error: "invalid_event" });
    assert.deepEqual(await audit(Object.assign(Object.create({ secret: "fixture-sensitive" }), base)),
      { ok: false, error: "invalid_event" });
    assert.equal(written.length, before);
    assert.equal(Object.hasOwn(Object.prototype, "password"), false);
    assert.equal(Object.hasOwn(Object.prototype, "secret"), false);
  });

  const invalid: Array<[string, unknown]> = [
    ["null input", null], ["array input", []], ["class instance", new Date()],
    ["unknown event", { ...base, eventType: "token.secret" }],
    ["oversized event", { ...base, eventType: "a".repeat(10000) }],
    ["unknown outcome", { ...base, outcome: "pending" }],
    ["mismatched outcome", { ...base, outcome: "success" }],
    ["invalid actor", { ...base, actorId: "not-uuid" }],
    ["oversized actor", { ...base, actorId: "a".repeat(10000) }],
    ["numeric actor", { ...base, actorId: 1 }],
    ["invalid correlation", { ...base, correlationId: "opaque-secret-like-value" }],
    ["oversized correlation", { ...base, correlationId: "a".repeat(10000) }],
    ["unknown client", { ...base, clientId: "other-client" }],
    ["oversized client", { ...base, clientId: "a".repeat(10000) }],
    ["unknown reason", { ...base, reasonCode: "database message with secret" }],
    ["oversized reason", { ...base, reasonCode: "a".repeat(10000) }],
    ["caller timestamp", { ...base, occurredAt: new Date() }],
    ["caller id", { ...base, id: randomUUID() }],
    ["array metadata", { ...base, metadata: [] }],
    ["null metadata", { ...base, metadata: null }],
    ["wrong event metadata", { ...base, metadata: { tokenType: "access_token" } }],
    ["nested metadata", { ...base, metadata: { attemptCount: { password: "fixture-secret" } } }],
    ["sensitive non-enumerable allowed field", { ...base, metadata: Object.defineProperty({}, "attemptCount", { value: "fixture-sensitive", enumerable: false }) }],
    ["bad attempt count", { ...base, metadata: { attemptCount: -1 } }],
    ["fractional attempts", { ...base, metadata: { attemptCount: 1.5 } }],
    ["excessive attempts", { ...base, metadata: { attemptCount: 21 } }],
    ["nonfinite attempts", { ...base, metadata: { attemptCount: Infinity } }],
    ["prototype key", { ...base, metadata: JSON.parse('{"__proto__":{"password":"fixture"}}') }],
    ["oversized metadata", { ...base, metadata: { attemptCount: "a".repeat(10000) } }],
    ["invalid token kind", { eventType: "token.issued", outcome: "success", metadata: { tokenType: "secret" } }],
    ["invalid grant", { eventType: "token.issued", outcome: "success", metadata: { grantType: "password" } }],
    ["unknown scopes", { eventType: "token.issued", outcome: "success", metadata: { scopes: ["secret"] } }],
    ["scope string", { eventType: "token.issued", outcome: "success", metadata: { scopes: "api:read" } }],
    ["duplicate scopes", { eventType: "token.issued", outcome: "success", metadata: { scopes: ["api:read", "api:read"] } }],
    ["wrong boolean", { eventType: "token.revoked", outcome: "success", metadata: { revocationConfirmed: "true" } }],
    ["unconfirmed success", { eventType: "token.revoked", outcome: "success", metadata: { revocationConfirmed: false } }],
    ["false revocation on failure", { eventType: "token.revoked", outcome: "failure", metadata: { revocationConfirmed: true } }],
    ["ID Token revocation", { eventType: "token.revoked", outcome: "success", metadata: { tokenType: "id_token" } }],
    ["logout failure", { eventType: "logout.completed", outcome: "failure" }],
    ["logout revocation inference", { eventType: "logout.completed", outcome: "success", metadata: { revocationConfirmed: true } }],
    ["invalid MFA method", { eventType: "mfa.failure", outcome: "failure", metadata: { mfaMethod: "secret-otp" } }],
  ];
  for (const key of ["password", "otp", "authorizationCode", "access_token", "refresh_token", "cookie", "Authorization", "secret", "message", "url"]) {
    invalid.push([`sensitive metadata ${key}`, { ...base, metadata: { [key]: "fixture-secret" } }]);
    invalid.push([`sensitive top-level ${key}`, { ...base, [key]: "fixture-secret" }]);
  }
  for (const [name, input] of invalid) await t.test(`rejects ${name} without writing`, async () => {
    const before = written.length;
    assert.deepEqual(await auditUnchecked(input), { ok: false, error: "invalid_event" });
    assert.equal(written.length, before);
  });
  await t.test("metadata copied before asynchronous persistence", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let saved: AuditRow | undefined;
    const delayed = createAuditService(async row => { await gate; saved = row; });
    const metadata = { scopes: ["api:read"] };
    const pending = delayed({ eventType: "token.issued", outcome: "success", metadata } as AuditEventInput);
    metadata.scopes[0] = "fixture-secret";
    release();
    assert.equal((await pending).ok, true);
    assert.deepEqual(saved!.metadata, { scopes: ["api:read"] });
  });
  await t.test("scope accessors cannot change values between validation and persistence", async () => {
    let reads = 0;
    const scopes: string[] = [];
    Object.defineProperty(scopes, "0", { enumerable: true, get: () => ++reads === 1 ? "api:read" : "fixture-secret" });
    const before = written.length;
    assert.deepEqual(await auditUnchecked({ eventType: "token.issued", outcome: "success", metadata: { scopes } }),
      { ok: false, error: "invalid_event" });
    assert.equal(reads, 0);
    assert.equal(written.length, before);
  });
  await t.test("writer failure returns fixed result and no console diagnostics", async () => {
    const calls: unknown[] = [];
    const logs = ["log", "warn", "error"] as const;
    const mocks = logs.map(key => t.mock.method(console, key, (...args: unknown[]) => { calls.push(args); }));
    try {
      const failing = createAuditService(async () => { throw new Error("fixture-secret database credentials"); });
      assert.deepEqual(await failing(base), { ok: false, error: "write_failed" });
      assert.deepEqual(calls, []);
    } finally { for (const mock of mocks) mock.mock.restore(); }
  });
});
