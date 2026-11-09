# VT-113 performance investigation (not final submission report)

Baseline branch feat/vt113-user-search-test-first, HEAD 4c8e96e4c8eadb934be30a8efc220fa93919b60a. Original Part4 benchmark retained unchanged in docs/vt113-part4/performance.json.

## Profiling before production changes

Harness-only instrumentation: AsyncLocalStorage request context; pg Pool.connect acquisition callback timing; pg Client.query driver timing; Prisma repository count/findMany timing; real provider AccessToken.find; HTTP finish and synchronous response.json.
Validated baseline (2400 requests including 400 warm-up), milliseconds:

| Measurement | Mean | p95 |
|---|---:|---:|
| Server HTTP processing through finish | 1980.807 | 2559.170 |
| Authorization token lookup | 0.064 | 0.084 |
| Pool acquisition summed per request | 1726.436 | 2119.345 |
| Driver query time summed per request | 252.856 | 628.844 |
| Prisma count inclusive of wait | 995.300 | 1359.586 |
| Prisma findMany inclusive of wait | 984.963 | 1310.483 |
| JSON serialization/write synchronous | 0.279 | 0.461 |

These metrics overlap; quantiles cannot be added. Driver time includes network, DB execution and row decode; standalone EXPLAIN separates engine execution. Initial instrumentation lost ALS context when pg delivered queued callbacks: its driver values were incomplete. That snapshot is retained under profile-initial-context-incomplete.json and MUST NOT be used for driver conclusions. Corrected callback propagation produced profile-baseline.json. A small build/unit-test job overlapped part of corrected profiling, so absolute timings are diagnostic, not a replacement for the original three-run baseline.

EXPLAIN ANALYZE/BUFFERS on 10000 seeded rows (before load): count Seq Scan 1.786ms; page100/limit50 Seq Scan+in-memory sort 5.399ms; case-insensitive selective substring Seq Scan+top-N sort 87.036ms in the initial capture. Full plans are in JSON; corrected capture is authoritative for its own execution times. No index or schema changes.

Observed bottleneck is pool queuing, backed by ~87% mean server time in acquisition wait, not token verification or serialization. Expensive substring scans and duplicate COUNT work keep the 10-slot pool occupied. No claim that increasing connections alone fixes CPU contention.

## Options reviewed

1. Increase pool size: may reduce queueing but increase CPU/IO contention. Changing shared getPrisma affects Registration; a separate Search pool costs connections and lifecycle complexity. Not selected.
2. Coalesce only in-flight identical COUNT queries per repository/filter: removes duplicate overlapping scans without new dependency, no completed-result cache and no change to Registration. Selected.
3. Composite ordering/trigram index: could reduce query work, but needs schema/index review, disk/write overhead and possibly extension. Not implemented.

## Minimal patch and regression

Only production file changed in this investigation: src/users/search.ts. WeakMap keys isolate repositories; filter-keyed promises are deleted on success or failure. No page-data caching. Response fields/order/filter and authorization remain unchanged. Counts shared by overlapping requests represent the same in-flight DB statement; count/data still do not promise a transaction snapshot. Benefits depend on repeated filters; unique-filter workloads are not established by this benchmark.

RED regression: 8 concurrent identical calls observed 8 COUNT calls, expected 1. GREEN: coalescing, post-completion refresh, repository/filter isolation and error retry tests pass. Full backend: 52 pass, 0 fail, 0 skip. Authorization TC-12 remains active; restored route SHA256 checked separately.

## Benchmark after patch

Exact original protocol: 80 closed-loop HTTP workers, 400 warm-up, 3x2000 measured requests, 10000 rows, same query mix and same machine/DB; no profiling instrumentation in timed optimized runs. Original report untouched; optimized-benchmark.json stores new result. Auth uses real provider opaque token lookup, not fake middleware. OAuth login throughput excluded.

| Run | p50 ms | p95 ms | p99 ms | req/s | errors |
|---|---:|---:|---:|---:|---:|
| 1 | 1101.870 | 2426.035 | 2682.478 | 69.156 | 0/2000 |
| 2 | 1273.467 | 2499.811 | 2823.002 | 66.211 | 0/2000 |
| 3 | 1140.539 | 1988.704 | 2254.231 | 73.453 | 0/2000 |

All three meet p95<=2500ms in this measurement. Run2 margin is only 0.189ms, so this is not a robustness guarantee. Run1 p95 worsened versus original run1 despite better p50/throughput; no cherry-picking. Same-host contention, warm cache, randomized fixture IDs and narrow repeated query mix limit generalization.

DB: PostgreSQL17.11, max_connections100, shared_buffers128MB, work_mem4MB, English_United States.1252 collation. Existing ID/email indexes only. Machine: Windows10.0.19045, i7-7820HQ 8 logical CPUs,15.90GiB RAM, Node24.22.0.
