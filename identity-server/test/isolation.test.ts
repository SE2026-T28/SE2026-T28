import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertManagedDatabase, readManagedSession, runtimeRoot } from "../scripts/test-database.mjs";

test("ISOLATION-01: managed instance is live; missing, wrong-capability, wrong-target and wrong-system-id proofs fail", () => {
  const actual = readManagedSession();
  assert.equal(new URL(assertManagedDatabase()).pathname, "/app04_test");
  const env = { ...process.env };
  assert.throws(() => assertManagedDatabase({ ...env, S3_DATABASE_MANIFEST: undefined, S3_TEST_DATABASE_ISOLATED: "1" }), /S3 database safety/);
  assert.throws(() => assertManagedDatabase({ ...env, S3_DATABASE_CAPABILITY: "wrong" }), /S3 database safety/);
  assert.throws(() => assertManagedDatabase({ ...env, DATABASE_URL: "postgresql://localhost/app04" }), /S3 database safety/);
  const directory = mkdtempSync(join(runtimeRoot, "negative-proof-"));
  const file = join(directory, "session.json");
  try {
    writeFileSync(file, JSON.stringify({ ...actual, systemIdentifier: "0" }), { mode: 0o600 });
    assert.throws(() => assertManagedDatabase({ ...env, S3_DATABASE_MANIFEST: file }), /identity verification failed/);
    writeFileSync(file, JSON.stringify({ ...actual, schemaHash: "wrong" }), { mode: 0o600 });
    assert.throws(() => assertManagedDatabase({ ...env, S3_DATABASE_MANIFEST: file }), /S3 database safety/);
  } finally { unlinkSync(file); rmdirSync(directory); }
});
