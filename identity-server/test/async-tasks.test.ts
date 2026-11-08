import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { TaskStore } from "../src/tasks/store.js";

const config = readConfig({
  NODE_ENV: "test", PORT: "3000", OIDC_ISSUER: "http://localhost:3000",
  OIDC_CLIENT_ID: "app04-react-demo", OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/", OIDC_SCOPES: "openid profile email",
  OIDC_CORS_ORIGIN: "http://localhost:5173",
});

let server: Server;
let baseUrl: string;
before(async () => {
  server = createApp(config).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

function submit(key: string | undefined, body: object) {
  return fetch(`${baseUrl}/api/demo-tasks`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body),
  });
}

async function terminal(id: string) {
  const deadline = performance.now() + 3000;
  const seen: number[] = [];
  while (performance.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/demo-tasks/${id}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; progress: number };
    seen.push(body.progress);
    if (body.status === "succeeded" || body.status === "failed") {
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "progress must not decrease");
      return body;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("task did not reach a terminal state before deadline");
}

test("T01/T02 valid POST acknowledges and status reaches 100%", async () => {
  const response = await submit("vt114-t01-new", { workUnits: 3 });
  assert.equal(response.status, 202);
  const body = await response.json() as { id: string; statusUrl: string; status: string };
  assert.ok(body.id);
  assert.equal(body.statusUrl, `/api/demo-tasks/${body.id}`);
  assert.ok(["queued", "running"].includes(body.status));
  const last = await terminal(body.id);
  assert.equal(last.status, "succeeded");
  assert.equal(last.progress, 100);
});

test("T03 concurrent retries share one task ID", async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, () => submit("vt114-t03-same", { workUnits: 5 })));
  assert.ok(responses.every(response => response.status === 202));
  const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ id: string }>));
  assert.equal(new Set(bodies.map(body => body.id)).size, 1);
  assert.equal((await terminal(bodies[0].id)).status, "succeeded");
});

test("T03b one completion effect survives 20 same-key submissions", async () => {
  let effects = 0;
  const store = new TaskStore({ stepDelayMs: 1, onComplete: () => { effects++; } });
  const submissions = Array.from({ length: 20 }, () => store.submit("vt114-t03b-once", { workUnits: 5 }));
  assert.ok(submissions.every(result => result.kind === "accepted"));
  const ids = submissions.map(result => result.kind === "accepted" ? result.task.id : "");
  assert.equal(new Set(ids).size, 1);
  const deadline = performance.now() + 3000;
  while (store.get(ids[0])?.status !== "succeeded" && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(store.get(ids[0])?.status, "succeeded");
  assert.equal(effects, 1);
});

test("T08b failed work never invokes the completion effect", async () => {
  let effects = 0;
  const store = new TaskStore({ stepDelayMs: 1, onComplete: () => { effects++; } });
  const first = store.submit("vt114-t08b-fail", { workUnits: 3, failAt: 2 });
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") return;
  const deadline = performance.now() + 3000;
  while (store.get(first.task.id)?.status !== "failed" && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(store.get(first.task.id)?.status, "failed");
  assert.equal(store.submit("vt114-t08b-fail", { workUnits: 3, failAt: 2 }).kind, "accepted");
  assert.equal(effects, 0);
});

test("T04 conflicting payload with same key returns 409", async () => {
  const original = await submit("vt114-t04-conflict", { workUnits: 3 });
  assert.equal(original.status, 202);
  const conflict = await submit("vt114-t04-conflict", { workUnits: 5 });
  assert.equal(conflict.status, 409);
});

test("T05/T07 invalid key and work units are rejected", async () => {
  assert.equal((await submit(undefined, { workUnits: 3 })).status, 400);
  assert.equal((await submit("short", { workUnits: 3 })).status, 400);
  assert.equal((await submit("vt114-t07-zero", { workUnits: 0 })).status, 400);
  assert.equal((await submit("vt114-t07-six", { workUnits: 6 })).status, 400);
});

test("T06 boundary workUnits=5 is accepted (mutation sentinel)", async () => {
  const response = await submit("vt114-t06-boundary", { workUnits: 5 });
  assert.equal(response.status, 202);
  const body = await response.json() as { id: string };
  assert.equal((await terminal(body.id)).status, "succeeded");
});

test("T08 failed task remains failed on same-key retry", async () => {
  const response = await submit("vt114-t08-failure", { workUnits: 3, failAt: 2 });
  assert.equal(response.status, 202);
  const first = await response.json() as { id: string };
  const failed = await terminal(first.id);
  assert.equal(failed.status, "failed");
  assert.ok(failed.progress < 100);
  const retry = await submit("vt114-t08-failure", { workUnits: 3, failAt: 2 });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json() as { id: string }).id, first.id);
  assert.equal((await terminal(first.id)).status, "failed");
});

test("T09 unknown task returns 404", async () => {
  const response = await fetch(`${baseUrl}/api/demo-tasks/00000000-0000-4000-8000-000000000000`);
  assert.equal(response.status, 404);
});

test("T10 demo page contains same-origin progress client", async () => {
  const page = await fetch(`${baseUrl}/demo-tasks`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /progress/);
  assert.match(html, /demo-tasks\.js/);
});

const pairwise = [
  { units: 2, outcome: "success", retry: "none" },
  { units: 2, outcome: "first", retry: "during" },
  { units: 2, outcome: "last", retry: "after" },
  { units: 3, outcome: "success", retry: "during" },
  { units: 3, outcome: "first", retry: "after" },
  { units: 3, outcome: "last", retry: "none" },
  { units: 5, outcome: "success", retry: "after" },
  { units: 5, outcome: "first", retry: "none" },
  { units: 5, outcome: "last", retry: "during" },
] as const;

test("T11 pairwise combinations cover work units, outcome and retry timing", async () => {
  const pairs = new Set<string>();
  for (const [index, row] of pairwise.entries()) {
    pairs.add(`u:${row.units}/o:${row.outcome}`);
    pairs.add(`u:${row.units}/r:${row.retry}`);
    pairs.add(`o:${row.outcome}/r:${row.retry}`);
    const key = `vt114-pair-${index.toString().padStart(2, "0")}`;
    const payload = { workUnits: row.units, ...(row.outcome === "success" ? {} : { failAt: row.outcome === "first" ? 1 : row.units }) };
    const response = await submit(key, payload);
    assert.equal(response.status, 202);
    const first = await response.json() as { id: string };
    if (row.retry === "during") {
      const retry = await submit(key, payload);
      assert.equal((await retry.json() as { id: string }).id, first.id);
    }
    const last = await terminal(first.id);
    assert.equal(last.status, row.outcome === "success" ? "succeeded" : "failed");
    if (row.retry === "after") {
      const retry = await submit(key, payload);
      assert.equal((await retry.json() as { id: string }).id, first.id);
    }
  }
  assert.equal(pairs.size, 27, "all 3x3 pair values must be covered");
});
