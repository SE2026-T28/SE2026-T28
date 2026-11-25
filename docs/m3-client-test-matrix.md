# M3 — Ma trận kiểm thử React client (C3–C5, issue #25)

Phạm vi: `client-demo/` trên nhánh `feat/m3-client-c3-c5`. Hợp đồng gốc: `docs/m3-token-logout-contract.md` (nhánh `feat/m3-oidc-persistence`, PR #27). API bảo vệ: PR #29 (`codex/s1-protected-profile`).

## Quy ước

- **PASS** = test tự động đã chạy và mọi assertion đạt. **NOT RUN** = chưa thực thi. Không ghi PASS cho thứ chưa chạy.
- Mọi test dưới đây là test đơn vị/component (vitest + happy-dom + React Testing Library). Provider và API được **mô phỏng bằng `fetch` stub**; ID Token ký thật bằng `jose` (khóa RSA sinh trong test). Đây **không** thay thế E2E với Provider/API thật.

## Lệnh và môi trường

| Mục | Giá trị |
| --- | --- |
| Commit được kiểm thử | `<SHA>` (sửa review PR #30 6022783087; trước đó `77d2dd9`) |
| Lệnh | `cd client-demo && npm test && npm run typecheck && npm run build && npm audit --audit-level=high` |
| Node | v24.22.1 (Windows 11); nhóm chốt 24.22.0 |
| vitest / happy-dom | 5.0.4 / 21.0.4 |
| `npm test` | 7 file, **187 test PASS**, 0 fail |
| `npm run typecheck` | PASS (không lỗi) |
| `npm run build` | PASS (69 module, `dist/assets/index-*.js` 321.88 kB, gzip 96.67 kB) |
| `npm audit --audit-level=high` | PASS (`found 0 vulnerabilities`) |

## Ma trận

| ID | Ca kiểm thử | Test (file > nhóm > tên) | Kết quả |
| --- | --- | --- | --- |
| C3-01 | Authorize URL có `resource`, `prompt=consent`, scope `api:read` + `offline_access`, PKCE S256, `nonce` | `m3.test.ts > C3 login request > authorize URL has resource, prompt=consent, …` | PASS (b4851a2) |
| C3-02 | Token exchange body có `resource` và `code_verifier` | `m3.test.ts > C3 login request > the code exchange body carries resource …` | PASS |
| C3-03 | `VITE_API_RESOURCE`: mặc định `<authority>/api`, override cùng origin, từ chối URL sai/khác origin/query/fragment/credentials | `config.test.ts > readConfig > apiResource > *` (10 test, gồm chuẩn hóa URL: host viết hoa, `/` cuối) | PASS |
| C3-04 | 200: Bearer ở header, không token trong URL/query, `credentials: omit`, sub khớp | `m3.test.ts > C3 loadProfile > 200: Bearer header only, …` | PASS |
| C3-05 | `sub` API khác `sub` ID Token -> lỗi, không render | `m3.test.ts > … rejects a sub that differs …`; `App.m3.test.tsx > … sub mismatch: fixed error, …` | PASS |
| C3-06 | Body 200 sai dạng (khóa thừa, thiếu/không phải chuỗi/rỗng `sub`, mảng, null, không phải JSON) | `m3.test.ts > C3 loadProfile > rejects a 200 body with *` (7 test) | PASS |
| C3-07 | 403 `insufficient_scope`: trạng thái forbidden, không dữ liệu, không refresh, giữ phiên | `m3.test.ts > … 403: forbidden, no data, no refresh, session kept`; `App.m3.test.tsx > … 403: safe message, no data` | PASS |
| C3-08 | 500, lỗi mạng và từ chối CORS (trình duyệt không đọc được 403 `origin_not_allowed`: `fetch` reject `TypeError`, mô phỏng bằng stub ném `TypeError`) -> trạng thái `error` với thông báo cố định, không text server; Retry tải lại | `m3.test.ts > … 500 and a CORS rejection (fetch rejects with TypeError) …`, `… network error …`; `App.m3.test.tsx > … 500: fixed message …`, `… network error: fixed message` | PASS |
| C3-09 | Dashboard/API không hiện với user chưa xác minh (thiếu marker) | `App.m3.test.tsx > … an unverified stored user never reaches the API or the dashboard` | PASS |
| C3-10 | Trạng thái loading trước khi có dữ liệu; không lộ token/JWT trong DOM | `App.m3.test.tsx > … shows loading, then the API data …` (+ `expectNoSecrets`) | PASS |
| C3-11 | Gọi API single-flight (StrictMode/đồng thời); lượt tải của user khác không bị gộp | `m3.test.ts > … concurrent loads (StrictMode) share one API call`, `… concurrent loads for different users are not merged` | PASS |
| C4-01 | 401 -> một refresh -> retry thành công với token mới; refresh token bị xoay | `m3.test.ts > … 401 -> one refresh -> retry succeeds …`; `App.m3.test.tsx > … 401 + refresh success …` | PASS |
| C4-02 | 401 -> refresh `invalid_grant` -> phiên bị xóa (user + marker), "session expired" | `m3.test.ts > … 401 -> refresh invalid_grant …`; `App.m3.test.tsx > … 401 + refresh failure …` | PASS |
| C4-03 | 401 lần hai sau refresh -> xóa phiên, đúng một refresh | `m3.test.ts > … 401 again after the refresh …` | PASS |
| C4-04 | Access Token đã hết hạn -> refresh trước khi gọi API | `m3.test.ts > … an already expired Access Token is refreshed …` | PASS |
| C4-05 | Refresh trả ID Token mới: xác minh lại (nonce không bắt buộc; nếu có phải bằng nonce gốc, xem C4-10), cập nhật marker, reload khôi phục được | `m3.test.ts > C4 refreshSession > re-verifies the new ID Token …` | PASS |
| C4-06 | Refresh không có `id_token` mới: marker nhất quán, reload khôi phục được | `m3.test.ts > … a response without id_token keeps the verified marker consistent` | PASS |
| C4-07 | ID Token refresh sai chữ ký / aud / iss / hết hạn / khác `sub` -> xóa phiên | `m3.test.ts > … rejects a refreshed ID Token (*)` (5 test) | PASS |
| C4-10 | ID Token refresh có `nonce`: phải bằng `nonce` của ID Token gốc (sai/gốc không có -> xóa phiên); kiểm `sub`/`nonce` của client chạy trực tiếp qua `verifyRefreshedIdToken` (không phụ thuộc kiểm tra của thư viện) | `m3.test.ts > C4 refreshSession > … a refreshed ID Token with a nonce that differs …`, `… repeating the original nonce is accepted`, `verifyRefreshedIdToken (our own checks, library bypassed) > *` (5 test) | PASS |
| C4-08 | `invalid_grant`, lỗi mạng, không có refresh token -> xóa phiên | `m3.test.ts > … invalid_grant clears …`, `… a network failure during refresh …`, `… no refresh token …` | PASS |
| C4-09 | Single-flight: nhiều caller một request refresh; caller muộn dùng token đã refresh | `m3.test.ts > … is single-flight …`, `… reuses a token another caller already refreshed …`, `C3 loadProfile > concurrent 401s trigger a single refresh`; StrictMode: `App.m3.test.tsx > … StrictMode causes one refresh` | PASS |
| C5-01 | Thu hồi refresh token trước `signoutRedirect`; state đã xóa tại thời điểm điều hướng; URL có `id_token_hint`, `post_logout_redirect_uri`, `state` | `m3.test.ts > C5 logout > revokes the refresh token first, …` | PASS |
| C5-02 | Thu hồi lỗi (HTTP 500 hoặc mạng) -> vẫn logout + cờ cảnh báo không nhạy cảm | `m3.test.ts > … revocation failure still logs out …`, `… revocation network error …` | PASS |
| C5-03 | Không có refresh token -> thu hồi access token; không có `end_session_endpoint` -> logout cục bộ | `m3.test.ts > … without a refresh token …`, `… no end_session_endpoint …`; `App.m3.test.tsx > … Provider without end_session …` | PASS |
| C5-04 | Quay về `/`: có/không có `state` echo, state lạ, truy cập thường; query bị xóa; cảnh báo 300 s hiện một lần | `m3.test.ts > C5 post-logout return > *` (5 test); `App.m3.test.tsx > … return from the Provider …`, `… return after a failed revocation …` | PASS |
| C5-05 | Reload sau logout không có dữ liệu bảo vệ | `m3.test.ts > … after logout a reload finds no session`; `App.m3.test.tsx > … reload after logout …` | PASS |
| C5-06 | Back/forward (bfcache `pageshow persisted`) ẩn ngay dữ liệu phiên, bật lại Login, rồi kiểm tra lại phiên; `pageshow` thường giữ phiên | `App.m3.test.tsx > logout UI > bfcache restore …`, `… a non-persisted pageshow …` | PASS |
| C5-07 | Luồng UI Logout: thu hồi + chuyển hướng + xóa user/marker, `localStorage` rỗng | `App.m3.test.tsx > … Logout revokes, clears, redirects …` | PASS |
| C5-08 | `logout()` chờ refresh đang chạy rồi thu hồi refresh token đã xoay; refresh yêu cầu sau khi logout bắt đầu bị từ chối và không ghi gì; nhánh `local_only` xóa phiên lại sau khi `signoutRedirect` lỗi và cho phép refresh trở lại | `m3.test.ts > C5 logout > waits for an in-flight refresh …`, `… a refresh requested after logout started is refused …`, `… local_only: clears again …` | PASS |
| C5-09 | Bấm Logout: Dashboard/`api-sub` biến khỏi DOM ngay (trước khi điều hướng, khi thu hồi còn chờ), màn "Logging out…"; Back (bfcache): không dữ liệu bảo vệ, Login bật, "You are logged out." | `App.m3.test.tsx > logout UI > Logout removes protected data before navigation; Back (bfcache) restores a usable Login` | PASS |
| C5-10 | Cờ `app04.logout.pending`/`revoke_failed`: `login()` xóa trước khi chuyển hướng; `pageshow persisted` đọc-một-lần và hiện cảnh báo 300 s | `m3.test.ts > C3 login request > clears stale logout flags …`; `App.m3.test.tsx > … a persisted pageshow after a failed-revocation logout …` | PASS |
| C5-11 | Sau logout `redirected` (trang đóng băng trong bfcache), đăng nhập ở trang khác rồi Back: `pageshow persisted` gọi `endLogoutGuard()` nên refresh chạy lại được (không bị báo hết phiên) | `m3.test.ts > C5 logout hardening > endLogoutGuard: …`; `App.m3.test.tsx > bfcache restore after logout > a restored page can refresh …` | PASS |
| C5-12 | `logout()` chỉ chờ refresh treo tối đa 5 s (fake timers: 4999 ms chưa thu hồi, 5000 ms thì thu hồi); refresh đến muộn trả `ok:false` và xóa user/marker, không ghi lại | `m3.test.ts > C5 logout hardening > a hung refresh delays logout by at most the bounded wait; …` | PASS |
| C5-13 | `logout()` không xóa được phiên thì trả `clear_failed` (không ném), cờ chặn refresh được đặt lại, refresh hoạt động lại | `m3.test.ts > C5 logout hardening > a logout that cannot clear resets the guard …`; `logout-failure.test.ts > … clear_failed resets the guard …` | PASS |
| C5-14 | `pageshow persisted` xóa thông báo cũ (cảnh báo thu hồi lỗi không còn sau lần khôi phục thứ hai) | `App.m3.test.tsx > bfcache restore after logout > a persisted pageshow clears the previous notice` | PASS |
| C5-15 | Lỗi `removeItem` marker -> `clear_failed`, marker còn (báo trung thực), user vẫn bị xóa, không redirect, không cờ pending | `logout-failure.test.ts > marker removeItem throws …` | PASS |
| C5-16 | `removeUser()` reject / user store `removeItem` ném SecurityError -> `clear_failed`, user còn trong store, marker vẫn bị xóa, không redirect | `logout-failure.test.ts > userManager.removeUser rejects …`, `… user store removeItem throws SecurityError …` | PASS |
| C5-17 | Không đọc lại được (user store `getItem` / marker `getItem` ném) -> `clear_failed` (fail closed); mọi method storage ném -> không ném, `clear_failed` | `logout-failure.test.ts > … getItem throws (cannot read back) …`, `… marker getItem throws …`, `… whole storage denied …` | PASS |
| C5-18 | Thu hồi lỗi + xóa lỗi -> `clear_failed`, không đặt cờ cảnh báo thu hồi | `logout-failure.test.ts > revocation fails AND clear fails …` | PASS |
| C5-19 | `localStorage` ném lỗi không ảnh hưởng (logout không dùng); `setItem` cờ riêng bị QuotaExceeded -> cờ best effort, vẫn redirect, đã xóa sạch | `logout-failure.test.ts > localStorage access throwing …`, `… QuotaExceeded when writing our flags …` | PASS |
| C5-20 | `signoutRedirect` lỗi sau khi xóa sạch -> `local_only`; lỗi và lần xóa lại cũng lỗi (ghi muộn) -> `clear_failed`, không bao giờ `local_only`; thiếu `end_session_endpoint` -> `local_only`, reload không có phiên | `logout-failure.test.ts > signoutRedirect fails after a clean local clear …`, `… and the re-clear fails …`, `… end_session_endpoint missing …` | PASS |
| C5-21 | UI: `clear_failed` hiện alert "Logout failed …", KHÔNG có "You are logged out." / thông báo `local_only`, không Dashboard, không redirect; "Retry logout" thành công khi storage hồi phục; `local_only` vẫn được gắn nhãn khi đã xóa sạch; bấm Logout hai lần chỉ thu hồi một lần | `App.m3.test.tsx > logout UI: clear failures never look like success > *` (4 test) | PASS |
| C5-22 | `clearAndVerify` fail closed: một bước xóa ném (`removeItem`) thì `clear_failed` dù đọc lại trông sạch (không cần mock `removeUser`) | `logout-failure.test.ts > removeItem throws but read-back looks clean …`; `m3.test.ts > … a logout that cannot clear resets the guard …` | PASS |
| C5-23 | Epoch logout: refresh treo quá 5 s, logout kết thúc `local_only` (`signoutRedirect` reject, hoặc thiếu `end_session_endpoint`) rồi mới thả refresh -> kết quả `ok:false`, user `null`, marker `null`, reload không có phiên | `logout-failure.test.ts > late refresh after a bounded-wait logout … > local_only (signoutRedirect rejects) …`, `… local_only (no end_session_endpoint) …` | PASS |
| C5-24 | Cùng kịch bản với `clear_failed`: kết quả muộn bị bỏ, không ghi marker, `ok:false`; refresh bắt đầu SAU logout thất bại không bị epoch chặn | `logout-failure.test.ts > … clear_failed: late refresh result is discarded too …`, `… a refresh started after the failed logout is not affected …` | PASS |
| ST-01 | `localStorage` rỗng suốt login, refresh, gọi API, logout (token chỉ ở `sessionStorage`) | `m3.test.ts > storage > localStorage stays empty …` | PASS |
| M2-REG | Toàn bộ test M2 còn lại (callback, nonce, verify, restore, config) | `session.test.ts`, `App.test.tsx`, `auth.test.ts`, `config.test.ts` (phần M2) | PASS |

## Test M2 đã đổi và lý do

- `App.test.tsx`, `auth.test.ts`, `session.test.ts`, `config.test.ts`: literal config thêm `apiResource`, scope mới `openid profile email api:read offline_access`; `login()` nhận thêm `apiResource`. Hành vi M2 được kiểm không đổi.
- `auth.test.ts`: kỳ vọng `scope` của authorize URL là scope mới (đổi có chủ đích theo hợp đồng).
- `App.test.tsx`: Dashboard giờ gọi API bảo vệ nên (a) `fetch` mặc định được stub, (b) số lần gọi `fetch` đếm riêng token endpoint (vẫn đúng 1 lần đổi code), (c) stub token endpoint trả `{"sub":"user-1"}` cho `/protected/profile`.

## Chưa chạy (NOT RUN)

| ID | Ca | Trạng thái | Lý do / điều kiện |
| --- | --- | --- | --- |
| E2E-C3-C5 | Browser E2E: Login -> consent `api:read` -> dashboard + API thật -> refresh thật (xoay RT) -> Logout (màn xác nhận của Provider, thu hồi thật) -> quay về `/` -> Back/Reload, với **Provider thật (PR #27) và API thật (PR #29)** | **NOT RUN** | PR #27 và #29 chưa merge vào một commit tích hợp. Chạy sau khi có nhánh tích hợp; ghi kèm SHA, trình duyệt/phiên bản, HTTP status, boolean `has_token`, không ghi giá trị token/code/state. |
| E2E-ECHO | Xác nhận trên Provider thật rằng `state` được echo ở post-logout redirect (đã đọc `lib/actions/end_session.js` của oidc-provider 9.12.2: có echo khi có `post_logout_redirect_uri`) | **NOT RUN** | Chỉ xác minh bằng đọc mã nguồn; client hoạt động cả khi không echo (có test). |
| E2E-REV | Xác nhận Provider thật: sau thu hồi refresh token thì access token đã cấp bị từ chối ngay; refresh token cũ báo `invalid_grant` | **NOT RUN** | Hành vi phía Provider/API (PR #27/#29), client chỉ gọi revocation endpoint. |
| CORS-LIVE | Preflight/CORS thật từ `http://localhost:5173` tới `/api/protected/profile` | **NOT RUN** | Cần API thật; test chỉ mô phỏng từ chối CORS bằng `fetch` reject `TypeError` (không phải phản hồi đọc được). |
