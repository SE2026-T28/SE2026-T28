# A2–A3 — User authentication và login form

## Authentication service contract

`src/users/authentication.ts` cung cấp:

- `findUserById(id)`: tra cứu theo UUID, trả `{ id, email }` hoặc `null`.
- `findUserByEmail(email)`: trim + lowercase email trước khi tra cứu; trả `{ id, email }` hoặc `null`.
- `authenticateUser(email, password)`: xác thực Argon2id và trả đúng contract tích hợp Provider: `{ id, email }` khi thành công, `null` khi thất bại.

`passwordHash` chỉ được select nội bộ trong quá trình verify và không bao giờ được trả cho Provider, route hoặc trình duyệt. Các lỗi credentials (email không tồn tại, email sai định dạng, mật khẩu sai hoặc hash không hợp lệ) đều trả `null`; interaction handler phải hiển thị cùng một thông báo lỗi cho các trường hợp này.

## Identity Server login form

`src/users/login-page.ts` export `renderLoginPage({ uid, csrfToken, error? })` để Provider interaction handler dùng khi render trang GET `/interaction/:uid`.

Form gửi `POST /interaction/:uid/login` với các field:

- `_csrf`: token gắn với session/interaction do server tạo.
- `email`: email người dùng.
- `password`: mật khẩu người dùng.

Interaction handler chịu trách nhiệm xác minh `_csrf`, kiểm tra interaction còn hiệu lực, áp dụng rate limit phù hợp, gọi `authenticateUser(email, password)` và chỉ gọi `interactionFinished` khi có account hợp lệ. Với credentials sai, render lại form với `error: "invalid_credentials"`; không phân biệt tài khoản không tồn tại và mật khẩu sai. Với interaction hết hạn, dùng `error: "expired_interaction"`.

Trang form không dùng inline JavaScript/CSS để tương thích CSP đang cấu hình trong `src/security/headers.ts`. Password chỉ được gửi trực tiếp tới Identity Server, không đi qua React demo.

> Phần GET/POST interaction route, session/CSRF implementation, rate limiting và `interactionFinished` thuộc Provider integration (phối hợp PR #15); renderer và authentication service trong PR này là phần nền để ghép vào flow đó.

## Tests

- `test/registration.test.ts`: chỉ kiểm tra A1 Registration.
- `test/authentication.test.ts`: kiểm tra A2 lookup/password verification.
- `test/login-page.test.ts`: kiểm tra HTML login form, URL/HTML escaping và thông báo lỗi.
- `test/helpers.ts`: bootstrap app và database test; chỉ chấp nhận database có tên kết thúc bằng `_test`, đồng thời mỗi suite dọn dữ liệu theo email prefix riêng.

Chạy bằng `npm test` trong `identity-server` với `DATABASE_URL` trỏ tới database test đã migrate.

Vì form gửi `application/x-www-form-urlencoded`, app integration cần mount parser `express.urlencoded({ extended: false, limit: "10kb" })` trước `provider.callback()` (cùng tầng với JSON parser). Không mount parser/route interaction hai lần nếu PR Provider đã cung cấp.
