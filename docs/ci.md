# CI và kiểm tra bảo mật — S4

Workflow `Security foundation` chạy khi mở/cập nhật PR và push vào `main`. Runner dùng Node 24.22.0, chỉ có quyền `contents: read`.

| Job | Nội dung |
| --- | --- |
| applications | Xác nhận mỗi ứng dụng có `package.json` và lockfile |
| backend | Tạo PostgreSQL 17.11 tạm với database `app04_test`; `npm ci`, Prisma generate, deploy migration, `npm test` (build + Discovery/A1/headers), `npm audit --audit-level=high`, kiểm tra headers trên server đang chạy |
| frontend | `npm ci`, `npm test`, `npm run build`, `npm audit --audit-level=high` cho React C1 |
| secrets | Chặn file `.env` được Git theo dõi; Gitleaks 8.30.1 quét lịch sử và nguồn hiện tại, che giá trị phát hiện |

PostgreSQL trong CI là service tạm của job, chỉ chứa dữ liệu test và tự mất khi job kết thúc. `DATABASE_URL` trỏ tới `app04_test`, đáp ứng safety guard trong test A1 và script smoke test headers. Giá trị user/password trong workflow chỉ dùng cho service test cục bộ của runner, không phải credential triển khai. Prisma Client được generate trước khi build/test; migration đã commit được áp dụng trước khi test. Không dùng database thật hoặc `.env` chứa secret trong CI.

## Chạy local

Dùng Node 24.22.0. Với PostgreSQL test riêng đã tạo và tên database kết thúc bằng `_test`, đặt `DATABASE_URL` cho **terminal hiện tại** rồi chạy trong `identity-server/`:

```text
npm ci
npm run db:generate
npm run db:deploy
npm test
npm run test:headers
npm audit --audit-level=high
```

Không chạy `db:deploy` hoặc test A1 với database development/production. `prisma.config.ts` cần `DATABASE_URL` ngay cả khi chạy `db:generate`. `npm test` gồm test A1 truy cập database; `test:headers` khởi động `server.ts`, nên cũng cần PostgreSQL test sẵn sàng. Nếu chỉ kiểm tra test không cần database, có thể chạy bản build với `node --test dist/test/discovery.test.js dist/test/security-headers.test.js`, sau đó `node --test tests/security/check-headers.test.mjs` từ repo root.

Trong `client-demo/`:

```text
npm ci
npm test
npm run build
npm audit --audit-level=high
```

Từ repo root:

```text
node tests/security/check-tracked-env.mjs
gitleaks git . --redact --log-opts=--all
gitleaks dir . --redact
```

Gitleaks có thể chạy bằng binary local; Docker chỉ được dùng để chạy Gitleaks trong GitHub Actions. Script headers chọn cổng tạm, kiểm tra Discovery của server thật rồi dừng tiến trình. Xem [bằng chứng và giới hạn kiểm tra](security-validation.md).

## Trạng thái PR

Nhánh S4 được ghép local với `main` sau khi O1, C1 và A1 đã merge. PR #9 vẫn là Draft và chưa được cập nhật với phần ghép này; kết quả CI cũ của PR #9 không chứng minh code tích hợp hiện tại đạt. Sau khi được phép push, đổi base PR #9 sang `main`, xem diff chỉ có phần S4, chờ cả backend/frontend/secrets jobs chạy trên đúng commit rồi nhờ người khác review. Chỉ đóng issue #6 sau khi các kiểm tra và review cần thiết hoàn thành.
