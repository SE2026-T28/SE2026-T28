# APP-04 — A1 User Registration tích hợp trên O1

A1 được mount vào Express application của O1. O1 vẫn là nền tảng duy nhất cho `createApp(config)`, OIDC Provider và Discovery. A1 bổ sung `POST /api/users/register`, PostgreSQL/Prisma và Argon2id.

## Phạm vi

- Chuẩn hóa email bằng `trim().toLowerCase()`.
- Kiểm tra email và password (8–128 ký tự).
- Hash password bằng Argon2id.
- Unique email tại PostgreSQL; trả `409 EMAIL_EXISTS` khi trùng.
- Response chỉ chứa `id`, `email`, `createdAt`.
- Registration route dùng CORS allowlist riêng theo `OIDC_CORS_ORIGIN`.
- Dùng một Express app và một HTTP server; `server.ts` là entry point duy nhất.

## Yêu cầu

- Node.js đúng `24.22.0` (được kiểm tra bởi `scripts/check-node.cjs`).
- npm đi cùng Node.js.
- Docker Desktop hoặc PostgreSQL 17 đang chạy.

## Khởi tạo PostgreSQL bằng Docker (Windows PowerShell)

```powershell
docker run --name app04-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=app04 `
  -p 5432:5432 `
  -v app04_pgdata:/var/lib/postgresql/data `
  -d postgres:17
```

Nếu container đã tồn tại:

```powershell
docker start app04-postgres
```

## Cài đặt lần đầu sau khi thay các file A1/O1

Thực hiện trong `identity-server/`:

```powershell
Copy-Item .env.example .env
```

Mở `.env`, kiểm tra `DATABASE_URL` trỏ tới database `app04` và các biến OIDC đúng contract nhóm.

Vì `package.json` đã được hợp nhất từ O1 và A1, cần tạo lockfile mới **một lần**. Không dùng lockfile O1 hoặc A1 cũ:

```powershell
if (Test-Path package-lock.json) { Remove-Item package-lock.json }
npm install
```

Sau khi `npm install` tạo lockfile mới, những lần cài tiếp theo dùng:

```powershell
npm ci
```

Generate Prisma Client và áp dụng migration vào database development:

```powershell
npm run db:generate
npm run db:deploy
```

`db:deploy` áp dụng migration đã có trong `prisma/migrations/`. `db:migrate` dành cho lúc phát triển schema và tạo migration mới.

## Chạy server

```powershell
npm run dev
```

Server kiểm tra config O1, kết nối PostgreSQL trước khi listen và dùng `createApp(config)`.

Để chạy bản đã build:

```powershell
npm run build
npm start
```

## Kiểm tra thủ công

Discovery O1:

```powershell
Invoke-RestMethod http://localhost:3000/.well-known/openid-configuration
```

Đăng ký A1:

```powershell
$body = @{
  email = "student@example.com"
  password = "Example-Password-123!"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/users/register" `
  -ContentType "application/json" `
  -Body $body
```

Kết quả thành công là `201` và `user` chỉ có `id`, `email`, `createdAt`.

## Khởi tạo database test riêng

Tạo database test một lần (không dùng database `app04` để chạy test):

```powershell
docker exec app04-postgres psql -U postgres -d postgres -c "CREATE DATABASE app04_test;"
```

Nếu database đã tồn tại, bỏ qua bước tạo.

Trỏ terminal hiện tại sang database test, chạy migration, rồi test:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/app04_test?schema=public"
npx prisma migrate deploy
npm test
Remove-Item Env:DATABASE_URL
```

`npm test` build TypeScript, chạy Discovery test O1 và Registration tests A1 bằng Node.js `node:test`. Registration test tự tìm port, tự khởi động Express app và tự dọn các tài khoản có prefix `a1-test-`. Test từ chối chạy nếu tên database không kết thúc bằng `_test`.

Các trường hợp được kiểm tra:

1. Đăng ký thành công, Argon2id được lưu trong PostgreSQL và response không có hash.
2. Email trùng, kể cả khác chữ hoa/thường.
3. Email sai định dạng.
4. Password ngắn hơn 8 ký tự.
5. Hai request đồng thời cùng email: một `201`, một `409`.
6. Registration CORS chỉ cho phép origin `http://localhost:5173`.

## Lệnh xác minh trước khi push PR

```powershell
npm ci
npm run db:generate
npm run build

$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/app04_test?schema=public"
npx prisma migrate deploy
npm test
Remove-Item Env:DATABASE_URL

npm audit
```

Ghi lại kết quả thực tế của từng lệnh trong PR. Không đánh dấu test/audit là pass nếu chưa chạy.

## Ghi chú tích hợp

- `src/config.ts` và `test/discovery.test.ts` là phần O1 và được giữ nguyên.
- O1 Provider/Discovery vẫn nằm trong `createApp(config)`; A1 router được mount trước `provider.callback()`.
- Prisma client được khởi tạo lazy để O1 Discovery test có thể import `createApp()` mà không cần mở kết nối database.
- `server.ts` kết nối Prisma trước khi listen và disconnect khi shutdown.
- O1 hiện vẫn từ chối `NODE_ENV=production` vì storage OIDC và signing keys còn ở chế độ development.
- Các phiên bản Prisma đang giữ theo A1 snapshot (`7.10.0`). Cần đối chiếu `npm audit` thực tế để xác định advisory và phiên bản vá tương thích; không tự nâng version hoặc dùng `npm audit fix --force` khi chưa có kết quả advisory.
