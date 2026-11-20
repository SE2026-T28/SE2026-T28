# client-demo — React OIDC demo client (APP-04)

SPA React + TypeScript (Vite) đóng vai Relying Party cho Identity Server của APP-04.
Dùng `oidc-client-ts`, Authorization Code + PKCE (S256), không có client secret.

Phạm vi hiện tại (C1–C5): nút Login redirect sang Authorization Endpoint (kèm `nonce` ngẫu nhiên, `prompt=consent`, `resource` của API), route `/callback` đổi code lấy token, xác minh ID Token bằng `jose` rồi hiện dashboard (`sub`, `email` nếu có) cùng dữ liệu từ API bảo vệ `GET <issuer>/api/protected/profile` (C3), tự refresh Access Token một lần khi bị 401 (C4) và logout đầy đủ: thu hồi token rồi RP-initiated logout (C5). Chi tiết ở mục "M3: API bảo vệ, refresh, logout" bên dưới.

## Yêu cầu

- Node.js 24.22.0 LTS (phiên bản nhóm chốt, xem `docs/team-work-plan.md`; đã kiểm tra với 24.22.0), npm
- Identity Server chạy ở `http://localhost:3000` (xem `identity-server/`). Để chạy đủ C3–C5 cần Provider có refresh/revocation/resource indicator (PR #27 `feat/m3-oidc-persistence`) và API bảo vệ (PR #29 `codex/s1-protected-profile`); xem mục chạy thử bên dưới

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

Chỉ chứa URL/định danh public, không secret. Thiếu biến, scope không có `openid` hoặc `VITE_API_RESOURCE` sai -> báo lỗi rõ ràng.

| Biến | Giá trị mặc định |
| --- | --- |
| `VITE_OIDC_AUTHORITY` | `http://localhost:3000` (issuer) |
| `VITE_OIDC_CLIENT_ID` | `app04-react-demo` |
| `VITE_OIDC_REDIRECT_URI` | `http://localhost:5173/callback` |
| `VITE_OIDC_POST_LOGOUT_REDIRECT_URI` | `http://localhost:5173/` |
| `VITE_OIDC_SCOPE` | `openid profile email api:read offline_access` |
| `VITE_API_RESOURCE` (tùy chọn) | mặc định `<authority>/api`; nếu đặt phải là URL http(s) cùng origin với authority, không query/fragment/credentials |

Giá trị khớp `identity-server/.env.example` (nhánh `feat/oidc-provider-discovery`); IdP cho phép CORS origin `http://localhost:5173`.

Lưu ý: `client_id` `app04-react-demo` là giá trị đã chốt với O1 (khớp `identity-server/.env.example`); đổi bằng `VITE_OIDC_CLIENT_ID`.

## Ghi chú thiết kế

- `userStore` và `stateStore` dùng `sessionStorage` (mặc định của thư viện cho state là localStorage).
- `automaticSilentRenew: false`, `loadUserInfo: false`; không tắt PKCE.
- Login (`src/session.ts`): `oidc-client-ts` 3.5.0 không tự sinh `nonce`, nên `login()` sinh 256-bit bằng `crypto.getRandomValues` (base64url) và truyền `signinRedirect({ nonce })`. PKCE S256 và `state` do thư viện sinh; `nonce` nằm trong bản ghi state của thư viện (`sessionStorage`), nên gắn với đúng một `state` (bấm Login hai lần hoặc Back không làm lệch). Nút Login bị disable trong lúc chờ redirect; lỗi khởi tạo login chỉ hiện thông báo cố định (riêng thiếu env var thì giữ gợi ý `ConfigError`: cả lúc tải trang `/` lẫn khi bấm Login; Login vẫn thử lại được khi đã sửa env). Nếu env sai/thiếu thì `/` hiện gợi ý env var thay vì trắng trang, còn `/callback` hiện thông báo lỗi cố định (không dashboard), không hiện text của thư viện.
- Callback `/callback`: URL callback được lấy một lần ở lần render đầu rồi `history.replaceState` ngay (code/state không nằm lại trên thanh địa chỉ); route và URL được giữ trong `src/runtime.ts` nên StrictMode chạy effect hai lần vẫn chỉ gọi `signinRedirectCallback` một lần (guard theo URL). Thư viện kiểm `state` và đổi code với PKCE verifier, nhưng **lưu user trước khi** ta xác minh và **không** kiểm chữ ký ID Token. Ta đọc `nonce` kỳ vọng từ bản ghi state; rỗng/thiếu -> `nonce_mismatch` ngay, trước khi đổi code. Sau đó `src/verify.ts` dùng `jose` (`createRemoteJWKSet` với `jwks_uri` lấy từ Discovery, cache theo `jwks_uri`, `jwtVerify`): chữ ký, `iss` = authority, `aud` = `client_id`, `azp` (bắt buộc bằng `client_id` nếu `aud` có nhiều giá trị; nếu có `azp` thì phải bằng `client_id`), `exp`/`iat` (lệch giờ 30 s), `sub` bắt buộc, `alg` thuộc allowlist giao với `id_token_signing_alg_values_supported` (RS256/PS256/ES256; mặc định RS256; không bao giờ `none`/HS*), rồi so `nonce` (claim phải là chuỗi không rỗng, bằng giá trị kỳ vọng). Thành công -> lưu marker `app04.verified` = SHA-256 của ID Token. Link `/callback` giả mạo (không có `state`, `state` không khớp bản ghi đăng nhập của ta, hoặc `error=` kèm state lạ) chỉ hiện lỗi, **không** xóa user đã lưu hay marker `app04.verified` (người thứ ba không ép đăng xuất được phiên hợp lệ). Khi `state` đã khớp một lần đăng nhập của ta thì fail-closed: mọi lỗi sau đó, kể cả `error=` kèm state khớp và throw bất ngờ (một đường `fail()` duy nhất) -> `removeUser()` (phiên cũ vốn sắp bị thay), xóa marker, ẩn dashboard, hiện thông báo cố định theo loại (OAuth error / state thiếu hoặc sai / thiếu code / đổi token lỗi / ID Token không hợp lệ / nonce lệch); lỗi thư viện được phân loại bằng `instanceof ErrorResponse` và chuỗi lỗi cố định, không bao giờ theo `error_description`. Chỉ hiện mã `error` nằm trong allowlist, không hiện `error_description`, code hay token.
- Reload: không tin `getUser()`; `restoreSession` yêu cầu marker `app04.verified` khớp SHA-256 của ID Token đã lưu (user lưu bởi thư viện nhưng chưa xác minh xong -> không tin), rồi xác minh lại ID Token (chữ ký, iss, aud, azp, exp). Thiếu marker, lệch, sai hoặc hết hạn -> `removeUser()`, xóa marker, coi như chưa đăng nhập. Logout xóa user và marker.
- Dashboard: hiện `sub`; `email` chỉ hiện nếu có trong claims đã xác minh (ID Token của IdP hiện không có email, UserInfo mới có; `loadUserInfo` vẫn tắt). Dashboard chỉ render cho user đã qua xác minh ID Token (callback hoặc `restoreSession`); API chỉ được gọi sau đó. Logout xem mục M3.
- Test dùng khóa RSA sinh bằng `jose` và JWKS cục bộ (inject qua `resolveKeys`), không gọi mạng; token endpoint được stub bằng `fetch`. Test component (`src/App.test.tsx`, StrictMode) dùng `@testing-library/react`.
- Dependency: `jose` 6.2.15 (chạy trong trình duyệt qua Web Crypto); devDependency `@testing-library/react` 16.3.2 + `@testing-library/dom` 10.4.2. Tất cả pin exact (`.npmrc`: `save-exact=true`).

## M3: API bảo vệ, refresh, logout (C3–C5)

Hợp đồng gốc: `docs/m3-token-logout-contract.md` (nhánh `feat/m3-oidc-persistence`). Mọi bảo vệ M2 (chữ ký/iss/aud/exp/nonce ở callback, marker + xác minh lại khi reload) giữ nguyên.

### C3 — route bảo vệ và gọi API

- Login gửi `scope=openid profile email api:read offline_access`, `prompt=consent` (không có thì oidc-provider bỏ `offline_access`), `resource=<issuer>/api` ở authorization request **và** `extraTokenParams: { resource }` ở bước đổi code (thư viện lưu vào state và gửi ở token request).
- `src/profile.ts`: `GET <resource>/protected/profile` với header `Authorization: Bearer <access_token>` (không bao giờ ở query string; `credentials: omit`, `cache: no-store`). Body 200 phải đúng dạng `{"sub": "<string>"}` (đúng một khóa) và `sub` phải bằng `sub` của ID Token đã xác minh, sai -> coi là lỗi, không render.
- Trạng thái UI (thông báo cố định, không bao giờ chứa token hay text của server): đang tải; dữ liệu; 403 `insufficient_scope` -> "không được cấp quyền", không có dữ liệu; 401 -> refresh (C4); hết phiên -> "Your session expired. Please log in again." + nút Login; lỗi mạng/500/body sai -> "Could not load the profile" + nút Retry.
- Gọi API được single-flight (StrictMode chạy effect hai lần vẫn chỉ một request).

### C4 — refresh

- Khi API trả 401 (hoặc Access Token đã hết hạn trước khi gọi) -> đúng một lần `signinSilent({ resource, extraTokenParams: { resource } })` (refresh_token grant; `automaticSilentRenew` vẫn `false`), rồi gọi lại API đúng một lần. 401 lần hai -> xóa phiên, "session expired".
- Single-flight (`refreshSession` trong `src/session.ts`): các caller đồng thời dùng chung một promise; caller đến muộn mà Access Token trong store đã khác token vừa bị 401 thì dùng luôn token mới thay vì xoay refresh token lần nữa (refresh token rotate, request thứ hai sẽ `invalid_grant`).
- Refresh token được xoay: thư viện thay bản lưu bằng token mới.
- Nếu response refresh có `id_token` mới: xác minh lại đầy đủ (chữ ký, iss, aud, azp, exp/iat), **không** đòi `nonce` (OIDC Core 12.2 cho phép vắng), `sub` phải bằng `sub` phiên hiện tại; qua -> marker `app04.verified` cập nhật theo ID Token mới (reload vẫn khôi phục được), trượt -> xóa phiên. Không có `id_token` mới -> ID Token cũ và marker giữ nguyên.
- Refresh thất bại (invalid_grant, bị thu hồi, lỗi mạng, không có refresh token) -> `removeUser()` + xóa marker + dữ liệu bảo vệ trong bộ nhớ -> trạng thái "session expired". Chi tiết lỗi không hiện ra UI.
- Hạn chế đã biết: reload khi ID Token đã hết hạn (`exp`) thì `restoreSession` (M2) vẫn từ chối và yêu cầu đăng nhập lại, kể cả khi refresh token còn sống.

### C5 — logout

Thứ tự trong `logout()`:
1. Thu hồi refresh token ở revocation endpoint (`revokeTokens(["refresh_token"])`; hợp đồng: thu hồi RT thu hồi cả grant và Access Token liên quan; không có RT thì thu hồi access token).
2. Lấy `id_token`, xóa marker + user trong `sessionStorage` + dữ liệu bảo vệ.
3. `signoutRedirect({ id_token_hint, state })` tới `end_session_endpoint` (Discovery) với `post_logout_redirect_uri=http://localhost:5173/`.

- Thu hồi thất bại -> vẫn logout; sau khi quay về hiện cảnh báo "access tokens already issued may stay valid for up to 300 seconds" (chỉ lưu cờ không nhạy cảm trong `sessionStorage`, đọc một lần rồi xóa). RP logout một mình không thu hồi token và UI không nói như vậy.
- Quay về `/` sau logout: cờ `app04.logout.pending` (do ta đặt trước khi chuyển hướng) cho biết đây là lượt trả về của logout; nếu Provider trả `state` (oidc-provider 9.12.2 có echo `state` khi có `post_logout_redirect_uri`) thì `signoutCallback` xử lý và xóa state của thư viện, nếu không echo vẫn hoạt động nhờ cờ; query bị xóa khỏi thanh địa chỉ; hiện "You are logged out.".
- Provider không có `end_session_endpoint` -> chỉ đăng xuất cục bộ và báo rõ như vậy.
- Back/forward: khi trang được khôi phục từ bfcache (`pageshow` với `persisted`) ta chạy lại `restoreSession`; không còn phiên thì dashboard và dữ liệu API biến mất. Reload sau logout không còn user trong store nên không có dữ liệu.
- Token chỉ nằm trong `sessionStorage` qua store của `oidc-client-ts`; `localStorage` luôn rỗng (có test).

### Chạy thử với Provider (PR #27) và API (PR #29)

PR #27 và #29 chưa merge vào `main` tại thời điểm viết. Cần một nhánh tích hợp chứa cả hai (ví dụ merge `feat/m3-oidc-persistence` và `codex/s1-protected-profile` vào một nhánh tạm), cấu hình theo `identity-server/.env.example` của PR #27 (PostgreSQL, `OIDC_ADAPTER_KEY`, `OIDC_COOKIE_KEYS`, CORS origin `http://localhost:5173`), chạy Identity Server ở `http://localhost:3000`, rồi `cp .env.example .env && npm run dev` và thử: Login (màn consent có `api:read`) -> dashboard + dữ liệu API -> chờ Access Token hết hạn (300 s) hoặc xóa nó để thấy refresh -> Logout (màn xác nhận của Provider) -> quay về `/`. Kết quả chạy thật được ghi ở `docs/m3-client-test-matrix.md`; hiện **chưa** có.
