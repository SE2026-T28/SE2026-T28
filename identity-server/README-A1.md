# APP-04 — A1: Đăng ký người dùng

## Phạm vi
- PostgreSQL `users` table với email unique.
- API `POST /api/users/register`.
- Chuẩn hóa email và kiểm tra đầu vào.
- Hash mật khẩu bằng Argon2id; không trả password hash về client.
- Xử lý email trùng bằng HTTP 409.

## Cài đặt
Yêu cầu Node.js đúng phiên bản trong `.nvmrc` và PostgreSQL 17.

```bash
npm install --save-exact
cp .env.example .env
# Tạo database app04 hoặc cập nhật DATABASE_URL trong .env
npm run db:generate
npm run db:migrate
npm run dev
```

Nếu tích hợp vào repo chính, hãy đưa các file này vào `identity-server/`, rồi chạy lệnh từ thư mục đó. Với Prisma 7, `DATABASE_URL` được cấu hình trong `prisma.config.ts`.

## API
`POST /api/users/register`

```json
{
  "email": "student@example.com",
  "password": "example-password"
}
```

- `201 Created`: trả về `user` gồm `id`, `email`, `createdAt`.
- `400 Bad Request`: email/mật khẩu không hợp lệ.
- `409 Conflict`: email đã tồn tại.
- `500 Internal Server Error`: lỗi máy chủ không dự kiến.

Không gửi `passwordHash` hoặc mật khẩu trong response/log.

## Kiểm tra thủ công
1. Đăng ký email mới: mong đợi `201`.
2. Đăng ký lại cùng email (không phân biệt chữ hoa/thường): mong đợi `409`.
3. Email sai định dạng hoặc mật khẩu dưới 8 ký tự: mong đợi `400`.
4. Kiểm tra bảng `users`: chỉ có `password_hash`, không có cột mật khẩu thô.
5. Kiểm tra response: không chứa `passwordHash`.

## Lưu ý tích hợp
- Đây là scaffold A1 độc lập vì repo tải lên chưa có `package.json` hoặc code server hiện hữu.
- Cần xác nhận lại các phiên bản dependency bằng `npm install`, build và chạy trên môi trường nhóm.
- Cần bổ sung test tự động chạy với PostgreSQL test database trước khi đánh dấu A1 Done.
- Endpoint này chưa tự đăng nhập người dùng hoặc tạo OIDC session; đó thuộc các task A2/A3 và tích hợp với TV2.
