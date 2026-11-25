import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  const testKey = "c".repeat(64);
  const adapter = new PostgresOidcAdapter("AuthorizationCode", testKey);
  const related = new PostgresOidcAdapter("AccessToken", testKey);
  const grant = new PostgresOidcAdapter("Grant", testKey);
  try {
    await grant.upsert(grantId, { jti: grantId, kind: "Grant" }, 60);
    await adapter.upsert(id, { jti: id, uid, userCode, grantId, kind: "AuthorizationCode" }, 60);
    assert.equal(await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id } } }), null);
    const hashed = createHash("sha256").update(id).digest("hex");
    const stored = await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id: hashed } } });
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(id), "Database row must not expose the bearer value");
    assert.ok(!JSON.stringify(stored).includes(uid), "Indexed identifiers must not be stored raw");
    assert.equal((await new PostgresOidcAdapter("AuthorizationCode", testKey).find(id))?.jti, id);
    const childCheck = `import { PostgresOidcAdapter } from './dist/src/oidc/postgres-adapter.js';
      import { disconnectPrisma } from './dist/src/db/prisma.js';
      try { const result = await new PostgresOidcAdapter('AuthorizationCode', process.env.TEST_OIDC_KEY).find(process.env.TEST_OIDC_ID); if (result?.jti !== process.env.TEST_OIDC_ID) process.exitCode = 1; }
      finally { await disconnectPrisma(); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", childCheck], {
      env: { ...process.env, TEST_OIDC_KEY: testKey, TEST_OIDC_ID: id },
      stdio: "pipe", timeout: 10_000,
    });
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
    assert.equal(await grant.find(grantId), undefined, "Revoked grant must not remain findable");
    // Refresh can finish consuming the old token before revocation, then try
    // to persist its successor afterwards. The revocation fence must win.
    await assert.rejects(related.upsert(`${id}-late-at`, { jti: `${id}-late-at`, grantId, kind: "AccessToken" }, 60), { error: "invalid_grant" });
    assert.equal(await related.find(`${id}-late-at`), undefined);
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
    assert.ok(await getPrisma().oidcRevokedGrant.findUnique({ where: { id: createHash("sha256").update(grantId).digest("hex") } }),
      "Artifact cleanup must preserve the revocation fence");
  } finally {
    await adapter.destroy(id);
    await related.destroy(`${id}-at`);
    await related.destroy(`${id}-late-at`);
    await related.destroy(`${id}-racing-at`);
    await grant.destroy(grantId);
    await disconnectPrisma();
  }
});
