// BT3 VT-111 NFR1 load harness. Run after `npm run build`: node scripts/review-load.mjs
// 60 concurrent tasks (GET item -> POST decision with If-Match) over real loopback HTTP.
// Modes: distinct (60 items, all 200), contended (1 item, 1x200 + 59x412).
// Variants: base (no delay) and io20 (beforeCommit sleeps 20 ms, harness-only).
// Exit code 1 if p95 > 2000 ms or an invariant breaks. Client and server share one
// event loop, so numbers are optimistic (no DB, no multi-instance).
import express from "express";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
// Dynamic import with a computed URL: a static "../dist/..." import would make tsc (allowJs,
// scripts/*.mjs included) treat dist output as input and fail with TS5055.
const load = (name) => import(new URL(`../dist/src/review/${name}.js`, import.meta.url).href);
const { ReviewStore } = await load("review-store");
const { createReviewRouter } = await load("review.routes");

const N = 60;
const ROUNDS = 5;
const P95_LIMIT_MS = 2000;
const IO_MS = 20;

const nearestRank = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];

async function runRound(mode, ioMs) {
  const store = new ReviewStore();
  const ids = mode === "distinct" ? Array.from({ length: N }, (_, i) => `item-${i}`) : ["item-0"];
  for (const id of ids) store.seed({ id, data: { title: "T", body: "B" }, status: "pending", version: 1 });
  const app = express();
  app.use(express.json());
  app.use(
    "/review-items",
    createReviewRouter({
      store,
      resolveActor: (req) => {
        const m = /^Bearer reviewer-(\d+)$/.exec(req.get("authorization") ?? "");
        return m ? { id: `reviewer-${m[1]}`, role: "reviewer" } : null;
      },
      beforeCommit: ioMs ? () => new Promise((r) => setTimeout(r, ioMs)) : undefined,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const task = async (i) => {
      const id = ids[mode === "distinct" ? i : 0];
      const headers = { authorization: `Bearer reviewer-${i}` };
      const t0 = performance.now();
      const g = await fetch(`${base}/review-items/${id}`, { headers });
      const etag = g.headers.get("etag");
      await g.text();
      const p = await fetch(`${base}/review-items/${id}/decision`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "if-match": etag, "idempotency-key": `k-${i}` },
        body: JSON.stringify({ decision: "approve" }),
      });
      await p.text();
      return { status: p.status, ms: performance.now() - t0 };
    };
    const results = await Promise.all(Array.from({ length: N }, (_, i) => task(i)));
    const item = store.get("item-0");
    const approved = ids.filter((id) => store.get(id).status === "approved").length;
    return { results, item, approved, versions: ids.map((id) => store.get(id).version) };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

let failed = false;
const fmt = (x) => x.toFixed(1);
console.log(`review-load: N=${N} rounds=${ROUNDS} (+1 warm-up discarded) p95 limit=${P95_LIMIT_MS} ms (nearest-rank, rank=${Math.ceil(0.95 * N)})`);
for (const ioMs of [0, IO_MS]) {
  for (const mode of ["distinct", "contended"]) {
    await runRound(mode, ioMs); // warm-up, discarded
    const hist = {};
    const lat = [];
    const rounds = [];
    let invariant = true;
    for (let r = 0; r < ROUNDS; r++) {
      const { results, approved, versions } = await runRound(mode, ioMs);
      const ms = results.map((x) => x.ms).sort((a, b) => a - b);
      lat.push(...ms);
      for (const x of results) hist[x.status] = (hist[x.status] ?? 0) + 1;
      const ok200 = results.filter((x) => x.status === 200).length;
      const ok412 = results.filter((x) => x.status === 412).length;
      if (mode === "distinct") invariant &&= ok200 === N && approved === N && versions.every((v) => v === 2);
      else invariant &&= ok200 === 1 && ok412 === N - 1 && approved === 1 && versions[0] === 2;
      rounds.push({ p50: nearestRank(ms, 50), p95: nearestRank(ms, 95), max: ms[ms.length - 1] });
    }
    lat.sort((a, b) => a - b);
    const worstRoundP95 = Math.max(...rounds.map((x) => x.p95));
    const pass = invariant && worstRoundP95 <= P95_LIMIT_MS;
    if (!pass) failed = true;
    console.log(`\n[${mode}] beforeCommit=${ioMs ? ioMs + " ms simulated I/O" : "none"}`);
    rounds.forEach((x, i) => console.log(`  round ${i + 1}: p50=${fmt(x.p50)} p95=${fmt(x.p95)} max=${fmt(x.max)} ms`));
    console.log(`  pooled (${lat.length} samples): p50=${fmt(nearestRank(lat, 50))} p95=${fmt(nearestRank(lat, 95))} max=${fmt(lat[lat.length - 1])} ms; worst per-round p95=${fmt(worstRoundP95)} ms`);
    console.log(`  status histogram (all rounds): ${JSON.stringify(hist)}`);
    console.log(`  invariant ${mode === "distinct" ? "60x200, all approved, v2" : "exactly 1x200 + 59x412, single approval, v2"}: ${invariant ? "OK" : "BROKEN"}`);
    console.log(`  ${pass ? "PASS" : "FAIL"} (p95 <= ${P95_LIMIT_MS} ms)`);
  }
}
console.log(`\nOVERALL: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
