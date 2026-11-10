# CI and S3 database safety

Security foundation runs on pull requests and pushes to main, with Node 24.22.0 and contents: read. Applications, frontend, audit and secrets jobs retain their existing checks. Backend installs with npm ci and runs npm run test:isolated -- --driver=docker, then npm audit --audit-level=high. There is no static PostgreSQL service or caller-supplied isolation flag.

The harness owns a fresh postgres:17.11 container, random credentials and a dynamically published loopback port. It verifies the container label/image, control-file system identifier, live data directory and startup time before migration. Only app04_test is accepted. Native Windows uses a fresh initdb directory and PostgreSQL 17.11 instead. Missing or mismatched capability/manifest, wrong database/host, changed config/schema and unverifiable server identity fail closed. S3_TEST_DATABASE_ISOLATED=1 is not evidence and is ignored.

## Local commands

From identity-server, use Node 24.22.0:

```text
npm ci
npm run test:safety
npm run test:s3
npm run test:isolated -- --driver=native
```

Use --driver=docker with Docker available. Native defaults to C:/Program Files/PostgreSQL/17/bin; S3_POSTGRES_BIN can select another PostgreSQL 17.11 installation. No existing database or .env is needed by the harness. It generates Prisma Client, runs safety regression, applies committed migrations twice, builds/typechecks and runs all backend tests, runs two registration/fixture suites concurrently, checks headers and verifies zero remaining users. Finally it revokes the session and stops only its own instance. Private runtime/logs remain Git-ignored under node_modules/.s3-runs; do not publish them. Process termination may require manual shutdown of that owned instance.

## Prisma boundary and development

Controlled db:generate, db:deploy, db:status and db:migrate commands lock the config/schema/migrations paths and validate the exact executed CLI argument vector. All extra arguments are refused except a validated migrate dev --name. Test sessions recheck live datasource identity; migrate dev/shadow databases are forbidden in test sessions. Default project config rejects raw db push, db execute, seed/reset and uncontrolled Prisma invocations before engine operations. Regression covers override attempts and direct push/execute rejection.

Development workflow remains explicit: local database app04, APP04_ALLOW_DEV_MIGRATIONS=1 in the current process, then db:deploy or db:migrate -- --name name. Remove the opt-in afterward. This is intentional development access, not isolated testing; it was not executed during S3 validation. See identity-server/README-A1.md. Generate outside a session uses a nonconnecting placeholder datasource.

This guard controls project entry points, not arbitrary Prisma installations/custom external configs, edited scripts or direct SQL. Those paths are NOT protected. A malicious process running as the same OS user is outside the trust boundary. Do not use them to bypass the harness.

## Fixture lifecycle

Docker containers receive a unique name and run label before creation. Cleanup discovers even stopped/partially created containers by that label after a failed or timed-out run, then checks exact name, label, image and ID before removal. No global prune or removal by shared prefix is used. Manifest invalidation, credential-reference clearing, client disconnect, each file removal and each owned-instance shutdown are independent cleanup steps. All are attempted before fixed step-name errors are reported; incomplete cleanup exits nonzero and requires manual recovery of the owned resource. Docker daemon failure or process termination can still prevent cleanup.

Each scope owns exact random emails. Allocate before registration and wrap writes in track(). Cleanup closes allocation/new work synchronously, joins concurrent cleanup, drains pending operations (including writes followed by errors), and deletes only owned emails. Failed deletion retains ownership for retry. finally/after handles assertion failure; kill/power loss or untracked writes are not guaranteed cleanup. Never use prefix-wide deletion.

## Other jobs and evidence

Frontend keeps npm ci, npm test, npm run build and audit. Secrets keeps tracked-env checks and Gitleaks with redaction. Header smoke validates real server headers, not browser CSP compatibility or full OIDC flow. See m2-test-matrix.md and s3-test-evidence.md. The updated Docker driver and GitHub Actions run are NOT RUN locally; native harness results do not prove Linux CI success. Historic CI does not validate uncommitted changes.

### Bằng chứng S4 lịch sử

PR #9 đã được đánh dấu Ready for review với base `main`. Trên commit S4 `4a315df`, [CI run 41483592991](https://github.com/SE2026-T28/SE2026-T28/actions/runs/41483592991) đã chạy và đạt cả bốn job `applications`, `backend`, `frontend`, `secrets`; không có job bị skip. Quang đã Approve commit `4a315df`. Kết quả CI và review này chỉ xác nhận commit đó; commit cập nhật tài liệu này cần CI chạy lại trên đúng commit mới trước khi merge. Chỉ đóng issue #6 sau khi các kiểm tra và review cần thiết hoàn thành.
