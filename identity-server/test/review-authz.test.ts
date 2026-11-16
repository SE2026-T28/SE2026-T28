import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_NOW, decide, makeItem, patch, snapshot, startApp } from "./review-helpers.js";

test("TC-01 admin and reviewer GET -> 200 {item} with ETag \"v1\"", async (t) => {
  const app = await startApp(t);
  for (const token of ["admin-token", "reviewer-token"]) {
    const res = await app.call("GET", "/item-1", { token });
    assert.equal(res.status, 200, token);
    assert.deepEqual(res.json, { item: makeItem() }, token);
    assert.equal(res.headers.get("etag"), "\"v1\"", token);
  }
});

test("TC-02 GET without token -> 401, guest -> 403, unknown id -> 404", async (t) => {
  const app = await startApp(t);
  assert.equal((await app.call("GET", "/item-1")).status, 401);
  assert.equal((await app.call("GET", "/item-1", { token: "guest-token" })).status, 403);
  assert.equal((await app.call("GET", "/item-1", { token: "bogus-token" })).status, 401);
  assert.equal((await app.call("GET", "/missing", { token: "admin-token" })).status, 404);
});

test("TC-03 reviewer PATCH -> 403, data unchanged", async (t) => {
  const app = await startApp(t);
  const before = snapshot(app.store);
  const withMatch = await patch(app, "reviewer-token", { title: "X" }, { ifMatch: "\"v1\"" });
  const withoutMatch = await patch(app, "reviewer-token", { title: "X" });
  assert.equal(withMatch.status, 403);
  assert.equal(withoutMatch.status, 403);
  assert.equal(snapshot(app.store), before);
  assert.deepEqual(app.store.get("item-1"), makeItem());
  assert.equal(app.store.get("item-1")?.version, 1);
});

test("TC-04 admin POST decision -> 403 (separation of duties), item pending v1", async (t) => {
  const app = await startApp(t);
  const before = snapshot(app.store);
  const res = await decide(app, "admin-token", "approve", { ifMatch: "\"v1\"", key: "k-1" });
  assert.equal(res.status, 403);
  assert.equal(snapshot(app.store), before);
  assert.equal(app.store.get("item-1")?.status, "pending");
  assert.equal(app.store.get("item-1")?.version, 1);
});

test("TC-05 reviewer approve/reject -> 200, decidedBy/At set, v2, data byte-identical", async (t) => {
  const app = await startApp(t, { items: [makeItem("item-1"), makeItem("item-2")] });
  const dataBefore = JSON.stringify(app.store.get("item-1")?.data);

  const approve = await decide(app, "reviewer-token", "approve", { id: "item-1", ifMatch: "\"v1\"", key: "k-1" });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.item.status, "approved");
  assert.equal(approve.json.item.decidedBy, "reviewer-1");
  assert.equal(approve.json.item.decidedAt, FIXED_NOW);
  assert.equal(approve.json.item.version, 2);
  assert.equal(JSON.stringify(approve.json.item.data), dataBefore);
  assert.equal(JSON.stringify(app.store.get("item-1")?.data), dataBefore);
  assert.equal(app.store.get("item-1")?.status, "approved");
  assert.equal(app.store.get("item-1")?.version, 2);

  const reject = await decide(app, "reviewer-token", "reject", { id: "item-2", ifMatch: "\"v1\"", key: "k-2" });
  assert.equal(reject.status, 200);
  assert.equal(reject.json.item.status, "rejected");
  assert.equal(reject.json.item.decidedBy, "reviewer-1");
  assert.equal(reject.json.item.decidedAt, FIXED_NOW);
  assert.equal(reject.json.item.version, 2);
  assert.equal(JSON.stringify(app.store.get("item-2")?.data), dataBefore);
});

test("TC-06 status codes: 428 / 412 / 400 / 428 / 400, item never changes", async (t) => {
  const app = await startApp(t);
  const before = snapshot(app.store);

  const patchNoMatch = await patch(app, "admin-token", { title: "X" });
  assert.equal(patchNoMatch.status, 428);
  const patchStale = await patch(app, "admin-token", { title: "X" }, { ifMatch: "\"v0\"" });
  assert.equal(patchStale.status, 412);
  const decisionNoKey = await decide(app, "reviewer-token", "approve", { ifMatch: "\"v1\"" });
  assert.equal(decisionNoKey.status, 400);
  const decisionNoMatch = await decide(app, "reviewer-token", "approve", { key: "k-1" });
  assert.equal(decisionNoMatch.status, 428);
  const decisionInvalid = await decide(app, "reviewer-token", "maybe", { ifMatch: "\"v1\"", key: "k-2" });
  assert.equal(decisionInvalid.status, 400);

  assert.equal(snapshot(app.store), before);
});

test("TC-07 admin PATCH current -> 200 ETag v2; approve on already-decided item -> 409", async (t) => {
  const decided = makeItem("item-2", { status: "approved", version: 2, decidedBy: "reviewer-2", decidedAt: FIXED_NOW });
  const app = await startApp(t, { items: [makeItem("item-1"), decided] });

  const patched = await patch(app, "admin-token", { title: "New", body: "NB" }, { ifMatch: "\"v1\"" });
  assert.equal(patched.status, 200);
  assert.equal(patched.headers.get("etag"), "\"v2\"");
  assert.deepEqual(patched.json.item.data, { title: "New", body: "NB" });
  assert.equal(patched.json.item.version, 2);
  assert.equal(patched.json.item.status, "pending");

  // R14: already-decided item (v2), current If-Match, new key -> 409, unchanged.
  const before = snapshot(app.store, "item-2");
  const again = await decide(app, "reviewer-token", "approve", { id: "item-2", ifMatch: "\"v2\"", key: "k-9" });
  assert.equal(again.status, 409);
  assert.equal(snapshot(app.store, "item-2"), before);
  assert.equal(app.store.get("item-2")?.status, "approved");

  // Same via the PATCHed item: approve (v2 -> v3), then second decision with current v3 -> 409.
  const first = await decide(app, "reviewer-token", "approve", { id: "item-1", ifMatch: "\"v2\"", key: "k-1" });
  assert.equal(first.status, 200);
  assert.equal(first.json.item.version, 3);
  const second = await decide(app, "reviewer2-token", "reject", { id: "item-1", ifMatch: "\"v3\"", key: "k-2" });
  assert.equal(second.status, 409);
  assert.equal(app.store.get("item-1")?.status, "approved");
});
