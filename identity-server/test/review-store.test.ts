import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewStore } from "../src/review/review-store.js";
import type { ReviewItem } from "../src/review/review-store.js";
import { makeItem } from "./review-helpers.js";

function freshStore(): ReviewStore {
  const store = new ReviewStore();
  store.seed(makeItem());
  return store;
}

test("TC-16 compareAndSet: two synchronous calls with same expectedVersion -> ok then conflict, mutate once", () => {
  const store = freshStore();
  let calls = 0;
  const mutate = (draft: ReviewItem) => { calls += 1; draft.status = "approved"; };
  const first = store.compareAndSet("item-1", 1, mutate);
  const second = store.compareAndSet("item-1", 1, mutate);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.item.version, 2);
  assert.deepEqual(second, { ok: false, reason: "conflict" });
  assert.equal(calls, 1);
  assert.equal(store.get("item-1")?.version, 2);
});

test("TC-16 compareAndSet: wrong versions 0 and 2 on a v1 item -> conflict, mutate not called, item unchanged", () => {
  for (const wrong of [0, 2]) {
    const store = freshStore();
    const before = JSON.stringify(store.get("item-1"));
    let called = false;
    const result = store.compareAndSet("item-1", wrong, () => { called = true; });
    assert.deepEqual(result, { ok: false, reason: "conflict" });
    assert.equal(called, false);
    assert.equal(JSON.stringify(store.get("item-1")), before);
  }
});

test("TC-16 compareAndSet: unknown id -> not-found, mutate not called", () => {
  const store = freshStore();
  let called = false;
  const result = store.compareAndSet("nope", 1, () => { called = true; });
  assert.deepEqual(result, { ok: false, reason: "not-found" });
  assert.equal(called, false);
});

test("TC-17 store returns copies: editing get()/seed input/compareAndSet result never changes the store", () => {
  const store = new ReviewStore();
  const seeded = makeItem();
  store.seed(seeded);
  const original = JSON.stringify(makeItem());

  const got = store.get("item-1")!;
  got.data.title = "X";
  got.status = "approved";
  assert.equal(JSON.stringify(store.get("item-1")), original);

  seeded.data.title = "SEED-MUTATED";
  assert.equal(JSON.stringify(store.get("item-1")), original);

  const cas = store.compareAndSet("item-1", 1, (draft) => { draft.status = "rejected"; });
  assert.ok(cas.ok);
  if (cas.ok) cas.item.data.title = "Y";
  assert.equal(store.get("item-1")?.data.title, "T");
  assert.equal(store.get("item-1")?.status, "rejected");
  assert.equal(store.get("item-1")?.version, 2);
});

test("TC-18 idempotency: new -> in-flight -> replay, mismatch, release, keyed by actor", () => {
  const store = freshStore();
  assert.deepEqual(store.reserve("reviewer-1", "k-1", "fp-a"), { kind: "new" });
  assert.deepEqual(store.reserve("reviewer-1", "k-1", "fp-a"), { kind: "in-flight" });
  assert.deepEqual(store.reserve("reviewer-1", "k-1", "fp-b"), { kind: "mismatch" });

  const stored = { status: 200, body: { item: { id: "item-1" } } };
  store.complete("reviewer-1", "k-1", stored);
  assert.deepEqual(store.reserve("reviewer-1", "k-1", "fp-a"), { kind: "replay", response: stored });
  assert.deepEqual(store.reserve("reviewer-1", "k-1", "fp-b"), { kind: "mismatch" });

  assert.deepEqual(store.reserve("reviewer-2", "k-1", "fp-a"), { kind: "new" });

  assert.deepEqual(store.reserve("reviewer-1", "k-2", "fp-a"), { kind: "new" });
  store.release("reviewer-1", "k-2");
  assert.deepEqual(store.reserve("reviewer-1", "k-2", "fp-a"), { kind: "new" });
});
