import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertManagedDatabase } from "../scripts/test-database.mjs";
import { recordAuditEvent } from "../src/audit/service.js";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";

test("S3 audit scope ownership and client reconnection", async t => {
  assertManagedDatabase();
  const first = randomUUID();
  const second = randomUUID();
  const actorId = randomUUID();
  let db = getPrisma();
  const rows = (correlationId: string) => db.auditEvent.findMany({ where: { correlationId }, select: { id: true, metadata: true } });
  const ids = (records: Array<{ id: string }>) => JSON.stringify(records.map(row => row.id).sort());
  let secondIds = "";
  try {
    await t.test("S3-31 parallel writes and exact audit cleanup", async () => {
      const results = await Promise.all([first, second].flatMap(correlationId => Array.from({ length: 8 }, () =>
        recordAuditEvent({ eventType: "login.success", outcome: "success", actorId, correlationId,
          clientId: "app04-react-demo", metadata: { attemptCount: 1 } }))));
      assert.ok(results.every(result => result.ok), "Concurrent audit write failed");
      const [a, b] = await Promise.all([rows(first), rows(second)]);
      assert.equal(a.length, 8);
      assert.equal(b.length, 8);
      assert.equal(new Set([...a, ...b].map(row => row.id)).size, 16);
      secondIds = ids(b);
      await db.auditEvent.deleteMany({ where: { correlationId: first } });
      assert.equal((await rows(first)).length, 0);
      assert.ok(ids(await rows(second)) === secondIds, "Other audit scope was modified by cleanup");
    });
    await t.test("S3-32 audit survives Prisma client reconnection", async () => {
      await disconnectPrisma();
      db = getPrisma();
      const persisted = await rows(second);
      assert.equal(persisted.length, 8);
      assert.ok(ids(persisted) === secondIds, "Audit rows changed on reconnect");
      assert.ok(persisted.every(row => JSON.stringify(row.metadata) === '{"attemptCount":1}'));
      t.diagnostic("S3-32: auditRows=8 sameIds=true providerRestartTested=false");
    });
  } finally {
    try {
      await db.auditEvent.deleteMany({ where: { correlationId: { in: [first, second] } } });
      assert.equal(await db.auditEvent.count({ where: { correlationId: { in: [first, second] } } }), 0);
    } finally { await disconnectPrisma(); }
  }
});
