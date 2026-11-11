# A2–A3 — User authentication và login form

## Authentication service contract

`src/users/authentication.ts` cung cấp:

- `findUserById(id)`: chỉ nhận UUID hợp lệ, tra cứu theo UUID và trả `{ id, email }` hoặc `null`.
- `findUserByEmail(email)`: trim + lowercase email như A1 trước khi tra cứu; trả `{ id, email }` hoặc `null`.
- `authenticateUser(email, password)`: xác thực Argon2id và trả `{ id, email }` khi thành công, `null` khi thất bại.

`passwordHash` chỉ được select nội bộ trong quá trình verify; không được trả cho Provider, route hoặc trình duyệt. Email không tồn tại, email sai định dạng, mật khẩu sai và hash hỏng đều là thất bại chung (`null`). Interaction handler phải hiển thị cùng một thông báo cho các lỗi credential.

`id` là UUID ổn định từ `users.id`. Không dùng email làm `sub`/`accountId`.

## Identity Server login form

`src/users/login-page.ts` export `renderLoginPage({ uid, csrfToken, error? })` để Provider interaction handler render trang GET `/interaction/:uid`.

Form gửi `POST /interaction/:uid/login` với `application/x-www-form-urlencoded` và các field chính xác:

- `csrf`: token do OIDC interaction handler tạo và kiểm tra.
- `email`: email người dùng.
- `password`: mật khẩu người dùng.

Form không dùng inline JavaScript/CSS và escape `uid`/CSRF token khi render. Password chỉ được gửi trực tiếp tới Identity Server, không đi qua React demo.

## Contract cần OIDC/Provider cung cấp (ngoài phạm vi branch Authentication)

Branch này chỉ cung cấp account service và renderer; không tự tạo route interaction, session OIDC, authorization code hoặc token. Interface tích hợp:

```ts
type AuthenticateUser = (
  email: string,
  password: string,
) => Promise<{ id: string; email: string } | null>;
```

Provider integration cần:

1. `GET /interaction/:uid`: gọi `provider.interactionDetails(req, res)`, xác nhận UID/prompt còn hợp lệ rồi render `renderLoginPage({ uid, csrfToken })` khi prompt là `login`.
2. `POST /interaction/:uid/login`: parse urlencoded với giới hạn body; xác nhận UID/prompt, interaction chưa hết hạn và CSRF hợp lệ trước khi gọi `authenticateUser(email, password)`.
3. Khi `authenticateUser` trả `null`, không gọi `interactionFinished`; email không tồn tại và mật khẩu sai phải có cùng status/thông báo/HTML có thể quan sát từ phía người dùng. Khi thành công, chỉ hoàn tất login với `accountId: account.id`.
4. `findAccount(ctx, sub)` phải tra `sub` bằng `findUserById`; `sub`/`accountId` phải luôn là `users.id`. Chỉ trả claim `email` khi scope `email` được cấp. Không phát `email_verified: true` vì A1 chưa có xác minh email; không tạo profile giả.
5. OIDC module chịu trách nhiệm session, CSRF validation, rate limit và test các trường hợp từ chối. Cơ chế CSRF cần gắn token với interaction/browser context phù hợp và được test cả token thiếu, sai, hết hạn/replay. Rate limit phải nêu rõ ngưỡng, cửa sổ, key (interaction/email/IP) và hành vi từ chối.

Form hiện dùng field `csrf`, không phải `_csrf`. Interaction router cần mount `express.urlencoded({ extended: false, limit: "10kb" })` trước router tương ứng; không mount parser/route interaction hai lần. `createApp`/`server.ts` cần inject service xác thực từ `src/users/authentication.ts`, không copy logic hoặc tạo service riêng.

## Tests và cách chạy

- `test/registration.test.ts`: A1 Registration.
- `test/authentication.test.ts`: A2 lookup UUID/email, chuẩn hóa email, verify Argon2id đúng/sai và không trả `passwordHash`.
- `test/login-page.test.ts`: HTML form, field `csrf`, URL/HTML escaping và thông báo lỗi.
- `test/helpers.ts`: chỉ chạy integration test trên database có tên kết thúc bằng `_test`; mỗi suite dùng email prefix riêng.

Chạy trong `identity-server` sau khi áp migration vào database test riêng:

```bash
npm run db:deploy
npm test
```

Dùng `DATABASE_URL` trỏ `app04_test` khi test; development dùng `app04`. Không commit `.env`, dữ liệu thật, mật khẩu hoặc hash.

## Ranh giới nghiệm thu

Branch Authentication chịu trách nhiệm service tra cứu/xác thực và renderer form. Việc chứng minh route OIDC kết thúc interaction, trả code/token, claims, CSRF/rate limit và luồng browser React → Provider → callback cần phối hợp với PR OIDC và module React; không thể xem test hàm Authentication độc lập là hoàn thành A3.
