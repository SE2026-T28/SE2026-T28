# client-demo — React OIDC demo client (APP-04)

SPA React + TypeScript (Vite) đóng vai Relying Party cho Identity Server của APP-04.
Dùng `oidc-client-ts`, Authorization Code + PKCE (S256), không có client secret.

Phạm vi hiện tại (C1 + C2): nút Login redirect sang Authorization Endpoint (kèm `nonce` ngẫu nhiên), route `/callback` đổi code lấy token, xác minh ID Token bằng `jose` rồi hiện dashboard tối thiểu (`sub`, `email` nếu có). Gọi API bảo vệ (C3) và RP-initiated logout (C5) chưa làm.

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

Lưu ý: `client_id` `app04-react-demo` là giá trị đã chốt với O1 (khớp `identity-server/.env.example`); đổi bằng `VITE_OIDC_CLIENT_ID`.

## Ghi chú thiết kế

- `userStore` và `stateStore` dùng `sessionStorage` (mặc định của thư viện cho state là localStorage).
- `automaticSilentRenew: false`, `loadUserInfo: false`; không tắt PKCE.
- Login (`src/session.ts`): `oidc-client-ts` 3.5.0 không tự sinh `nonce`, nên `login()` sinh 256-bit bằng `crypto.getRandomValues` (base64url) và truyền `signinRedirect({ nonce })`. PKCE S256 và `state` do thư viện sinh; `nonce` nằm trong bản ghi state của thư viện (`sessionStorage`), nên gắn với đúng một `state` (bấm Login hai lần hoặc Back không làm lệch). Nút Login bị disable trong lúc chờ redirect; lỗi khởi tạo login chỉ hiện thông báo cố định (riêng thiếu env var thì giữ gợi ý `ConfigError`: cả lúc tải trang `/` lẫn khi bấm Login; Login vẫn thử lại được khi đã sửa env). Nếu env sai/thiếu thì `/` hiện gợi ý env var thay vì trắng trang, còn `/callback` hiện thông báo lỗi cố định (không dashboard), không hiện text của thư viện.
- Callback `/callback`: URL callback được lấy một lần ở lần render đầu rồi `history.replaceState` ngay (code/state không nằm lại trên thanh địa chỉ); route và URL được giữ trong `src/runtime.ts` nên StrictMode chạy effect hai lần vẫn chỉ gọi `signinRedirectCallback` một lần (guard theo URL). Thư viện kiểm `state` và đổi code với PKCE verifier, nhưng **lưu user trước khi** ta xác minh và **không** kiểm chữ ký ID Token. Ta đọc `nonce` kỳ vọng từ bản ghi state; rỗng/thiếu -> `nonce_mismatch` ngay, trước khi đổi code. Sau đó `src/verify.ts` dùng `jose` (`createRemoteJWKSet` với `jwks_uri` lấy từ Discovery, cache theo `jwks_uri`, `jwtVerify`): chữ ký, `iss` = authority, `aud` = `client_id`, `azp` (bắt buộc bằng `client_id` nếu `aud` có nhiều giá trị; nếu có `azp` thì phải bằng `client_id`), `exp`/`iat` (lệch giờ 30 s), `sub` bắt buộc, `alg` thuộc allowlist giao với `id_token_signing_alg_values_supported` (RS256/PS256/ES256; mặc định RS256; không bao giờ `none`/HS*), rồi so `nonce` (claim phải là chuỗi không rỗng, bằng giá trị kỳ vọng). Thành công -> lưu marker `app04.verified` = SHA-256 của ID Token. Link `/callback` giả mạo (không có `state`, `state` không khớp bản ghi đăng nhập của ta, hoặc `error=` kèm state lạ) chỉ hiện lỗi, **không** xóa user đã lưu hay marker `app04.verified` (người thứ ba không ép đăng xuất được phiên hợp lệ). Khi `state` đã khớp một lần đăng nhập của ta thì fail-closed: mọi lỗi sau đó, kể cả `error=` kèm state khớp và throw bất ngờ (một đường `fail()` duy nhất) -> `removeUser()` (phiên cũ vốn sắp bị thay), xóa marker, ẩn dashboard, hiện thông báo cố định theo loại (OAuth error / state thiếu hoặc sai / thiếu code / đổi token lỗi / ID Token không hợp lệ / nonce lệch); lỗi thư viện được phân loại bằng `instanceof ErrorResponse` và chuỗi lỗi cố định, không bao giờ theo `error_description`. Chỉ hiện mã `error` nằm trong allowlist, không hiện `error_description`, code hay token.
- Reload: không tin `getUser()`; `restoreSession` yêu cầu marker `app04.verified` khớp SHA-256 của ID Token đã lưu (user lưu bởi thư viện nhưng chưa xác minh xong -> không tin), rồi xác minh lại ID Token (chữ ký, iss, aud, azp, exp). Thiếu marker, lệch, sai hoặc hết hạn -> `removeUser()`, xóa marker, coi như chưa đăng nhập. Logout xóa user và marker.
- Dashboard: hiện `sub`; `email` chỉ hiện nếu có trong claims đã xác minh (ID Token của IdP hiện không có email, UserInfo mới có; `loadUserInfo` vẫn tắt). Logout chỉ `removeUser()` cục bộ.
- Test dùng khóa RSA sinh bằng `jose` và JWKS cục bộ (inject qua `resolveKeys`), không gọi mạng; token endpoint được stub bằng `fetch`. Test component (`src/App.test.tsx`, StrictMode) dùng `@testing-library/react`.
- Dependency: `jose` 6.2.15 (chạy trong trình duyệt qua Web Crypto); devDependency `@testing-library/react` 16.3.2 + `@testing-library/dom` 10.4.2. Tất cả pin exact (`.npmrc`: `save-exact=true`).
