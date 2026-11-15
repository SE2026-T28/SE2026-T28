import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertTestDatabase, assertManagedDatabase, lockedConfig } from "../scripts/test-database.mjs";
import { prismaPlan, configDatasource } from "../scripts/prisma-policy.mjs";

const valid = { DATABASE_URL: "postgresql://test-user@127.0.0.1:5432/app04_test?schema=public", S3_TEST_DATABASE_ISOLATED: "1", NODE_ENV: "test" };

test("DB-SAFE-01: URL policy accepts loopback app04_test but does not certify isolation", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    for (const protocol of ["postgres", "postgresql"]) {
      assert.equal(new URL(assertTestDatabase({ ...valid, DATABASE_URL: `${protocol}://test-user@${host}:5432/app04_test` })).pathname, "/app04_test");
    }
  }
});

test("DB-SAFE-02: refuses unsafe names, hosts, overrides and production without leaking the URL", () => {
  const urls = [undefined, "", "not-a-url", "https://localhost/app04_test",
    "postgresql://localhost/app04", "postgresql://localhost/app04_production", "postgresql://localhost/other_test",
    "postgresql://localhost/test", "postgresql://localhost/APP04_TEST", "postgresql://localhost/app04_test/",
    "postgresql://localhost/%61pp04_test", "postgresql://db.example.test/app04_test",
    "postgresql://localhost.example.test/app04_test", "postgresql://localhost/app04_test#fragment",
    "postgresql://localhost/app04_test?host=db.example.test", "postgresql://localhost/app04_test?dbname=app04",
    "postgresql://localhost/app04_test?options=-csearch_path=private", "postgresql://localhost/app04_test?schema=private",
    "postgresql://localhost/app04_test?schema=public&schema=public"];
  for (const DATABASE_URL of urls) {
    assert.throws(() => assertTestDatabase({ ...valid, DATABASE_URL }), /^Error: S3 database safety:/);
  }
  assert.throws(() => assertManagedDatabase({ ...valid, S3_TEST_DATABASE_ISOLATED: undefined }), /S3 database safety/);
  assert.throws(() => assertManagedDatabase(valid), /S3 database safety/); // even flag=1 is not proof
  assert.throws(() => assertTestDatabase({ ...valid, NODE_ENV: "production" }), /S3 database safety/);
  const raw = "postgresql://test-user:do-not-print-this@localhost/app04";
  assert.throws(() => assertTestDatabase({ ...valid, DATABASE_URL: raw }), error => {
    assert.match(String(error), /S3 database safety/);
    assert.doesNotMatch(String(error), /do-not-print-this|postgresql:\/\//);
    return true;
  });
});

test("DB-SAFE-03: pre-migration command refuses unsafe configuration before database work", () => {
  for (const env of [{ ...valid, DATABASE_URL: "postgresql://localhost:1/app04" }, { ...valid, S3_TEST_DATABASE_ISOLATED: "" }]) {
    const result = spawnSync(process.execPath, [resolve("scripts/check-test-database.mjs")], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No database operation was started/);
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\//);
  }
});

test("DB-SAFE-04: direct Prisma migrate deploy also refuses unsafe database in config", { timeout: 30000 }, () => {
  const result = spawnSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, ...valid, DATABASE_URL: "postgresql://localhost:1/app04" }, encoding: "utf8", timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /S3 (database safety|Prisma policy)/);
  assert.doesNotMatch(result.stdout + result.stderr, /Applying migration|P1001|postgresql:\/\//);
});

test("DB-SAFE-05: controlled Prisma plans lock config and reject every target override", () => {
  for (const operation of ["generate", "deploy", "status", "dev"]) {
    for (const args of [["--config", "other.ts"], ["--config=other.ts"], ["--schema", "other.prisma"],
      ["--url", "postgresql://localhost/app04"], ["--", "--config", "other.ts"], ["--force-reset"]]) {
      assert.throws(() => prismaPlan(operation, args), /override or unknown arguments/);
    }
    assert.deepEqual(prismaPlan(operation).slice(-2), ["--config", lockedConfig]);
  }
  for (const operation of ["push", "execute", "seed", "reset", "unknown"]) assert.throws(() => prismaPlan(operation), /not supported/);
  assert.throws(() => configDatasource(["migrate", "deploy", "--config", "other.ts"], { S3_PRISMA_OPERATION: "deploy" }), /differ from locked plan/);
  assert.throws(() => configDatasource(prismaPlan("dev"), { S3_PRISMA_OPERATION: "dev", S3_DATABASE_MANIFEST: "untrusted" }), /shadow database/);
});

test("DB-SAFE-06: wrapper overrides and direct db push/execute fail before any engine write", { timeout: 60000 }, () => {
  const env = { ...process.env, ...valid, S3_PRISMA_OPERATION: "", S3_DATABASE_MANIFEST: "", S3_DATABASE_CAPABILITY: "", APP04_ALLOW_DEV_MIGRATIONS: "" };
  for (const args of [["deploy", "--config", "other.ts"], ["deploy", "--schema=other.prisma"], ["execute"], ["push"]]) {
    const result = spawnSync(process.execPath, [resolve("scripts/prisma-command.mjs"), ...args], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No Prisma operation was started/);
  }
  for (const args of [["db", "push"], ["db", "execute", "--stdin"]]) {
    const result = spawnSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), ...args], { env, encoding: "utf8", timeout: 20000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /controlled npm database commands/);
    assert.doesNotMatch(result.stdout + result.stderr, /P1001|Script executed|Applying migration/);
  }
});

test("DB-SAFE-07: development workflow is explicit, local app04 only; no development connection is made", () => {
  const args = prismaPlan("dev", ["--name", "example_change"]);
  const env = { S3_PRISMA_OPERATION: "dev", DATABASE_URL: "postgresql://localhost/app04", APP04_ALLOW_DEV_MIGRATIONS: "1" };
  assert.equal(new URL(configDatasource(args, env)).pathname, "/app04");
  assert.throws(() => configDatasource(args, { ...env, APP04_ALLOW_DEV_MIGRATIONS: undefined }), /opt-in required/);
  assert.throws(() => configDatasource(args, { ...env, NODE_ENV: "production" }), /opt-in required/);
  for (const DATABASE_URL of ["postgresql://remote.example.test/app04", "postgresql://localhost/production", "postgresql://localhost/app04_test"]) {
    assert.throws(() => configDatasource(args, { ...env, DATABASE_URL }));
  }
});
