# APP-04 — Authentication Demo (Node.js + PostgreSQL)

Demo đăng ký/đăng nhập dành cho đề tài **OIDC Identity Server và ứng dụng mẫu**. Phạm vi hiện tại là module authentication nền tảng, chưa phải OIDC server hoàn chỉnh.

## Tính năng

- Đăng ký tài khoản với username, email, password và xác nhận password.
- Validate đầu vào phía server bằng Zod.
- Chuẩn hóa username/email và chống trùng bằng unique constraint trong PostgreSQL.
- Băm mật khẩu bằng **Argon2id**; không lưu mật khẩu plaintext.
- Đăng nhập bằng email hoặc username, với thông báo lỗi không tiết lộ tài khoản có tồn tại hay không.
- Session lưu trong PostgreSQL, cookie `HttpOnly`, `SameSite=Lax`; `Secure` bật khi `NODE_ENV=production`.
- Regenerate session ID sau đăng nhập để giảm nguy cơ session fixation.
- CSRF token cho form POST, rate limit cơ bản cho signup/login và Helmet security headers.
- Audit event signup/login/logout; không ghi password hoặc token vào audit.
- Trang profile lấy thông tin từ database.

## Yêu cầu

- Node.js 20+
- Docker Desktop (khuyến nghị) hoặc PostgreSQL 16+

## Chạy nhanh bằng Docker

1. Mở terminal trong thư mục project.
2. Khởi động PostgreSQL:

   ```bash
   docker compose up -d db
   ```

3. Tạo file `.env` từ mẫu:

   **Windows PowerShell**
   ```powershell
   Copy-Item .env.example .env
   ```

   **macOS/Linux**
   ```bash
   cp .env.example .env
   ```

4. Mở `.env`, đặt `SESSION_SECRET` thành chuỗi ngẫu nhiên dài ít nhất 32 ký tự. Ví dụ tạo secret bằng Node.js:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Dùng kết quả đó cho `SESSION_SECRET`. `DATABASE_URL` trong mẫu khớp với PostgreSQL local của Docker Compose.

5. Cài dependencies và tạo schema:

   ```bash
   npm install
   npm run db:migrate
   ```

6. Chạy server:

   ```bash
   npm start
   ```

7. Mở http://localhost:3000, vào **Tạo tài khoản**, đăng ký, rồi đăng nhập.

## Quy tắc đăng ký

- Username: 3–30 ký tự, chỉ chữ ASCII, số và `_`.
- Email: phải đúng định dạng cơ bản và tối đa 254 ký tự.
- Password: 12–128 ký tự.
- Password confirmation phải khớp.
- Username và email không phân biệt chữ hoa/thường khi kiểm tra trùng.
- Password hash lưu ở cột `password_hash`; không có endpoint trả hash về client.

Đây là validation MVP, không phải xác minh quyền sở hữu email. Nếu yêu cầu sản phẩm cần email verification, phải thêm luồng gửi và xác minh email trước khi coi tài khoản là đã xác minh.

## Xem dữ liệu trong PostgreSQL

```bash
docker exec -it app04-auth-db psql -U app_user -d app04_auth
```

Trong `psql`:

```sql
SELECT id, username, email, password_hash, created_at, last_login_at FROM users;
SELECT event_type, user_id, occurred_at FROM audit_events ORDER BY occurred_at DESC;
SELECT sid, expire FROM user_sessions;
```

`password_hash` sẽ là chuỗi Argon2id, không phải password gốc. Không chia sẻ hoặc chụp màn hình thông tin nhạy cảm khi demo.

## Kịch bản demo cho giảng viên

1. Mở `/signup` và gửi form rỗng/sai định dạng → server từ chối.
2. Đăng ký username/email hợp lệ và password tối thiểu 12 ký tự → chuyển sang login.
3. Thử đăng ký lại username hoặc email đó → bị từ chối bởi unique constraint.
4. Đăng nhập với mật khẩu sai → thông báo chung, không tiết lộ tài khoản có tồn tại.
5. Đăng nhập đúng bằng email hoặc username → đến `/profile`.
6. Kiểm tra PostgreSQL: user row có `password_hash`, session row tồn tại, audit event được ghi.
7. Đăng xuất → cookie bị xóa và session phía server bị hủy; truy cập `/profile` sẽ quay về login.

## Bảng dữ liệu

- `users`: thông tin tài khoản, password hash, trạng thái và thời điểm đăng nhập gần nhất.
- `user_sessions`: bảng session do `connect-pg-simple` quản lý.
- `audit_events`: các sự kiện bảo mật ở mức tối thiểu, không chứa mật khẩu/token.

## Giới hạn và lưu ý bảo mật

- Đây là **demo học tập chạy local**, chưa được audit độc lập và chưa nên public ra Internet.
- Chưa tích hợp `oidc-provider`, authorization code + PKCE, refresh/revoke theo OAuth/OIDC, consent hoặc MFA. Đây là phần tiếp theo của APP-04.
- MFA chưa được mô phỏng trong module này.
- Cần thêm test tự động, email verification, chính sách phục hồi tài khoản, quản trị session và hardening theo threat model trước khi xem là MVP hoàn chỉnh.
- Rate limit hiện dùng memory store mặc định; khi chạy nhiều instance, chuyển sang store dùng chung.
- Khi deploy HTTPS sau reverse proxy, cấu hình `TRUST_PROXY=true` chỉ khi proxy thực sự đáng tin cậy; giữ `SESSION_SECRET` bí mật và dùng TLS được cấu hình đúng cho PostgreSQL.
- Không log password, token, cookie hay session ID. Không dùng thông tin cá nhân/mật khẩu thật trong demo.
- Google Fonts chỉ phục vụ giao diện; có thể bỏ dòng `@import` trong `public/styles.css` nếu muốn demo offline hoàn toàn.

## Kiến trúc request

`Browser → Express routes → Zod validation → Argon2id → PostgreSQL`

Session ID chỉ nằm trong cookie; trạng thái session được lưu phía server trong PostgreSQL. Sau khi login thành công, session ID được regenerate.
