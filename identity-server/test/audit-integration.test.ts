import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getPrisma, disconnectPrisma } from "../src/db/prisma.js";
import { assertManagedDatabase } from "../scripts/test-database.mjs";
import { recordAuditEvent, createAuditService, type AuditEventInput } from "../src/audit/service.js";

test("S2 persists only validated audit events on owned PostgreSQL", async t => {
  assertManagedDatabase();
  const correlationId = randomUUID();
  const actorId = randomUUID();
  const db = getPrisma();
  const count = async () => {
    const [row] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM audit_events WHERE correlation_id = ${correlationId}`;
    return Number(row.count);
  };
  try {
    await t.test("insert and read seven event types, UUID and timestamptz", async () => {
      const before = Date.now();
      for (const event of [
        { eventType: "login.success", outcome: "success" },
        { eventType: "login.failure", outcome: "failure" },
        { eventType: "mfa.success", outcome: "success" },
        { eventType: "mfa.failure", outcome: "failure" },
        { eventType: "token.issued", outcome: "success", metadata: { tokenType: "access_token", grantType: "authorization_code", scopes: ["api:read"] } },
        { eventType: "token.revoked", outcome: "success" },
        { eventType: "logout.completed", outcome: "success" },
      ] as const satisfies readonly AuditEventInput[]) {
        assert.equal((await recordAuditEvent({ ...event, actorId: event.eventType === "login.failure" ? null : actorId,
          correlationId, clientId: "app04-react-demo", reasonCode: event.eventType === "login.failure" ? "invalid_credentials" : null,
        })).ok, true);
      }
      const rows = await db.$queryRaw<Array<{ id: string; event_type: string; outcome: string; actor_id: string | null;
        client_id: string; reason_code: string | null; occurred_at: Date; metadata: unknown }>>`
        SELECT id, event_type, outcome, actor_id, client_id, reason_code, occurred_at, metadata
        FROM audit_events WHERE correlation_id = ${correlationId}`;
      assert.equal(rows.length, 7);
      assert.equal(new Set(rows.map(row => row.id)).size, 7);
      assert.deepEqual(rows.map(row => row.event_type).sort(),
        ["login.success", "login.failure", "mfa.success", "mfa.failure", "token.issued", "token.revoked", "logout.completed"].sort());
      for (const row of rows) {
        assert.match(row.id, /^[0-9a-f-]{36}$/);
        assert.equal(row.actor_id, row.event_type === "login.failure" ? null : actorId);
        assert.equal(row.client_id, "app04-react-demo");
        assert.equal(row.reason_code, row.event_type === "login.failure" ? "invalid_credentials" : null);
        assert.equal(row.outcome, row.event_type.endsWith("failure") ? "failure" : "success");
        assert.ok(row.occurred_at.getTime() >= before && row.occurred_at.getTime() <= Date.now());
        assert.deepEqual(row.metadata, row.event_type === "token.issued"
          ? { tokenType: "access_token", grantType: "authorization_code", scopes: ["api:read"] } : {});
      }
    });
    await t.test("sensitive inputs never reach audit storage", async () => {
      const before = await count();
      const input: unknown = { eventType: "login.failure", outcome: "failure", correlationId,
        metadata: { password: "fixture-secret", otp: "fixture-secret", Authorization: "Bearer fixture-secret" } };
      const result = await recordAuditEvent(input as AuditEventInput);
      assert.deepEqual(result, { ok: false, error: "invalid_event" });
      assert.equal(await count(), before);
      const rows = await db.$queryRaw<Array<{ clean: boolean }>>`
        SELECT bool_and(metadata::text NOT LIKE '%fixture-secret%') AS clean FROM audit_events WHERE correlation_id = ${correlationId}`;
      assert.equal(rows[0].clean, true);
    });
    await t.test("database enforces event/outcome/object constraints", async () => {
      for (const [eventType, outcome, metadata] of [["unknown", "success", "{}"], ["login.success", "pending", "{}"],
        ["login.success", "success", "[]"], ["login.success", "success", '{"password":"fixture-sensitive"}']]) {
        const id = randomUUID();
        await assert.rejects(db.$executeRaw`INSERT INTO audit_events (id, event_type, outcome, correlation_id, metadata)
          VALUES (${id}::uuid, ${eventType}, ${outcome}, ${correlationId}, ${metadata}::jsonb)`);
      }
      assert.equal(await count(), 7);
    });
    await t.test("real database failure is controlled", async () => {
      const audit = createAuditService(async () => { await db.$executeRaw`SELECT 1 / 0`; });
      assert.deepEqual(await audit({ eventType: "token.issued", outcome: "failure", reasonCode: "internal_error" }),
        { ok: false, error: "write_failed" });
      assert.equal(await count(), 7);
    });
  } finally {
    try {
      await db.$executeRaw`DELETE FROM audit_events WHERE correlation_id = ${correlationId}`;
      assert.equal(await count(), 0);
    } finally { await disconnectPrisma(); }
  }
});
