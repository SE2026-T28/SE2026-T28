# BT3 VT-114 executable slice

Repo: https://github.com/SE2026-T28/SE2026-T28
Branch: `feat/bt3-vt114-async-tasks`
Baseline: `4c8e96e` on `main` (2026-11-08).

This is a same-origin demo task API/UI in the APP-04 Identity Server. It does not change OIDC, registration or a real notification/transaction. It demonstrates asynchronous progress and same-process idempotency; it is **not** a durable queue.

## Run the slice

Use Node.js 24.22.0. From `identity-server`:

```bash
npm ci
npm run build
node --test dist/test/async-tasks.test.js
node scripts/load-tasks.mjs
node scripts/browser-demo.mjs  # requires google-chrome
```

For the full backend suite, start PostgreSQL 17 with a dedicated database named `app04_test`, apply the existing migration, then run:

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/app04_test?schema=public' npm run db:deploy
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/app04_test?schema=public' npm test
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/app04_test?schema=public' npm run test:headers
```

`npm test` reads `dist/test/*.test.js`; after switching from a different branch, remove the generated `identity-server/dist` folder before rebuilding so stale tests are not included. No `.env` or production data is needed for slice, load or browser checks.

To try the UI, run the server with the normal local `.env`/PostgreSQL setup and open `http://localhost:3000/demo-tasks`. API: `POST /api/demo-tasks` with `Idempotency-Key` and JSON `{ "workUnits": 5 }`; poll the returned `statusUrl`.

Evidence: `red.log` (404 before code), `pass.log`, `mutation.log` (T06 catches `>`→`>=`), `coverage.log`, `full-suite.log`, `headers.log`, `load.json`, `browser.json`. Mutation commit `23e0080` exists **only** on local branch `experiment/vt114-boundary-mutation` and is absent from this branch.

Limitations: map and keys disappear on restart; there is no cross-instance deduplication, durable outbox, authentication/tenant scoping, real side effect, or crash recovery. The completion callback in this harness demonstrates at-most-one invocation while the process lives; it cannot prove exactly-once delivery when an external operation succeeds and then its acknowledgment fails. The load result is 200 simulated tasks on loopback, not 200 real users or PostgreSQL writes.
