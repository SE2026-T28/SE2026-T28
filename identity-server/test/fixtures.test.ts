import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getPrisma } from "../src/db/prisma.js";
import { createIntegrationTestContext, createUserFixtures, withUserFixtures } from "./helpers.js";
import { createFixtureScope } from "./fixture-scope.js";

let context: Awaited<ReturnType<typeof createIntegrationTestContext>>;
before(async () => { context = await createIntegrationTestContext(); });
after(async () => { await context?.close(); });

async function register(email: string): Promise<void> {
  const response = await fetch(`${context.baseUrl}/api/users/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Fixture-Test-Only-123!" }),
  });
  assert.equal(response.status, 201);
}

test("FIXTURE-01: independent runs never delete each other's records; cleanup is idempotent", async () => {
  const first = createUserFixtures();
  const second = createUserFixtures();
  const a = first.email();
  const b = second.email();
  assert.notEqual(a, b);
  try {
    await Promise.all([first.track(() => register(a)), second.track(() => register(b))]);
    await first.cleanup();
    assert.equal(await getPrisma().user.count({ where: { email: a } }), 0);
    assert.equal(await getPrisma().user.count({ where: { email: b } }), 1);
    await first.cleanup();
    assert.equal(await getPrisma().user.count({ where: { email: b } }), 1);
  } finally {
    try { await first.cleanup(); } finally { await second.cleanup(); }
  }
  assert.equal(await getPrisma().user.count({ where: { email: { in: [a, b] } } }), 0);
});

test("FIXTURE-02: finally cleans fixtures after an assertion failure following registration", async () => {
  let email = "";
  await assert.rejects(withUserFixtures(async fixtures => {
    email = fixtures.email();
    await fixtures.track(() => register(email));
    assert.fail("simulated failure after successful registration");
  }), /simulated failure/);
  assert.equal(await getPrisma().user.count({ where: { email } }), 0);
});

test("FIXTURE-03: allocation/new work cannot race with cleanup; concurrent cleanup joins one deletion", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deletions: string[][] = [];
  const fixtures = createFixtureScope(async emails => { deletions.push(emails); await gate; });
  const owned = fixtures.email();
  const first = fixtures.cleanup();
  assert.equal(fixtures.cleanup(), first);
  assert.throws(() => fixtures.email(), /closing or closed/);
  assert.throws(() => fixtures.track(async () => {}), /closing or closed/);
  release();
  await first;
  assert.deepEqual(deletions, [[owned]]);
  assert.throws(() => fixtures.email(), /closing or closed/);
});

test("FIXTURE-04: cleanup drains a delayed registration that writes then fails, preserving another scope", async () => {
  const fixtures = createUserFixtures();
  const canary = createUserFixtures();
  const owned = fixtures.email();
  const other = canary.email();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await canary.track(() => register(other));
    const failure = assert.rejects(fixtures.track(async () => {
      await gate;
      await register(owned);
      throw new Error("simulated failure after delayed INSERT");
    }), /simulated failure/);
    const closing = fixtures.cleanup();
    release();
    await failure;
    await closing;
    assert.equal(await getPrisma().user.count({ where: { email: owned } }), 0);
    assert.equal(await getPrisma().user.count({ where: { email: other } }), 1);
  } finally {
    release();
    try { await fixtures.cleanup(); } finally { await canary.cleanup(); }
  }
});

test("FIXTURE-05: deletion failure preserves the owned snapshot for a safe retry", async () => {
  const snapshots: string[][] = [];
  const fixtures = createFixtureScope(async emails => {
    snapshots.push(emails);
    if (snapshots.length === 1) throw new Error("simulated cleanup failure");
  });
  const owned = fixtures.email();
  await assert.rejects(fixtures.cleanup(), /simulated cleanup failure/);
  assert.throws(() => fixtures.email(), /closing or closed/);
  await fixtures.cleanup();
  assert.deepEqual(snapshots, [[owned], [owned]]);
});
