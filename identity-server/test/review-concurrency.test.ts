import assert from "node:assert/strict";
import { test } from "node:test";
import { createBarrier, decide, deferred, makeItem, patch, snapshot, startApp } from "./review-helpers.js";

const V1 = "\"v1\"";

test("TC-08 two concurrent decisions on v1 -> one 200, one 412, version 2, winner recorded", { timeout: 10_000 }, async (t) => {
  const barrier = createBarrier(2);
  const app = await startApp(t, { beforeCommit: () => barrier.arrive() });
  const dataBefore = JSON.stringify(app.store.get("item-1")?.data);

  const [a, b] = await Promise.all([
    decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-a" }),
    decide(app, "reviewer2-token", "reject", { ifMatch: V1, key: "k-b" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 412]);
  const winner = a.status === 200 ? a : b;
  const final = app.store.get("item-1")!;
  assert.equal(final.version, 2);
  assert.deepEqual(final, winner.json.item);
  assert.equal(final.status, winner === a ? "approved" : "rejected");
  assert.equal(final.decidedBy, winner === a ? "reviewer-1" : "reviewer-2");
  assert.equal(JSON.stringify(final.data), dataBefore);
});

test("TC-09 sixty concurrent decisions on v1 -> 1x200, 59x412, version 2, single decidedBy", { timeout: 20_000 }, async (t) => {
  const barrier = createBarrier(60);
  const app = await startApp(t, { beforeCommit: () => barrier.arrive() });
  const dataBefore = JSON.stringify(app.store.get("item-1")?.data);

  const responses = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    decide(app, i % 2 === 0 ? "reviewer-token" : "reviewer2-token", i % 3 === 0 ? "reject" : "approve", {
      ifMatch: V1, key: `k-${i}`,
    })));
  const ok = responses.filter((r) => r.status === 200);
  const stale = responses.filter((r) => r.status === 412);
  assert.equal(ok.length, 1);
  assert.equal(stale.length, 59);
  const final = app.store.get("item-1")!;
  assert.equal(final.version, 2);
  assert.deepEqual(final, ok[0].json.item);
  assert.equal(JSON.stringify(final.data), dataBefore);
  assert.ok(final.decidedBy === "reviewer-1" || final.decidedBy === "reviewer-2");
});

test("TC-10 two concurrent admin PATCH on v1 -> one 200, one 412, data equals winner payload exactly", { timeout: 10_000 }, async (t) => {
  const barrier = createBarrier(2);
  const app = await startApp(t, { beforeCommit: () => barrier.arrive() });
  const payloads = [{ title: "A", body: "BA" }, { title: "B", body: "BB" }];

  const results = await Promise.all(payloads.map((p) => patch(app, "admin-token", p, { ifMatch: V1 })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 412]);
  const winnerIndex = results.findIndex((r) => r.status === 200);
  const final = app.store.get("item-1")!;
  assert.deepEqual(final.data, payloads[winnerIndex]);
  assert.equal(final.version, 2);
  assert.equal(final.status, "pending");
});

test("TC-11 concurrent admin PATCH vs reviewer approve on v1 -> exactly one wins, never approved + new data", { timeout: 10_000 }, async (t) => {
  const barrier = createBarrier(2);
  const app = await startApp(t, { beforeCommit: () => barrier.arrive() });

  const [p, d] = await Promise.all([
    patch(app, "admin-token", { title: "NEW", body: "NB" }, { ifMatch: V1 }),
    decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" }),
  ]);
  assert.deepEqual([p.status, d.status].sort(), [200, 412]);
  const final = app.store.get("item-1")!;
  assert.equal(final.version, 2);
  if (d.status === 200) {
    assert.equal(final.status, "approved");
    assert.deepEqual(final.data, { title: "T", body: "B" });
  } else {
    assert.equal(final.status, "pending");
    assert.deepEqual(final.data, { title: "NEW", body: "NB" });
  }
  assert.ok(!(final.status === "approved" && final.data.title === "NEW"));
});

test("TC-12 replay same key + same fingerprint -> identical status/body, applied once, decidedAt unchanged", async (t) => {
  const app = await startApp(t);
  const first = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(first.status, 200);
  const afterFirst = snapshot(app.store);

  const replay = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.equal(snapshot(app.store), afterFirst);
  assert.equal(app.store.get("item-1")?.version, 2);
  assert.equal(replay.json.item.decidedAt, first.json.item.decidedAt);
});

test("TC-13 same key, different fingerprint (other decision / other item) -> 422, state unchanged", async (t) => {
  const app = await startApp(t, { items: [makeItem("item-1"), makeItem("item-2")] });
  const first = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(first.status, 200);
  const before1 = snapshot(app.store, "item-1");
  const before2 = snapshot(app.store, "item-2");

  const otherDecision = await decide(app, "reviewer-token", "reject", { ifMatch: V1, key: "k-1" });
  assert.equal(otherDecision.status, 422);
  const otherItem = await decide(app, "reviewer-token", "approve", { id: "item-2", ifMatch: V1, key: "k-1" });
  assert.equal(otherItem.status, 422);

  assert.equal(snapshot(app.store, "item-1"), before1);
  assert.equal(snapshot(app.store, "item-2"), before2);
  assert.equal(app.store.get("item-1")?.status, "approved");
  assert.equal(app.store.get("item-2")?.status, "pending");
});

test("TC-14 ten concurrent requests with same key -> applied once, in-flight ones 409, then replay 200", { timeout: 10_000 }, async (t) => {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const app = await startApp(t, {
    beforeCommit: async () => {
      calls += 1;
      entered.resolve();
      await gate.promise;
    },
  });

  const first = decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  // First request must park in beforeCommit with the key reserved; if it answers first, fail fast.
  const early = await Promise.race([entered.promise.then(() => null), first]);
  assert.equal(early, null, "first request returned before reaching beforeCommit");
  // Under a broken guard (no in-flight 409) the duplicates would park in beforeCommit too and never
  // answer until the gate opens. A deadline turns that hang into an assertion failure instead of a
  // 10 s test timeout. The timer only bounds the FAILURE path: the correct code answers in
  // milliseconds, so 2 s is a generous ceiling, not a timing guess.
  const othersPromise = Promise.all(Array.from({ length: 9 }, () =>
    decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" })));
  let deadline: NodeJS.Timeout | undefined;
  const others = await Promise.race([
    othersPromise,
    new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 2_000); }),
  ]);
  clearTimeout(deadline);
  if (others === null) assert.fail("duplicate in-flight requests were not answered within 2 s (no 409 guard)");
  assert.ok(others.every((r) => r.status === 409), others.map((r) => r.status).join(","));
  assert.equal(app.store.get("item-1")?.version, 1);

  gate.resolve();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  assert.equal(calls, 1);
  assert.equal(app.store.get("item-1")?.version, 2);

  const replay = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, firstResponse.json);
  assert.equal(app.store.get("item-1")?.version, 2);
});

test("TC-15 beforeCommit throws -> 500 without detail, item unchanged, key released, retry same key -> 200", async (t) => {
  let fail = true;
  const app = await startApp(t, {
    beforeCommit: () => {
      if (fail) throw new Error("boom-secret-detail");
    },
  });
  const before = snapshot(app.store);

  const failed = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(failed.status, 500);
  assert.ok(!failed.text.includes("boom-secret-detail"));
  assert.equal(snapshot(app.store), before);
  assert.equal(app.store.get("item-1")?.status, "pending");
  assert.equal(app.store.get("item-1")?.version, 1);

  fail = false;
  const retry = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.item.version, 2);
  assert.equal(app.store.get("item-1")?.status, "approved");
});

test("TC-19 replay restores ETag header (same ETag as the original 200)", async (t) => {
  const app = await startApp(t);
  const first = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("etag"), "\"v2\"");

  const replay = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.equal(replay.headers.get("etag"), first.headers.get("etag"));
  assert.equal(app.store.get("item-1")?.version, 2);
});

test("TC-20 key released after 412 allows retry with fresh If-Match", async (t) => {
  const app = await startApp(t);
  const bump = await patch(app, "admin-token", { title: "N" }, { ifMatch: V1 });
  assert.equal(bump.status, 200); // item now v2

  const stale = await decide(app, "reviewer-token", "approve", { ifMatch: V1, key: "k-1" });
  assert.equal(stale.status, 412);
  assert.equal(app.store.get("item-1")?.status, "pending");

  const retry = await decide(app, "reviewer-token", "approve", { ifMatch: "\"v2\"", key: "k-1" });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.item.version, 3);
  assert.equal(retry.headers.get("etag"), "\"v3\"");
});
