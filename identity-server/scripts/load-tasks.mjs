import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { readConfig } from "../dist/src/config.js";
import { TaskStore } from "../dist/src/tasks/store.js";

const concurrency = 200;
const targetMs = 5_000;
const config = readConfig({
  NODE_ENV: "test", PORT: "3000", OIDC_ISSUER: "http://localhost:3000",
  OIDC_CLIENT_ID: "app04-react-demo", OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/", OIDC_SCOPES: "openid profile email",
  OIDC_CORS_ORIGIN: "http://localhost:5173",
});
const store = new TaskStore({ stepDelayMs: 40 });
const server = createApp(config, store).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2));
}

try {
  const samples = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    const began = performance.now();
    const response = await fetch(`${baseUrl}/api/demo-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `vt114-load-${String(index).padStart(4, "0")}` },
      body: JSON.stringify({ workUnits: 5 }),
    });
    const acknowledged = performance.now();
    assert.equal(response.status, 202);
    const task = await response.json();
    const deadline = began + 10_000;
    while (performance.now() < deadline) {
      const statusResponse = await fetch(`${baseUrl}${task.statusUrl}`);
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      if (status.status === "succeeded") {
        return { acknowledgmentMs: acknowledged - began, completionMs: performance.now() - began, id: task.id };
      }
      assert.notEqual(status.status, "failed");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Task ${index} did not complete within 10 seconds`);
  }));
  assert.equal(new Set(samples.map(sample => sample.id)).size, concurrency);
  const result = {
    node: process.version,
    simulatedTasks: concurrency,
    workUnitsPerTask: 5,
    stepDelayMs: 40,
    acknowledgmentP95Ms: p95(samples.map(sample => sample.acknowledgmentMs)),
    completionP95Ms: p95(samples.map(sample => sample.completionMs)),
    targetMs,
    pass: p95(samples.map(sample => sample.acknowledgmentMs)) <= targetMs && p95(samples.map(sample => sample.completionMs)) <= targetMs,
    scope: "single local Node process, loopback HTTP, in-memory demo work; no database, browser, external service or durable queue",
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(() => resolve()));
}
