# APP-04 Identity Server — O1–O5

Nền TypeScript + Express + `oidc-provider` cho O1–O5. Server công bố Discovery, đăng ký React demo dưới dạng public client và cung cấp interaction login/consent. Xác thực mật khẩu A2–A3 đã nối vào server. M3 lưu Provider artifact trong PostgreSQL và bật refresh, revocation, RP logout; MFA, protected API và React client thuộc các issue tích hợp riêng.

## Chạy local

Yêu cầu Node.js **24.22.0** và npm đi kèm. Tại thư mục gốc repo:

```bash
nvm install
nvm use
node --version  # phải là v24.22.0
cd identity-server
cp .env.example .env
npm ci
npm test
npm run build
npm start
```

Nếu máy chưa có `nvm`, cài Node.js 24.22.0 bằng cách khác rồi kiểm tra `node --version`. Node.js dùng `--env-file` để đọc `.env`; không cần Python `venv`. `node_modules`, `dist` và `.env` được Git bỏ qua.

Nếu terminal đã mở từ trước khi cài `nvm` và vẫn hiện Node 12, chạy `source ~/.nvm/nvm.sh && nvm use` ngay trong terminal đó (ở thư mục repo hoặc `identity-server`), sau đó kiểm tra lại `node --version` và `which node`. Các lệnh build/start sẽ dừng sớm với thông báo rõ ràng nếu Node không đúng phiên bản.

Mở terminal khác để kiểm tra Discovery:

```bash
curl -fsS http://localhost:3000/.well-known/openid-configuration
```

Kết quả phải có `issuer` bằng `http://localhost:3000`, cùng `authorization_endpoint`, `token_endpoint`, `jwks_uri` và `code_challenge_methods_supported` có `S256`. `npm test` tự động kiểm tra các trường này. Endpoint chính xác được lấy từ JSON Discovery, không tự đặt path trong client.

## Contract local cho nhóm

| Mục | Giá trị |
| --- | --- |
| Issuer | `http://localhost:3000` |
| Public `client_id` | `app04-react-demo` |
| Redirect URI | `http://localhost:5173/callback` |
| Post-logout URI | `http://localhost:5173/` |
| Scopes | `openid profile email` |
| CORS origin | `http://localhost:5173` |

M3 thêm `api:read offline_access`, `resource` mặc định local là `http://localhost:3000/api`, Access Token 300 giây và Refresh Token 3600 giây. Client phải gửi `resource` trong authorization, code exchange và refresh, đồng thời yêu cầu consent rõ ràng khi xin `offline_access`. Xem [hợp đồng M3](../docs/m3-token-logout-contract.md) để nối React và protected API. `OIDC_COOKIE_KEYS` nhận một hoặc nhiều khóa 32 byte dạng hex, phân cách bằng dấu phẩy; `OIDC_ADAPTER_KEY` là khóa 32 byte hex riêng để mã hóa payload trong PostgreSQL. Cần giữ ổn định cả hai khóa để session và token sống qua restart. Không commit các khóa này.

React client không có `client_secret`. Mỗi máy có thể sửa `.env` local, nhưng issuer, port và các URL client phải khớp nhau. Nếu TV3 đổi callback/origin, cập nhật cả provider, client và tài liệu trong cùng thay đổi.

## Giới hạn của O1

Server dùng PostgreSQL adapter cho OIDC artifacts; payload được mã hóa AES-256-GCM, các lookup ID/index được hash. Signing keys mặc định của `oidc-provider` vẫn chỉ dành cho phát triển; server từ chối `NODE_ENV=production` đến khi có quản lý khóa ký riêng. Giao diện đăng nhập thử nghiệm mặc định của Provider đã tắt. Nếu không cấu hình `OIDC_COOKIE_KEYS` hoặc `OIDC_ADAPTER_KEY`, state đã lưu không đọc được sau restart. Row hết hạn được dọn mỗi giờ khi server chạy.

Nếu thiếu biến môi trường hoặc issuer/origin không khớp, server dừng với thông báo cấu hình. `.env.example` chỉ chứa giá trị local mẫu, không chứa secret.

## Interaction M2 và điểm ghép A2–A3

Provider redirect browser tới `GET /interaction/:uid` khi cần login hoặc consent. Form login gửi `POST /interaction/:uid/login` với `email`, `password`, `csrf`; consent gửi `POST /interaction/:uid/consent` với `allow`, `csrf`. Provider kiểm tra `uid` và prompt bằng `interactionDetails` trước khi xử lý; cookie của interaction phải khớp với `uid`, sau đó mới kiểm token CSRF. Form token tồn tại tối đa 10 phút; login giới hạn 5 lần thất bại cho mỗi interaction và mỗi email trong 15 phút, 20 lần thất bại cho mỗi IP trong 15 phút. Email được băm HMAC với khóa chỉ ở bộ nhớ trước khi lưu trong bộ đếm; không lưu email thô ở đây. Bộ đếm sẽ mất sau restart và chưa được chia sẻ giữa nhiều instance. Nếu chạy nhiều process, mỗi process có bộ đếm độc lập nên các ngưỡng trên không còn là giới hạn toàn hệ thống; cần kho rate limit chung trước khi triển khai nhiều instance.

Một interaction chỉ nhận một POST login đang xử lý tại một thời điểm. POST đồng thời với cùng token nhận `409` trước khi gọi Authentication; sau mật khẩu sai hoặc lỗi service, form còn hạn được mở lại để người dùng thử tiếp. Login thành công xóa form trước khi Provider hoàn tất interaction. Cơ chế giữ trạng thái này cũng ở memory của một process, cùng giới hạn triển khai như rate limit.

`createApp(config, authenticateUser)` nhận hàm `AuthenticateUser` từ `src/interactions/routes.ts`: `(email, password) => Promise<{ id, email } | null>`. `src/server.ts` đã truyền service A2–A3 của Nam: chuẩn hóa email như A1, kiểm Argon2id và trả `null` chung cho email không tồn tại hoặc sai mật khẩu. Nếu tạo app mà không truyền hàm này (ví dụ test Discovery độc lập), login trả 503 và không hoàn tất interaction. Không dùng account giả trong server.

Provider dùng UUID `users.id` làm `accountId`/`sub` và tra user theo ID qua service A2–A3 trong PostgreSQL. Scope `email` có email thật nhưng chưa có `email_verified=true`. Trong Authorization Code flow đã kiểm thử, ID Token mang `sub`/`nonce`; email được lấy qua UserInfo khi scope tương ứng được cấp. React chỉ nên hiển thị email từ claim đã xác minh/cấp hợp lệ.

Public client bắt buộc PKCE; `plain` và thiếu challenge bị từ chối, chỉ dùng S256. Test `test/interactions.test.ts` kiểm tra yêu cầu authorization, CSRF và giới hạn thử độc lập DB. Test `test/oidc-flow.test.ts` dùng PostgreSQL cô lập do harness quản lý, đăng ký user thật qua A1 rồi xác thực Argon2id qua A2–A3 để kiểm tra login, consent, code, ID Token `sub`, UserInfo email và code dùng lại. Test HTTP này chưa chứng minh callback React trong browser; phần đó cần C2.

Helmet CSP cho phép `form-action` tới chính Identity Server và đúng `OIDC_CORS_ORIGIN` đã cấu hình. Chrome kiểm tra toàn bộ chuỗi redirect của form login/consent: nếu chỉ cho `'self'`, bước consent có thể hoàn tất ở Provider nhưng callback sang React bị chặn. Test `test/security-headers.test.ts` giữ ràng buộc origin; smoke test browser cần xác nhận consent → callback sau mỗi lần đổi CSP hoặc redirect URI. Không dùng wildcard cho `form-action`.

OIDC state, grant và session dùng PostgreSQL adapter. Signing keys vẫn là development defaults; production tiếp tục bị chặn. Cookie và adapter keys đổi sau restart nếu không được cấu hình. Không lưu mật khẩu hoặc token vào log.
