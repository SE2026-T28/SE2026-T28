# BT3 VT-111: vai trò `reviewer` (APP-04 Identity Server)

Slice nhỏ trong `identity-server/src/review/`: resource `ReviewItem` (in-memory) và Express router `createReviewRouter({ store, resolveActor, beforeCommit? })`. `admin` đọc/sửa `data` (chỉ khi item còn `pending`; item đã decided bị đóng băng, PATCH -> 409); `reviewer` đọc và approve/reject nhưng không sửa `data`; chống race bằng compare-and-set theo `version` (`If-Match`) và `Idempotency-Key`. Báo cáo: `BT3_24001963_VT-111.md` (PDF cùng tên). Baseline: `b8f400d`.

## Yêu cầu

- Node **24.22.0** (đúng phiên bản; `scripts/check-node.cjs` kiểm tra khi build).
- `cd identity-server && npm ci`.

## Lệnh (chạy trong `identity-server/`)

| Mục đích | Lệnh |
|---|---|
| Build | `npm run build` |
| Test review (offline, không cần DB; 24 test) | `node --test dist/test/review-*.test.js` |
| Coverage | `node --test --experimental-test-coverage --test-coverage-include="dist/src/review/**" dist/test/review-*.test.js` |
| Load 60 concurrent (p95 tệ nhất mỗi round <= 2.0 s; lần chạy gần nhất 222.2 ms) | `node scripts/review-load.mjs` (sau `npm run build`) |
| Regression toàn bộ | `npm run test:isolated -- --driver=native` (cần PostgreSQL 17.11 theo `docs/ci.md`; kết quả mới nhất 120/120, suite chính 89/89) |

## Tái hiện mutation

Trên branch tạm (không dùng branch nộp): áp diff của M1/M2/M3 trong `evidence/04-mutation.log` vào `identity-server/src/review/review-store.ts` (M1 bỏ dòng `if (expectedVersion !== current.version) ...` trong `compareAndSet`; M2 làm `reserve()` luôn trả `{kind:"new"}`), rồi `npm run build && node --test dist/test/review-*.test.js`. Kết quả mong đợi (24 test): M1 6 fail, M2 5 fail, M3 11 fail, 0 cancelled.

## Bản đồ file

| File | Nội dung |
|---|---|
| `docs/bt3-vt111/research.md`, `ai-plan.md`, `spec.md` | research, plan của AI, spec + decision table + test case |
| `docs/bt3-vt111/ai-patch-prompt.md`, `ai-review.md`, `ai-review-verdicts.md` | prompt patch, AI review R1..R10, verdict |
| `docs/bt3-vt111/evidence/00..09-*.log` | baseline, red, green, regression, mutation, coverage, flaky, load, fix R7, fix từ independent review |
| `identity-server/src/review/` | `review-store.ts` (CAS, idempotency), `review.routes.ts` |
| `identity-server/test/review-*.ts` | `review-authz`, `review-concurrency`, `review-store` tests + helpers |
| `identity-server/scripts/review-load.mjs` | load harness |

## Giới hạn

Router chưa mount vào `src/app.ts` (chưa có đăng nhập/role thật); store in-memory nên CAS chỉ đúng trong một process; không test Prisma/PostgreSQL, nhiều instance; idempotency store chưa có TTL.
