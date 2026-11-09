# VT-113 — User Search API: chạy và kiểm chứng

Đặng Bích Minh Phương — 24002069 — SE2026-T28 — APP-04 / VT-113.
Branch BTCN: `feat/vt113-user-search-test-first`. Implementation chưa commit/PR tại thời điểm viết hướng dẫn.

README này mô tả branch VT-113 hiện tại. README O1/A1 là tài liệu lịch sử; **không làm theo bước xóa/tạo lại lockfile trong README-A1**. Giữ nguyên `package.json`/`package-lock.json`, dùng `npm.cmd ci`, không tự nâng dependency.

## 1. Prerequisites và build

- Node.js **24.22.0** x64 (prebuild kiểm tra đúng version), npm đi kèm.
- PostgreSQL 17 và `psql` có trong PATH; một instance **riêng cho test**, chỉ listen localhost.
- Chạy PowerShell tại root checkout, rồi vào backend:

```powershell
Set-Location identity-server
node -v
npm.cmd -v
npm.cmd ci
```

Không cần thêm test framework/dependency. Nếu native dependency không hoạt động, dừng kiểm tra lỗi; không tự thay lockfile hoặc tắt security policy để ép test chạy.

## 2. PostgreSQL riêng và credentials local

Không dùng database production/shared development của nhóm. Test issuance và performance harness hiện kiểm tra **host `127.0.0.1`, port `55432`, database `vt113_user_search_test`**; harness còn kiểm tra user `vt113_test`. Chỉ tạo/cấu hình instance riêng nếu đã được phép; không đổi instance chung cho phù hợp test.

Nếu đã có instance riêng, dùng tài khoản quản trị của instance đó để kiểm tra trước. Không in password hoặc đưa password vào command history:

```powershell
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -W
```

Trong psql, kiểm tra đúng instance và database chưa tồn tại. Nếu có dấu hiệu dữ liệu dùng chung hoặc tên role/database đã tồn tại không rõ nguồn gốc: **dừng**, không drop/reuse tự động.

```sql
SELECT version(), current_setting('data_directory'), current_setting('listen_addresses');
SELECT datname FROM pg_database;
SELECT rolname FROM pg_roles WHERE rolname = 'vt113_test';
```

Chỉ trên instance riêng mới, quản trị viên có thể tạo role/database (mỗi lần setup một lần):

```sql
CREATE ROLE vt113_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password vt113_test
CREATE DATABASE vt113_user_search_test OWNER vt113_test;
\q
```

Nhập password ngẫu nhiên riêng qua prompt; lưu trong secret store local, không trong repo. Role sở hữu DB test đủ chạy migration hiện hữu; không cần superuser, không cấp quyền trên DB nhóm. Instance phải chỉ listen localhost trước khi tiếp tục.

Cấu hình môi trường tiến trình, không ghi credentials vào `.env` hoặc README:

```powershell
$testCredential = Get-Credential -UserName vt113_test -Message 'Credentials cho database VT-113 riêng'
if ($testCredential.UserName -ne 'vt113_test') { throw 'Sai test user' }
$encodedPassword = [Uri]::EscapeDataString($testCredential.GetNetworkCredential().Password)
$env:DATABASE_URL = 'postgresql://vt113_test:' + $encodedPassword + '@127.0.0.1:55432/vt113_user_search_test?schema=public'
Remove-Variable encodedPassword
```

Không chạy `echo $env:DATABASE_URL`, không đưa URL đầy đủ vào evidence/PR.

## 3. Xác minh isolation trước opt-in và migration

Kết nối bằng test role, đọc identity và quyền thực tế:

```powershell
$env:PGPASSWORD = $testCredential.GetNetworkCredential().Password
try {
    psql -h 127.0.0.1 -p 55432 -U vt113_test -d vt113_user_search_test -X -v ON_ERROR_STOP=1 -c "SELECT current_database(),current_user,inet_server_addr(),inet_server_port(); SHOW listen_addresses; SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user; SELECT datname,has_database_privilege(current_user,oid,'CREATE') AS can_create FROM pg_database;"
    if ($LASTEXITCODE -ne 0) { throw 'Không xác minh được database' }
} finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

Phải thấy đúng database/user/host/port trên, listener localhost và bốn thuộc tính đặc quyền đều false. Quyền CREATE chỉ thuộc database test. Kiểm tra độc lập instance không chứa dữ liệu nhóm; tên kết thúc `_test` **không tự chứng minh isolation**. HBA mặc định có thể cho CONNECT database mặc định; không tự thu hồi quyền PUBLIC trên DB khác.

**Chỉ sau khi người chạy xác nhận các điều kiện này**:

```powershell
$env:VT113_ISOLATED_TEST_DB = 'confirmed'
npm.cmd run db:deploy
if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

`db:deploy` chỉ áp dụng migration hiện hữu. Không dùng `db:migrate`, không đổi schema, không cần recreate lockfile. Generated Prisma client đã được track; nếu cần regenerate trong setup được phép, script hiện có là `npm.cmd run db:generate`, rồi kiểm tra diff generated files.

## 4. Policy và cấu hình OIDC

- `VT113_SEARCH_ACCOUNT_IDS`: UUID account được server cho phép, phân cách bằng dấu phẩy; thiếu/rỗng = **deny**.
- Client được phép: `config.clientId`; resource/audience chính xác `${issuer}/api/users`.
- `users:read` là resource scope, không cấp default cho mọi account/client.
- Eligibility kiểm tra tại consent, token issuance và mỗi Search request; consent không tạo entitlement.
- Resource access token opaque TTL300 giây; Bearer verifier không chấp nhận sender-constrained token khi thiếu proof validation.

Đối với server chạy thủ công, lấy UUID tài khoản đã xác minh từ DB riêng, cấu hình qua prompt phía server (không phải query/header client):

```powershell
$env:VT113_SEARCH_ACCOUNT_IDS = Read-Host 'UUID account được phép, phân cách dấu phẩy; rỗng để deny'
```

Các biến OIDC/port lấy tên từ `.env.example`; dùng issuer/callback/origin nhất quán. `readConfig` vẫn từ chối production vì keys/storage chỉ dành development. Issuance test tự tạo account, đặt allowlist trong config test rồi thu hồi để kiểm tra, không phụ thuộc allowlist môi trường để bỏ qua xác thực.

## 5. Lệnh tests hiện hữu (JavaScript đã build)

Unit parser/service/BVA và COUNT coalescing, không cần PostgreSQL:

```powershell
node --test dist/test/user-search-unit.test.js
```

HTTP contract dùng real provider verifier, repository double chỉ cho dữ liệu; không cần PostgreSQL:

```powershell
node --test dist/test/user-search-http.test.js
```

PostgreSQL filter/order/count/pagination/projection và real OAuth code+S256/login/consent/issuance/Search, sau isolation opt-in:

```powershell
node --test dist/test/user-search-postgres.test.js dist/test/user-search-issuance.test.js
```

Full backend/regression và headers:

```powershell
npm.cmd test
npm.cmd run test:headers
```

`npm.cmd test` tự build và chạy `dist/test/*.test.js`, gồm Registration/Discovery/security regression. Không giả định `npm test` tự load `.env`; `DATABASE_URL` phải có trong môi trường terminal. `test:headers` gồm hai checker tests và script kiểm tra running server; script sau cũng cần database test.

Nếu chưa xác minh DB, chỉ chạy các tests không cần DB:

```powershell
node --test dist/test/user-search-unit.test.js dist/test/user-search-http.test.js dist/test/discovery.test.js dist/test/security-headers.test.js
```

PostgreSQL và issuance tests có skip guard nếu thiếu `VT113_ISOLATED_TEST_DB=confirmed`; **skip không phải PASS integration**. CI hiện hữu chưa bật flag này, vì vậy không dùng badge CI thay bằng chứng hai integration scenarios đã chạy local.

## 6. Performance harness hiện có, bảo toàn evidence

Chỉ chạy trên DB test riêng đã xác minh, không chạy build/tests/profiling đồng thời. Harness seed10000 users, 80 closed-loop HTTP workers, warm-up400 requests một lần, 3 lượt x2000; giữ query mix 25% mỗi loại như JSON evidence. Token do provider model thật tạo và verifier thật kiểm tra; không đo OAuth login throughput. Concurrency80 không có nghĩa 80req/s.

Lệnh có sẵn: `node test/user-search.optimized-run.mjs`. **Không chạy trần trên checkout nộp bài** vì harness ghi đè `docs/vt113-performance-investigation/optimized-benchmark.json`. Dùng wrapper PowerShell sau để lưu kết quả mới ngoài repo và restore historical file, không tạo runner mới hay sửa source:

```powershell
$historical = [IO.Path]::GetFullPath('../docs/vt113-performance-investigation/optimized-benchmark.json')
if (-not (Test-Path -LiteralPath $historical)) { throw 'Missing historical evidence' }
$originalBytes = [IO.File]::ReadAllBytes($historical)
$originalBase64 = [Convert]::ToBase64String($originalBytes)
$runDirectory = Join-Path ([IO.Path]::GetTempPath()) ('vt113-rerun-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $runDirectory | Out-Null
try {
    node test/user-search.optimized-run.mjs 2>&1 | Tee-Object (Join-Path $runDirectory 'console.txt')
    $benchmarkExit = $LASTEXITCODE
    $newBytes = [IO.File]::ReadAllBytes($historical)
    if ([Convert]::ToBase64String($newBytes) -ne $originalBase64) {
        [IO.File]::WriteAllBytes((Join-Path $runDirectory 'result.json'), $newBytes)
    } else {
        Write-Warning 'Không có JSON mới; không coi bản historical là kết quả rerun'
    }
} finally {
    [IO.File]::WriteAllBytes($historical, $originalBytes)
}
Write-Host ('Benchmark exit: ' + $benchmarkExit)
Write-Host ('New output directory: ' + $runDirectory)
git diff --check
```

Quy trình restore trên cần tiến trình PowerShell chạy đến finally; nếu process bị kill thì đối chiếu historical hash trước nộp. Không chạy script khác ghi cùng output đồng thời. Harness có cleanup fixture trong finally; nếu crash, chỉ xử lý marker/IDs của run đã xác định trên DB riêng, không truncate hoặc xóa dữ liệu khác.

Harness baseline/profile cũng ghi output cố định; không chạy để thay thế evidence lịch sử. Profile runner thực tế chạy1 lượt nhưng metadata ghi3; đây là caveat đã công bố. Không cần runner riêng5 lượt theo yêu cầu bài: five-run confirmation đã lưu tại `../docs/vt113-performance-investigation/final-five-runs.json` cùng raw log/cleanup; adaptation5 lượt trước đây là script tạm và có provenance trong hội thoại, không giả nhận nó đang được track.

## 7. Expected results và evidence đã có

Đây là historical results đã lưu, không phải cam kết mọi rerun đều pass:

- Unit36 tests; HTTP1 scenario; PostgreSQL1 scenario; issuance1 scenario. Nhiều assertions nằm trong một scenario.
- Full backend: **52 PASS, 0 FAIL, 0 SKIP**, `coalescing-green-suite.txt`.
- Header checker: **2 PASS**, running-server checks PASS, `headers.txt`.
- Mutation TC12: expected403, actual200; restored byte-for-byte, `../docs/vt113-part4/mutation-*.txt`.
- Coverage line84.50%/branch76.28% là snapshot50-test trước optimization, không phải coverage suite52.
- Baseline performance có2/3 lượt vượt p95; giữ nguyên failures.
- Optimized3 lượt p95: 2.426 / 2.499811 / 1.989 giây; lượt2 sát ngưỡng.
- Final5 lượt p95: 2.246 / 2.142 / 2.165 / 2.274 / 1.972 giây, 0 lỗi/10000 measured requests. Có2 lượt p99 vượt2.5 giây; không nói mọi percentile đạt.

Fixture cleanup ghi nhận0 users. Đọc thêm `../docs/vt113-part5-engineering-evidence.md` và `../docs/vt113-performance-investigation/notes.md` để phân biệt saved execution logs với narrative chỉ có trong hội thoại.

## 8. Limitations, attribution và hygiene

Local repeated-filter benchmark không chứng minh production SLA, unique-filter workload hoặc dataset lớn. Còn thiếu browser Search preflight (Registration CORS regression là phạm vi khác), provider-storage/driver outage thực, toàn bộ CSRF/rate-limit negatives, eligibility đổi giữa code issuance/token exchange, registered second client, Unicode collation và snapshot consistency khi concurrent writes. Không nới security checks để chạy benchmark.

Bốn file authentication/email/login-page/interaction tái sử dụng chọn lọc từ snapshot nhóm PR15 `43ccc619f14542468e642eb88f5231c9c764f655`, chứa lịch sử PR17 `9f7f7d7ba0096ba20afd15bb671f946ff9e7e7b2`; interaction có thêm BTCN eligibility guard. Không nhận source nhóm là code cá nhân hoàn toàn; không merge/cherry-pick PR nhóm. Policy và Search/tests/harness là phần BTCN có AI hỗ trợ.

Cuối phiên:

```powershell
Remove-Item Env:DATABASE_URL, Env:VT113_ISOLATED_TEST_DB, Env:VT113_SEARCH_ACCOUNT_IDS -ErrorAction SilentlyContinue
Remove-Variable testCredential -ErrorAction SilentlyContinue
```

Không commit `.env`, credentials, DPAPI, keys/tokens, database dumps/data, installers, `node_modules` hoặc `dist`. Không in secret vào logs. Chỉ đưa vào commit các file đã review rõ ràng; không dùng `git add .` hoặc `git add -A`.
