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

Giữ lockfile đã được review và cài dependency bằng:

```powershell
npm ci
```

Generate Prisma Client và áp dụng migration vào database development:

```powershell
npm run db:generate
$env:APP04_ALLOW_DEV_MIGRATIONS = "1"
npm run db:deploy
Remove-Item Env:APP04_ALLOW_DEV_MIGRATIONS
```

`db:deploy` áp dụng migration đã có trong `prisma/migrations/`. Development chỉ chấp nhận database `app04` tại loopback, không phải production. Cờ opt-in trên cho phép thao tác development có chủ ý, không chứng minh isolation. Khi được duyệt phát triển schema, dùng cùng opt-in và `npm run db:migrate -- --name ten_migration`; Prisma migrate dev có thể tạo shadow database, chỉ chạy trên instance development cá nhân. Không dùng migrate dev trong harness test.

Wrapper khóa `prisma.config.ts`, schema và thư mục migrations; chỉ cho thêm `--name` hợp lệ với migrate dev. Không truyền `--config`, `--schema`, `--url` hoặc lệnh Prisma tùy ý. `db:generate` ngoài harness không kết nối database. Đường development được giữ lại nhưng không được thực thi trong đợt kiểm thử S3.

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

Không tạo `app04_test` trong container development và không tái sử dụng database có sẵn. Harness tạo instance PostgreSQL 17.11 mới với credential ngẫu nhiên và cổng loopback tạm:

```powershell
npm run test:isolated -- --driver=docker
```

Trên Windows có PostgreSQL 17.11 cài tại `C:/Program Files/PostgreSQL/17/bin` (hoặc đặt `S3_POSTGRES_BIN`), có thể dùng cluster native mới:

```powershell
npm run test:isolated -- --driver=native
```

Harness đối chiếu system identifier từ control file với server sống, data directory, startup time và database chính xác `app04_test` trước migration/test. Session capability chỉ tồn tại trong lượt chạy; `S3_TEST_DATABASE_ISOLATED=1` không được coi là bằng chứng. Không xác minh được thì từ chối, không fallback sang development. Harness generate client, chạy safety tests, deploy hai lần, toàn bộ backend tests/build, hai suite fixture song song và kiểm tra headers; cuối lượt xác nhận 0 user, thu hồi session và dừng instance sở hữu.

Registration test gửi HTTP đến app thật. Fixture cấp email riêng từng scope; mọi registration phải dùng `track()`. Cleanup đóng scope ngay, chờ thao tác đang chạy (kể cả lỗi sau khi ghi), rồi xóa đúng danh sách email của scope. Không xóa theo prefix. Nếu xóa lỗi, giữ danh sách để retry. Kill process/mất điện hoặc ghi DB ngoài `track()` không được bảo đảm cleanup; runtime riêng nằm trong `node_modules/.s3-runs` được Git ignore và có thể chứa log nhạy cảm, không đưa vào báo cáo/Git.

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

npm run test:isolated -- --driver=native

npm audit
```

Ghi lại kết quả thực tế của từng lệnh trong PR. Không đánh dấu test/audit là pass nếu chưa chạy.

CI Linux dùng driver Docker thay native. `npm test`, `db:deploy`, `db:status`, `test:headers` cần session harness hợp lệ hoặc (chỉ các lệnh database) development opt-in rõ ràng. CLI mặc định từ chối `db push`, `db execute`, seed/reset và lệnh không qua wrapper. Đây là guard cho entry point dự án, không phải sandbox: người dùng chạy Prisma với config bên ngoài, sửa script hoặc tự kết nối SQL có thể bỏ qua nó. Những đường đó không được tuyên bố đã bảo vệ.

## Ghi chú tích hợp

- `src/config.ts` và `test/discovery.test.ts` là phần O1 và được giữ nguyên.
- O1 Provider/Discovery vẫn nằm trong `createApp(config)`; A1 router được mount trước `provider.callback()`.
- Prisma client được khởi tạo lazy để O1 Discovery test có thể import `createApp()` mà không cần mở kết nối database.
- `server.ts` kết nối Prisma trước khi listen và disconnect khi shutdown.
- O1 hiện vẫn từ chối `NODE_ENV=production` vì storage OIDC và signing keys còn ở chế độ development.
- Các phiên bản Prisma đang giữ theo A1 snapshot (`7.10.1`). Cần đối chiếu `npm audit` thực tế để xác định advisory và phiên bản vá tương thích; không tự nâng version hoặc dùng `npm audit fix --force` khi chưa có kết quả advisory.
