import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertManagedDatabase } from "../scripts/test-database.mjs";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";
import { PostgresOidcAdapter } from "../src/oidc/postgres-adapter.js";

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
    assert.ok(await getPrisma().oidcArtifact.findUnique({ where: { model_id: { model: "AuthorizationCode", id: hashed } } }));
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
    await adapter.upsert(id, { jti: id, kind: "AuthorizationCode" }, 0);
    assert.equal(await adapter.find(id), undefined);
  } finally {
    await adapter.destroy(id);
    await related.destroy(`${id}-at`);
    await disconnectPrisma();
  }
});
