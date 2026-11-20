import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertManagedDatabase } from "../scripts/test-database.mjs";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";
import { PostgresOidcAdapter, cleanupExpiredOidcArtifacts } from "../src/oidc/postgres-adapter.js";

test("PostgreSQL adapter persists lookup, expiry, atomic consume and grant revocation", async () => {
  assertManagedDatabase();
  const id = randomUUID();
  const uid = randomUUID();
  const userCode = randomUUID();
  const grantId = randomUUID();
  const adapter = new PostgresOidcAdapter("AuthorizationCode");
  const related = new PostgresOidcAdapter("AccessToken");
  try {
    await adapter.upsert(id, { jti: id, uid, userCode, grantId, kind: "AuthorizationCode" }, 60);
    assert.equal(await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id } } }), null);
    const hashed = createHash("sha256").update(id).digest("hex");
    const stored = await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id: hashed } } });
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(id), "Database row must not expose the bearer value");
    assert.ok(!JSON.stringify(stored).includes(uid), "Indexed identifiers must not be stored raw");
    assert.equal((await new PostgresOidcAdapter("AuthorizationCode").find(id))?.jti, id);
    assert.equal((await adapter.findByUid(uid))?.jti, id);
    assert.equal((await adapter.findByUserCode(userCode))?.jti, id);
    const [first, second] = await Promise.allSettled([adapter.consume(id), adapter.consume(id)]);
    assert.equal([first, second].filter(result => result.status === "fulfilled").length, 1);
    assert.equal([first, second].filter(result => result.status === "rejected").length, 1);
    assert.equal(typeof (await adapter.find(id))?.consumed, "number");
    await related.upsert(`${id}-at`, { jti: `${id}-at`, grantId, kind: "AccessToken" }, 60);
    await Promise.all([adapter.revokeByGrantId(grantId), related.revokeByGrantId(grantId)]);
    assert.equal(await adapter.find(id), undefined);
    assert.equal(await related.find(`${id}-at`), undefined);
    // Refresh can finish consuming the old token before revocation, then try
    // to persist its successor afterwards. The revocation fence must win.
    await assert.rejects(related.upsert(`${id}-late-at`, { jti: `${id}-late-at`, grantId, kind: "AccessToken" }, 60), { error: "invalid_grant" });
    assert.equal(await related.find(`${id}-late-at`), undefined);
    const grant = new PostgresOidcAdapter("Grant");
    await assert.rejects(grant.upsert(grantId, { jti: grantId, kind: "Grant" }, 60), { error: "invalid_grant" });
    assert.equal(await grant.find(grantId), undefined);
    const racingGrant = randomUUID();
    const racingId = `${id}-racing-at`;
    const race = await Promise.allSettled([
      related.upsert(racingId, { jti: racingId, grantId: racingGrant, kind: "AccessToken" }, 60),
      adapter.revokeByGrantId(racingGrant),
    ]);
    assert.equal(race[1].status, "fulfilled");
    assert.equal(await related.find(racingId), undefined, "Concurrent upsert must not resurrect a revoked grant");
    await adapter.upsert(id, { jti: id, kind: "AuthorizationCode" }, -1);
    assert.equal(await adapter.find(id), undefined);
    assert.ok(await cleanupExpiredOidcArtifacts() >= 1);
    assert.equal(await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id: hashed } } }), null);
  } finally {
    await adapter.destroy(id);
    await related.destroy(`${id}-at`);
    await related.destroy(`${id}-late-at`);
    await related.destroy(`${id}-racing-at`);
    await disconnectPrisma();
  }
});
