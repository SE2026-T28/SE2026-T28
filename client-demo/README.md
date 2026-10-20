# client-demo — React OIDC demo client (APP-04)

SPA React + TypeScript (Vite) đóng vai Relying Party cho Identity Server của APP-04.
Dùng `oidc-client-ts`, Authorization Code + PKCE (S256), không có client secret.

Phạm vi hiện tại (C1): scaffold + nút Login redirect sang Authorization Endpoint.
Route `/callback` chỉ hiện placeholder — đổi code lấy token và validate ID token thuộc **C2**.

## Yêu cầu

- Node.js 24.22.0 LTS (phiên bản nhóm chốt, xem `docs/team-work-plan.md`; đã kiểm tra với 24.22.0), npm
- Identity Server chạy ở `http://localhost:3000` (xem `identity-server/`)

## Chạy local

```bash
cd client-demo
cp .env.example .env
npm ci
npm run dev        # http://localhost:5173 (strictPort, port bị chiếm thì lỗi)
```

Mở http://localhost:5173, bấm **Login** -> trình duyệt chuyển tới Authorization Endpoint lấy từ Discovery
(`<authority>/.well-known/openid-configuration`), không hard-code. Nếu IdP chưa chạy, trang hiện thông báo lỗi.

## Lệnh

| Lệnh | Việc |
| --- | --- |
| `npm run dev` | Dev server, port 5173 |
| `npm test` | Vitest (happy-dom) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck + build vào `dist/` |
| `npm run preview` | Serve bản build, port 5173 |

## Cấu hình (`.env`)

Chỉ chứa URL/định danh public, không secret. Thiếu biến hoặc scope không có `openid` -> báo lỗi rõ ràng.

| Biến | Giá trị mặc định |
| --- | --- |
| `VITE_OIDC_AUTHORITY` | `http://localhost:3000` (issuer) |
| `VITE_OIDC_CLIENT_ID` | `app04-react-demo` |
| `VITE_OIDC_REDIRECT_URI` | `http://localhost:5173/callback` |
| `VITE_OIDC_POST_LOGOUT_REDIRECT_URI` | `http://localhost:5173/` |
| `VITE_OIDC_SCOPE` | `openid profile email` |

Giá trị khớp `identity-server/.env.example` (nhánh `feat/oidc-provider-discovery`); IdP cho phép CORS origin `http://localhost:5173`.

Lưu ý: `client_id` `app04-react-demo` theo `identity-server/.env.example`; tài liệu kế hoạch nhóm ghi `app04-demo` — chờ xác nhận, đổi bằng `VITE_OIDC_CLIENT_ID`.

## Ghi chú thiết kế

- `userStore` và `stateStore` dùng `sessionStorage` (mặc định của thư viện cho state là localStorage).
- `automaticSilentRenew: false`, `loadUserInfo: false`; không tắt PKCE.
- `oidc-client-ts` 3.5.0 chỉ hỗ trợ `response_type=code` và không tự sinh `nonce`: chỉ gửi `nonce` khi truyền qua `signinRedirect({ nonce })`. C1 chưa truyền nên authorize request không có `nonce`; C2 sẽ sinh `nonce` ngẫu nhiên và truyền vào, thư viện sẽ đối chiếu với claim `nonce` của ID token ở callback.
- Dependency pin exact (`.npmrc`: `save-exact=true`).
