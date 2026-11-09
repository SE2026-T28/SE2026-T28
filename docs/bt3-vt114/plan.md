# VT-114 — plan recorded before implementation

Repository: https://github.com/SE2026-T28/SE2026-T28  
Branch: `feat/bt3-vt114-async-tasks`  
Baseline: `4c8e96e4c8eadb934be30a8efc220fa93919b60a` (`origin/main`, checked 2026-11-08).

## Prompt to coding agent

> In APP-04 at baseline 4c8e96e, propose a small test-first vertical slice for VT-114: allow a long-running task to start asynchronously and show progress; client retries must not duplicate a record/transaction/notification. Include API contract, tests, pairwise data, failure path, 200-concurrent-task measurement, and a temporary `>`→`>=` mutation. List files you would change. Do not implement yet. Respect the current OIDC/Registration code and avoid altering user registration semantics.

## Initial AI plan (recorded output)

1. Change `POST /api/users/register` into a background job and store jobs in Redis.
2. Add progress to the React OIDC dashboard and simulate completion with fixed `sleep` calls.
3. Add API tests for duplicate keys and 200 concurrent submissions.
4. Mutate a `>` capacity check to `>=` and expect a boundary test to fail.
5. Change `identity-server/src/users/user.routes.ts`, `identity-server/src/app.ts`, `client-demo/src/App.tsx`, `identity-server/package.json`, and add task tests.

## Repository review and corrected plan

- **Rejected (1):** Registration is synchronous and protects email uniqueness in PostgreSQL (`src/users/registration.ts`, migration unique index). Moving it to a queue changes A1's `201/409` contract and would risk duplicate user records. Use a separate demo task endpoint instead.
- **Rejected (2):** No Redis or task infrastructure exists in `package.json`; adding Redis would make the slice depend on an unprovisioned service. Use an in-memory task store with explicit restart/multi-instance limitations, and test idempotency in one process.
- **Revised (3):** `client-demo/src/App.tsx` is the OIDC client and `/callback` is still a placeholder on baseline. Adding task progress there would mix unrelated C2 work. Provide a same-origin demo page and a JSON status endpoint from Identity Server; plan a later React integration.
- **Revised (4):** Replace fixed-duration assertions with state polling and a deadline. The load script measures actual elapsed times, and the report separates API acknowledgment p95 from task completion p95.

Implementation order: spec → failing HTTP tests against missing endpoint → minimal task store/router/demo page → verify → temporary boundary mutation and rerun → revert mutation → 200-task load harness → review and report.

Planned files: `identity-server/src/tasks/store.ts`, `identity-server/src/tasks/routes.ts`, `identity-server/src/app.ts`, `identity-server/test/async-tasks.test.ts`, `identity-server/scripts/load-tasks.mjs`, `docs/bt3-vt114/README.md`, evidence logs. No `client-demo`, registration, Prisma schema, or package dependency changes.

Assumptions: demo task performs no real financial transaction or notification; `workUnits` is 1–5; idempotency scope is one server process and one key; p95 target is evaluated separately for accepting and completing 200 simulated tasks. A stable job ledger and durable queue are future work before production use.
