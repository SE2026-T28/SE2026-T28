# Part 4 verification notes

## Mutation

Only the users:read predicate was removed from the Search GET handler; account eligibility, token lookup/expiry/client/audience/sender checks stayed intact.
TC-12 gained a direct valid-query insufficient-scope assertion, avoiding a validation failure masking authorization failure.
Baseline: targeted test passes. Mutant: expected 403, actual 200; test fails.
Restoration SHA-256 is identical before/after (see mutation-restoration.txt). Restored targeted and full suite: 50 pass, 0 fail, 0 skip.

## Native coverage

Node 24.22.0 --experimental-test-coverage; compiled application source included, generated Prisma excluded. No new dependency.
Snapshot before flaky-test fixes: all app files line 84.50%, branch 76.28%; search.js and search.routes.js line/branch 100%. Compiled JS line numbers are reported, not TypeScript source coverage.

| Risk | Evidence | Remaining gap |
|---|---|---|
| Validation/BVA | unit tables, HTTP invalid/duplicate, 100% search branches | all malformed raw HTTP encodings not exhausted |
| Pagination | mock query shape + PostgreSQL 11-row page boundaries | concurrent inserts/count snapshot consistency |
| Literal filtering | PostgreSQL case-insensitive and escaped wildcard fixture | Unicode collation behavior |
| Stable ordering | PostgreSQL timestamps tied across pages + ID order | updates between requests |
| Authorization | real provider tokens, insufficient-scope mutation killed | malformed duplicate header permutations |
| OIDC issuance | real PKCE/login/consent/token and old-grant eligibility | code exchange eligibility TOCTOU has guard but no dedicated between-code/token test |
| Backward compatibility | registration DB regression, legacy UserInfo, Discovery/headers | browser Search preflight |
| Errors | count/findMany propagation unit; HTTP generic 500 | provider storage outage; malformed JSON/413 global handler uncovered |

Critical gaps shown by coverage include authentication failure branches (authentication.js 37.50% branch), interaction CSRF/rate-limit/invalid-prompt branches (51.92%), and global error handler. No claim of complete security follows from 100% Search coverage.

## Flakiness

1. Experiment held port 15539: old issuance test failed EADDRINUSE. Fixed by binding HTTP server to port 0 first, using actual port in issuer and attaching Express to the bound server (no close/reopen port race). While 15539 stayed occupied, three rounds of issuance+PostgreSQL tests passed (2 tests per round).
2. Date mocking: explicit reset existed only on normal path. Added reset in finally before server/DB cleanup, in addition to node:test automatic mock restoration. No wall-clock sleeps are used for expiry. Subsequent flow and three repeats passed.
3. Fixture review: random per-run email prefixes/UUIDs; issuance deletes only its registered ID, PostgreSQL test deletes its IDs plus marker. Three rounds ran both files via node:test without ordering dependency. This is bounded evidence, not proof of universal absence of races.

## Performance interpretation

See performance.json and harness test/user-search.performance.mjs. 80 closed-loop tasks, one request per task; measures through body JSON consumption, not just time-to-first-byte. Model-minted tokens use the real provider storage and verifier; load excludes login/consent throughput (separately functionally tested). Same-host load generator/application/database and warm caches limit generalization. Dataset has 10,000 users; larger production populations are not covered. No schema/index changes were made for benchmark.

## Observed performance result and diagnosis

Run 1: p50 1878.97ms, p95 2327.65ms, p99 2449.32ms, 42.28 req/s.
Run 2: p50 1961.94ms, p95 2524.33ms, p99 2706.02ms, 40.24 req/s.
Run 3: p50 2068.38ms, p95 2771.04ms, p99 3146.51ms, 37.76 req/s.
All measured runs: 2000 requests each, 0 errors. Target not consistently met (runs 2 and 3 exceed 2500ms). No tuning rerun replaced these results.
Machine: Windows 10.0.19045, Intel i7-7820HQ @2.90GHz, 8 logical CPUs, 15.90GiB RAM; Node24.22.0, PostgreSQL17.11 on same host.

Evidence-based suspects, not proven root causes: getPrisma does not configure pool size; installed pg-pool defaults max=10, so 80 callers can queue for DB access. Every request performs count then findMany; unfiltered deep pages require ordering/offset work, and only ID/email indexes exist (confirmed via pg_indexes). Case-insensitive substring queries have no dedicated supporting index. Throughput declines across runs; same-machine contention or thermal effects are possible but not measured. No CPU/IO/pool timing or EXPLAIN ANALYZE was captured, so a unique bottleneck cannot be claimed. Next diagnostic step: instrument queue/query timing and inspect query plans on the same dataset before changing pool/indexes. Avoid increasing pool size blindly.

Final verification: 50 backend tests pass, 0 fail/skip; 2 header tests and server checks pass; users count 0 after cleanup. Final route SHA256 still matches mutation restoration hash. No production source logic changed in Part4; changes are test assertions, port/clock cleanup, performance harness and evidence only.
