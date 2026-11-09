# VT-114 specification and risk-first test design

Problem: APP-04 has no task/status API. A request that outlives HTTP should acknowledge quickly, continue in the background, and show progress to the user. Retried requests must not create a second task or completion effect.

Acceptance criteria:

- AC1: valid `POST /api/demo-tasks` with `Idempotency-Key` and `{workUnits:1..5, failAt?:1..workUnits}` returns `202`, a stable task ID and status URL without waiting for completion.
- AC2: `GET /api/demo-tasks/:id` reports `queued|running|succeeded|failed`, progress 0–100; the same-origin demo page displays and refreshes this status. Progress never decreases and terminal states do not restart.
- AC3: same key and same normalized payload, including concurrent retries, return the same ID; completion callback runs at most once in one process.
- AC4: same key with different payload returns `409`; missing/invalid key or invalid work units returns `400`; a failed task stays failed under same-key retry and does not run a completion effect.

Non-functional constraints: 200 simultaneous simulated tasks; p95 for request acknowledgment and simulated completion each <=5.0 s on the recorded local test machine. Do not log keys, credentials or task bodies. Prototype uses only in-process memory and no new dependency; state, deduplication and progress disappear on restart, so it is not a durable production queue.

Invariant: for one retained idempotency key, the normalized payload maps to exactly one task ID and at most one completion callback invocation. A different payload with that key is rejected.

Contract: task bodies contain `workUnits` integer 1–5 and optional `failAt` integer 1–workUnits. Each unit simulates a bounded async step; `failAt` injects a failure for testing. This is a demonstration workload, not a user registration, transaction, or notification operation.

## Risk-first strategy

Unit: state transition and deduplication under concurrent calls, boundary 5/6, failure retention. Integration/API: status codes, key handling, progress, 200 task submissions. E2E: demo page polling and progress rendering in a browser, with one happy and one failure path; browser automation is planned separately because this slice has no browser test runner. No need to retest OIDC Discovery, Argon2 hashing or Prisma uniqueness in this slice; existing suites own those contracts.

| ID | Risk / AC | Level | Input/precondition | Expected | Priority |
|---|---|---|---|---|---|
| T01 | AC1 async ack | API | new key, units=3 | 202 with ID/status URL before terminal | P0 |
| T02 | AC2 progress | API | task from T01 | monotonically reaches succeeded/100 | P0 |
| T03 | AC3 concurrent retry | Unit/API | 20 same-key submissions | one ID, one completion effect | P0 |
| T04 | AC4 conflict | API | same key, units=3 then 5 | 409, original task unchanged | P0 |
| T05 | AC4 negative key | API | missing/short key | 400, no task | P0 |
| T06 | AC4 boundary/mutation | API | units=5 | accepted; `>`→`>=` mutant fails this test | P0 |
| T07 | AC4 negative units | API | units=6 or 0 | 400 | P1 |
| T08 | failure/retry | Unit/API | failAt=2, retry same key | failed remains failed, no completion effect | P0 |
| T09 | AC2 unknown ID | API | random UUID | 404, no internal detail | P1 |
| T10 | AC2 UI | E2E/HTTP smoke | `/demo-tasks` | page and external script for status display | P1 |
| T11 | pairwise valid shapes | API | selected units/failAt/key/timing pairs | expected status and deduplication | P1 |
| T12 | 200 concurrent | Load | 200 unique keys, units=5 | p95 ack/completion <=5 s in demo environment | P0 |

Pairwise dimensions: `workUnits ∈ {1,3,5}`, `outcome ∈ {success,fail-first,fail-last}`, `retry ∈ {none,during,after}`. Cartesian product has 27 combinations; choose a compact covering set so each pair of dimension values occurs at least once. `fail-first` and `fail-last` collapse for one unit, so that duplicate case is removed. A second negative matrix covers missing key, malformed key, and conflicting payload. Test data use deterministic keys derived from case IDs; no random user records.

AI-generated candidate test cases removed/revised before implementation: (A) “GET status twice is 200” duplicates T02 without checking transitions and was removed; (B) “sleep exactly 100ms then expect succeeded” is timing flaky and was replaced by deadline polling plus terminal-state assertions. The cases kept include the boundary 5/6 and same-key concurrent retry because they target distinct risks.
