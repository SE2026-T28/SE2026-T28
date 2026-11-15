# Latest review-fix evidence - 2026-11-10, Asia/Saigon

## Final cleanup fixes - latest validation

Same base SHA and uncommitted branch. Command: `npm run test:isolated -- --driver=native`; exit 0 on Windows / PostgreSQL 17.11. New cluster `node_modules/.s3-runs/run-URsypf/pgdata`; control-file/live identity verified before migration. Private transcript: `node_modules/.s3-runs/final-cleanup-validation.log` (Git-ignored; do not publish raw logs).

| Test ID | Expected | Actual | Status |
| --- | --- | --- | --- |
| HARNESS-DOCKER / HARNESS-CLEANUP | recover lost IDs, reject foreign ownership, attempt every cleanup despite file/disconnect/stop errors; report only safe step names | 6 regression tests passed, including timeout and failed creation; commands/filesystem failures simulated, no real Docker daemon | PASS (fault-injection unit tests only) |
| BACKEND | build/typecheck and all tests including new regression | 36 pass, 0 fail/skip | PASS |
| DB-SAFE | preserve URL/override/isolation safeguards | 7 pass, 0 fail/skip | PASS |
| MIGRATION | existing migration on new owned DB, second deploy has no pending migrations | both stages succeeded | PASS |
| FIXTURE-PARALLEL | independent suites with precise cleanup | 11 pass each, 0 fail/skip; final users=0 | PASS |
| HEADERS | checker and real-server smoke | 2 pass, smoke passed | PASS |
| HARNESS-NATIVE-CLEANUP | invalidate session, clear credential references, remove private files and stop owned PostgreSQL | session revoked; owned instance stopped | PASS |
| DOCKER / GITHUB CI | real Docker lifecycle and workflow execution | Docker executable unavailable; no installation or push performed | NOT RUN |

The following sections retain earlier run history. Their lower test counts do not describe the latest run above. Abrupt process termination or an unavailable Docker daemon can still require manual recovery; incomplete cleanup reports fixed failing step names and exits nonzero after attempting all steps.

Source: codex/s3-hardening, base 3081b750278722b3f2ba35df25dcbdded9510ce1, uncommitted local changes. Windows, Node 24.22.0, PostgreSQL 17.11, Prisma 7.10.1. Command: npm run test:isolated -- --driver=native in identity-server. Exit 0.

Isolation proof: a new cluster was initialized under node_modules/.s3-runs/run-3vHVbM/pgdata with random credentials, bound to 127.0.0.1:58500. pg_controldata identifier matched pg_control_system; live data_directory matched the newly created path, and startup time/current_database matched the manifest. The session bound config/schema hashes and a per-run capability. Migration occurred only after verification. Session revoked afterward; PostgreSQL log confirms database system is shut down at 23:30:13 +07. No development/shared database was contacted.

| Test ID | Command/stage | Expected | Actual | Status / evidence |
| --- | --- | --- | --- | --- |
| DB-SAFE-01..07 | harness test:safety | URL/host/DB/override refusals before unsafe writes; explicit dev policy without connection | 7 pass, 0 fail/skip | PASS, native harness stdout |
| DB-ISOLATION | npm test isolation test | valid proof accepted; flag-only, wrong capability/URL/system ID/schema refused | regression passed on owned instance | PASS, backend test stdout |
| DB-MIGRATE | db:generate; db:deploy twice | locked config; apply existing migration once | generate success; 1 migration applied; second no pending migrations | PASS, Prisma output |
| BACKEND | npm test | build/typecheck and all backend assertions | 30 pass, 0 fail/skip | PASS, node:test output |
| FIXTURE-01..05 | backend and parallel suites | exact cleanup, no allocation race, drain failed pending write, retain ownership for retry | both concurrent processes 11 pass each, 0 fail/skip | PASS, node:test output |
| M2-00/03/05/06 | included in npm test | original four real HTTP provider boundaries | all four passed | PASS, not browser E2E |
| HEADERS | test:headers | checker unit and real server smoke | 2 pass, smoke passed | PASS, Header checks passed |
| RESIDUE | harness final read-only query | no fixture users remain | users=0 | PASS, harness stdout |
| DEVELOPMENT | no DB command executed | preserve explicit personal dev workflow | pure policy regression only; no dev connection | NOT RUN for actual migration |
| DOCKER / GITHUB CI | not executed | same stages on Linux Docker runner | no new CI run, no push | NOT RUN |
| BROWSER / remaining M2 | no integrated auth/consent/callback on this source | full protocol/browser cases | no claim of success; M2-11 supplemental | BLOCKED |

No passwords, raw tokens/codes, client secrets or fixture identifiers are included here. Guard is scoped to project entry points; custom external Prisma configs/direct SQL and malicious same-user edits remain outside it. Cleanup requires writes tracked through the scope; process kill cannot guarantee finally.

---

# S3 — Test evidence và kết quả hardening local

## Mẫu bắt buộc cho mỗi lần chạy

| Trường | Nội dung |
| --- | --- |
| Test ID / subcase | Ví dụ M2-04a; không gộp các subcase chưa chạy vào PASS |
| Source | Branch, SHA gốc, thay đổi local chưa commit; SHA integration nếu khác |
| Lệnh / steps | Lệnh chính xác hoặc thao tác browser; thay connection string bằng mô tả đã lọc |
| Expected result | Assertions/status/lỗi OAuth/cleanup mong đợi |
| Actual result | Số pass/fail/skip, status, booleans đã lọc; không chỉ ghi “OK” |
| Status | PASS / FAIL / SKIP / NOT RUN / BLOCKED |
| Evidence | Link CI đúng run/SHA hoặc đoạn output tổng hợp đã lọc dưới đây |
| Environment | Ngày giờ, OS, Node, PostgreSQL/browser, instance riêng, schema/migration |

Không ghi password, raw token, code, client secret, email/UUID fixture, URL callback đầy đủ hoặc DATABASE_URL có credentials. Không đưa trace/HAR/screenshot chưa kiểm tra vào Git. Ghi `sub_matches_fixture=true` thay UUID. PASS chỉ áp dụng những assertion đã chạy; SKIP/NOT RUN/BLOCKED không phải PASS. Không copy kết quả của snapshot M2 vào S3.

Repeat verification also exited 0 using a second fresh cluster run-eCjTt1 (loopback port 58766): safety 7/7, backend 30/30, parallel 11/11 each, checker 2/2 and smoke PASS, users=0. Private transcript: identity-server/node_modules/.s3-runs/review-validation.log (Git-ignored; do not publish raw logs).

## Historical first hardening run (superseded isolation mechanism)

The flag-based setup and counts below are historical only. They do not validate the new guard. Use the latest results at the top of this file.

## Nguồn và môi trường lần chạy 10/11/2026 (giờ Việt Nam)

- Branch `codex/s3-hardening`; gốc PR #16 `3081b750278722b3f2ba35df25dcbdded9510ce1`. Kết quả áp dụng cho thay đổi local chưa commit, chưa push.
- Windows; Node 24.22.0, npm 11.19.1; PostgreSQL 17.11; Prisma/adapter/client 7.10.1 theo lockfile. Không đổi dependency/lockfile.
- Khởi tạo cluster mới trong `identity-server/node_modules/.s3-runtime/pgdata`, chỉ listen `127.0.0.1:55441`. Database mới `app04_test`, schema public. Không dùng cluster của VT113 hoặc M2 snapshot.
- Đã đọc `current_database`, `inet_server_addr`, `inet_server_port`, version trước migration: đúng app04_test, 127.0.0.1, 55441, PostgreSQL 17.11. Đặt `S3_TEST_DATABASE_ISOLATED=1` sau xác minh; URL chỉ truyền trong môi trường tiến trình, không tạo .env.
- Migration hiện có `20261022000000_create_users` áp trên DB mới; không đổi schema/migration.
- Sau kiểm thử đã kiểm lại 0 user và xác minh data_directory đúng worktree S3 trước khi dừng PostgreSQL tạm. Runtime được giữ trong node_modules (Git ignored), không xóa branch/worktree.

## Kết quả thực tế

Các lệnh npm dưới đây chạy từ `identity-server/`.

| Test ID | Lệnh | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| DB-SAFE-01 | `npm run test:safety` | Chấp nhận postgres/postgresql + 3 host loopback + app04_test khi xác nhận isolation | Cả tổ hợp hợp lệ được chấp nhận | PASS | Output `DB-SAFE-01` passed |
| DB-SAFE-02 | `npm run test:safety` | Chặn URL sai, DB dev/prod/other_test, remote host, query override, thiếu cờ, NODE_ENV production; lỗi không chứa URL | Mọi trường hợp từ chối; kiểm thông báo không lộ URL/credential marker | PASS | Output `DB-SAFE-02` passed |
| DB-SAFE-03 | `npm run test:safety` | Guard CLI trả exit 1 trước thao tác DB khi cấu hình không an toàn | Hai cấu hình bị từ chối với thông báo cố định | PASS | Output `DB-SAFE-03` passed |
| DB-SAFE-04 | `npm run test:safety` | Direct Prisma migrate deploy cũng bị chặn tại config, trước datasource | CLI từ chối với safety error; không Applying migration/P1001/URL trong output | PASS | Output `DB-SAFE-04` passed |
| DB-MIGRATE-01 | `npm run db:generate` rồi `npm run db:deploy` | Gate thành công; migration chỉ áp trên instance test đã xác minh | Generate thành công; 1 migration áp thành công | PASS | Output `All migrations have been successfully applied` |
| DB-MIGRATE-02 | `npm run db:deploy` lần hai | Không áp lại migration | `No pending migrations to apply` | PASS | Output migration local |
| DB-MIGRATE-03 | `npm run db:deploy` với URL database app04 tại cổng không phục vụ DB | Dừng trước Prisma invocation, không kết nối/migration | Exit 1; `No database operation was started` | PASS | Output guard; không dùng DB development thật |
| FIXTURE-01 | `npm test` | Hai scope cùng tồn tại; cleanup scope A giữ user B; cleanup lặp lại an toàn | Tạo user qua A1 thật; kiểm số lượng 0/1 rồi 0/0 đúng dự kiến | PASS | Output `FIXTURE-01` passed |
| FIXTURE-02 | `npm test` | Assertion thất bại sau registration vẫn cleanup qua finally | Lỗi giả lập được bắt; record của scope đã xóa | PASS | Output `FIXTURE-02` passed; không che lỗi ứng dụng |
| FIXTURE-PARALLEL | Hai tiến trình đồng thời `node --test dist/test/registration.test.js dist/test/fixtures.test.js` | Hai lượt không xóa fixture của nhau | Mỗi tiến trình 8 PASS, 0 FAIL, 0 SKIP | PASS | Output hai lượt; kiểm SQL sau đó users=0 |
| M2-00/03/05/06 | `npm run test:s3` | Giữ nguyên 4 assertion HTTP Provider thật | 4 PASS, 0 FAIL, 0 SKIP | PASS | Output S3 local; không phải browser E2E |
| BACKEND-REGRESSION | `npm test` | Build/typecheck và toàn bộ backend tests đạt, không giảm assertion gốc | 23 PASS, 0 FAIL, 0 SKIP; lặp lại cũng 23/23 | PASS | Output tổng hợp dưới đây |
| S4-HEADERS | `npm run test:headers` | Guard + checker unit + smoke server thật | 2 PASS, 0 FAIL, 0 SKIP; smoke pass | PASS | `Header checks passed` |
| FIXTURE-RESIDUE | SQL chỉ đọc `SELECT count(*) FROM users` trên DB test riêng | Không còn fixture sau các lượt chạy | 0 user | PASS | Kết quả SQL sau test |
| ENV-TRACKING | `node tests/security/check-tracked-env.mjs` từ root | Chỉ .env.example được theo dõi | Không có .env bị cấm | PASS | Output kiểm tra Git filenames |
| DIFF-CHECK | `git diff --check` | Không whitespace error | Exit 0 | PASS | Kiểm tra local sau thay đổi |
| M2-01/02/04/07/08/09/10/11 | Chưa có lệnh flow tương ứng trên branch baseline này | Theo từng subcase trong matrix | Chưa triển khai/chạy; thiếu A2–A3/O2–O3/C2 trong source S3 | BLOCKED | Không lấy test snapshot khác làm kết quả |
| BROWSER-E2E | Chưa chạy | React → login → consent → callback → dashboard và ca lỗi | Không chạy browser trong nhiệm vụ hardening | BLOCKED | Chờ snapshot tích hợp và blocker CSP của owner |
| CI-HARDENING | Không push theo giới hạn nhiệm vụ | CI trên thay đổi hardening | Chưa có CI cho code local mới | NOT RUN | Cần trưởng nhóm duyệt trước khi đưa lên PR |
| FRONTEND / GITLEAKS / AUDIT | Không chạy trong đợt hardening | Kiểm riêng khi tích hợp/publish PR | Không đổi frontend/dependency; chưa chạy scanning mới | NOT RUN | Không suy từ CI cũ thành PASS mới |

Output tổng hợp được lọc, không chứa dữ liệu giao dịch:

```text
test:safety: tests 4, pass 4, fail 0, skipped 0
test:s3: tests 4, pass 4, fail 0, skipped 0
npm test (final): tests 23, pass 23, fail 0, skipped 0
parallel run A: tests 8, pass 8, fail 0, skipped 0
parallel run B: tests 8, pass 8, fail 0, skipped 0
test:headers: tests 2, pass 2, fail 0, skipped 0
Header checks passed. This does not validate full CSP compatibility or browser flows.
remaining users in isolated test database: 0
```

## Bằng chứng lịch sử của PR #16, tách khỏi hardening

[CI run 41663461307](https://github.com/SE2026-T28/SE2026-T28/actions/runs/41663461307) của head `3081b75` đã checkout merge ref `5a09695f6d8a7d79c26c1c2c48c4c628566d3930` trên base `4c8e96e`. Log CI đã được review: backend 17/17, frontend 8/8, header checker 2/2 và smoke pass; 4 job success, không skip. Đây là lịch sử PR nền tảng, không xác nhận hardening local mới. Bằng chứng local 03/11 trước đó là Discovery/headers/S3 11/11 và frontend 8/8; full DB local lúc đó chưa chạy.

## Giới hạn và việc giao owner

- Historical flag-only guard was replaced by managed instance proof; see the latest run above.
- Cleanup qua finally/after không chạy khi process bị kill/mất điện. Chỉ bỏ instance test riêng; không xóa theo prefix chung.
- Không sửa Authentication, Provider, React Callback, OIDC contract, schema hoặc ruleset. Quang/Nam cần nền auth/interaction/code thật; Châu Anh cần callback/JWKS/nonce. Phương bổ sung integration/browser khi được duyệt.
- CSP consent redirect đã được báo tại [Issue #13](https://github.com/SE2026-T28/SE2026-T28/issues/13#issuecomment-6723993634); chưa tái hiện browser hoặc sửa module đó trong hardening.
