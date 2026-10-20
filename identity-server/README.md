# APP-04 Identity Server — O1

Nền TypeScript + Express + `oidc-provider` cho issue O1. Hiện tại server công bố OIDC Discovery và đăng ký React demo dưới dạng public client. Login/MFA, Authorization Code + PKCE flow xuyên suốt, PostgreSQL adapter và token lifecycle thuộc các issue tiếp theo.

## Chạy local

Yêu cầu Node.js **24.22.0** và npm đi kèm. Tại thư mục gốc repo:

```bash
nvm install
nvm use
cd identity-server
cp .env.example .env
npm ci
npm test
npm run build
npm start
```

Nếu máy chưa có `nvm`, cài Node.js 24.22.0 bằng cách khác rồi kiểm tra `node --version`. Node.js dùng `--env-file` để đọc `.env`; không cần Python `venv`. `node_modules`, `dist` và `.env` được Git bỏ qua.

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

React client không có `client_secret`. Mỗi máy có thể sửa `.env` local, nhưng issuer, port và các URL client phải khớp nhau. Nếu TV3 đổi callback/origin, cập nhật cả provider, client và tài liệu trong cùng thay đổi.

## Giới hạn của O1

Server hiện dùng adapter bộ nhớ và signing keys mặc định chỉ dành cho phát triển; trạng thái sẽ mất khi khởi động lại. Giao diện đăng nhập thử nghiệm mặc định của `oidc-provider` đã tắt để tránh đăng nhập bằng thông tin bất kỳ. Server từ chối chạy với `NODE_ENV=production` cho đến khi các issue về interaction, khóa ký và persistence được hoàn thành. Cookie signing key được tạo ngẫu nhiên mỗi lần chạy local; chưa dùng cho session bền vững.

Nếu thiếu biến môi trường hoặc issuer/origin không khớp, server dừng với thông báo cấu hình. `.env.example` chỉ chứa giá trị local mẫu, không chứa secret.
