# Spec — BT3 VT-111: vai trò `reviewer` (APP-04 OIDC Identity Server)

Baseline: `b8f400d`. Branch: `feat/bt3-vt111-reviewer-role`. Mọi `file:line` bên dưới đã được mở và kiểm tra trên baseline này.

## 1. Problem statement

Change request: "Thêm vai trò reviewer có quyền đọc và phê duyệt nhưng không được sửa dữ liệu gốc". Repo hiện chưa có khái niệm role nào: model `User` chỉ có `id, email, passwordHash` và timestamps (`identity-server/prisma/schema.prisma:10-18`), và `findUserById` chỉ select `id`, `email` (`identity-server/src/users/authentication.ts:23-29`). Slice này thêm module `identity-server/src/review/` gồm một resource `ReviewItem` (dữ liệu gốc `data = {title, body}`, `status`, `version`) và Express router `createReviewRouter({ store, resolveActor, beforeCommit? })`. Role `admin` đọc và sửa `data`; role `reviewer` đọc và approve/reject nhưng không bao giờ sửa `data`; mọi role khác bị deny. Rủi ro chính: "race condition khi hai yêu cầu đồng thời cùng thay đổi một tài nguyên" (hai approve/reject cùng lúc, hoặc PATCH chen vào giữa lúc review), dẫn tới lost update hoặc một item bị quyết định hai lần. Slice dùng store in-memory, không Prisma, router không mount vào `src/app.ts` (chưa có cơ chế đăng nhập reviewer); test mount router lên một express app mới.

Ngoài phạm vi: persistence Prisma/Postgres, multi-process, gán role cho user thật, UI.

## 2. Acceptance criteria

Fixture chung: `ReviewItem` id cố định, `data = {title:"T", body:"B"}`, `status=pending`, `version=1`. Token: `admin-token -> admin`, `reviewer-token -> reviewer`, `guest-token -> role "guest"`.

- **AC1 — Đọc.** Given item tồn tại. When `admin` hoặc `reviewer` gọi `GET /review-items/:id`. Then 200, body `{item}`, header `ETag: "v1"`. Role khác -> 403, không token -> 401, id không tồn tại -> 404.
- **AC2 — Approve giữ nguyên data gốc.** Given item `pending`, `version=1`. When `reviewer` gọi `POST /review-items/:id/decision` với `{decision:"approve"}`, `If-Match: "v1"`, `Idempotency-Key: k1`. Then 200, `status=approved`, `decidedBy=<reviewer id>`, `decidedAt` set (từ injectable clock), `version=2`, và `data` byte-identical (so sánh `JSON.stringify`) với trước khi approve. `reject` tương tự với `status=rejected`.
- **AC3 — Reviewer không sửa được.** Given item bất kỳ. When `reviewer` gọi `PATCH /review-items/:id` với `{title:"X"}` (có hoặc không có `If-Match`). Then 403, `data` và `version` không đổi. Ngược lại `admin` gọi `POST .../decision` -> 403 (separation of duties).
- **AC4 — Concurrency: đúng một request thắng.** Given item `pending`, `version=1`. When N request (N = 2 và N = 60) cùng `If-Match: "v1"`, mỗi request một `Idempotency-Key` khác nhau, chạy đồng thời (`Promise.all`) qua `beforeCommit` có độ trễ bất đồng bộ. Then đúng một response 200, N-1 response 412, `version=2`, không có lost update (`decidedBy`/`status` khớp request thắng), và `data` không đổi. Tương tự PATCH admin đồng thời cùng version: một 200, còn lại 412.
- **AC5 — Idempotent retry và dùng sai key.** Given một decision đã thành công với key `k1`. When gửi lại cùng `k1` và cùng fingerprint (itemId + decision + If-Match). Then trả lại đúng status và body đã lưu (200), không apply lần hai (`version` vẫn 2). Cùng `k1` nhưng fingerprint khác -> 422. Cùng `k1` khi request đầu còn đang chạy -> 409. Thiếu `Idempotency-Key` -> 400.

## 3. Non-functional constraints

- **NFR1 — Hiệu năng.** 60 request đồng thời tới router qua HTTP thật (`app.listen(0)`), p95 nearest-rank (rank = `ceil(95*60/100)` = 57) <= 2.0 s; ghi thêm p50, max, số lỗi. Giới hạn đã biết: client và server chung một event loop, số đo lạc quan, không phản ánh DB hay nhiều instance (`docs/bt3-vt111/research.md` mục 6).
- **NFR2 — Test offline, deterministic.** Không DB, không network ngoài loopback, không `Math.random`/thời gian thật trong assertion (clock và token được inject). Toàn bộ suite `review-*.test.ts` chạy < 10 s. Chạy bằng `node --test dist/test/review-*.test.js` sau `tsc` (không qua `npm test`, xem mục 5 dòng P5).
- **NFR3 — Bảo mật.** Deny by default: không có actor -> 401, role không nằm trong bảng quyền -> 403; role chỉ lấy từ `resolveActor(req)`, không từ body/query. Không log token hay `Authorization` header; response lỗi không chứa giá trị token.

## 4. Invariant quan trọng nhất

> `data` của một `ReviewItem` chỉ thay đổi qua `PATCH` của `admin` có `If-Match` khớp version hiện tại; mỗi chuyển version (v -> v+1) được apply tối đa một lần; một item `pending` được quyết định tối đa một lần.

Hệ quả kiểm thử được: reviewer không có đường nào ghi vào `data`; sau N request đồng thời cùng version thì `version = 1 + (số request thắng) = 2`; retry cùng `Idempotency-Key` không làm `version` tăng thêm.

Cơ chế: `store.compareAndSet(id, expectedVersion, mutate)` kiểm tra version và ghi trong một đoạn code đồng bộ (không `await` giữa check và write). Service `await beforeCommit()` giữa lúc đọc và lúc ghi để mô phỏng I/O latency, nên guard phải nằm ở CAS chứ không ở lần đọc. Idempotency key được reserve đồng bộ trước `await` đầu tiên. Mutation dự kiến: "bỏ idempotency/concurrency guard" = bỏ so khớp version trong `compareAndSet` và bỏ reservation key; test AC4/AC5 phải đỏ.

Thứ tự kiểm tra của POST decision (cố định để decision table xác định): 401 -> 403 (role) -> 404 -> 400 (thiếu `Idempotency-Key`) -> 428 (thiếu `If-Match`) -> 400 (`decision` không hợp lệ) -> tra idempotency (replay / 422 / 409 in-flight / reserve) -> 412 (version cũ) -> 409 (status không còn `pending`) -> CAS. Idempotency được tra trước 412/409 để retry sau thành công (lúc này version đã cũ, status đã decided) vẫn nhận lại response đã lưu. Lỗi 4xx/5xx do guard phía sau không để lại reservation dở dang: nếu `beforeCommit` throw thì reservation được release.

## 5. Review kế hoạch AI (`docs/bt3-vt111/ai-plan.md`)

| # | Điểm trong plan | Verdict | Evidence |
|---|---|---|---|
| P1 | Optimistic locking bằng `version` + `If-Match`; 428 thiếu header, 412 version cũ, 409 sai state (`ai-plan.md:40`, `:49-52`) | Accept | Khớp RFC 9110/6585 như tổng hợp ở `research.md:19-26`. Giữ nguyên ngữ nghĩa mã trạng thái. |
| P2 | `If-Match: <version>` không có dấu nháy (`ai-plan.md:40`) | Modify | RFC 9110 8.8.3 yêu cầu entity-tag là chuỗi quoted; contract dùng `ETag: "v<version>"` và `If-Match: "v<version>"` (`research.md:24`). |
| P3 | Thêm Prisma: `Role` enum, `User.role`, bảng `Submission`, migration SQL (`ai-plan.md:58`, `:65`) | Reject cho slice này | Test Postgres chỉ chạy qua harness cô lập: `npm test` có `pretest` gọi `check-test-database.mjs` (`identity-server/package.json:21-22`) và script đó fail nếu không có managed instance (`identity-server/scripts/check-test-database.mjs:3-8`); harness yêu cầu PostgreSQL 17.11 qua `initdb`/Docker (`identity-server/scripts/run-isolated-tests.mjs:53`, `:69`; `docs/ci.md:5`, `:18`). Ràng buộc "chạy không cần dịch vụ ngoài" (`ai-plan.md:4`, `:86`) và NFR2 xung đột với thay đổi schema. Giữ store in-memory, Prisma ghi là limitation. |
| P4 | Idempotency: approve lặp lại cùng reviewer trên item đã APPROVED trả 200 no-op; `Idempotency-Key` out of scope (`ai-plan.md:52`) | Reject | Không phân biệt được retry của cùng request với request thứ hai, xung đột, từ reviewer khác (cùng quyết định, version cũ). Cả hai nhận 200 dù chỉ một cái thực sự được apply, và quyết định khác trả 409 dù có thể chỉ là retry sau mạng lỗi. Thay bằng `Idempotency-Key` bắt buộc, khóa theo (actorId, key), fingerprint itemId+decision+If-Match, replay/422/409 (`research.md:34-41`). |
| P5 | Test Postgres cho authz/concurrency "dùng harness managed-Postgres hiện có" (`ai-plan.md:86`) | Modify | Helper hiện có gọi `assertManagedDatabase()` ngay đầu (`identity-server/test/helpers.ts:25`), nên không dùng được cho test offline. Test review tự dựng express app + `listen(0)`; `fetch` có sẵn (đã dùng ở `identity-server/test/discovery.test.ts:37`); `supertest` không có trong `package.json` (devDependencies chỉ gồm `@types/*`, `prisma`, `tsx`, `typescript`, `package.json:38-45`) nên không thêm dependency. |
| P6 | Giả định "chưa verify": không có role và không có auth middleware cho API, nên tự thêm `requireAuth` (`ai-plan.md:12-15`) | Accept (đã xác minh), Modify phạm vi | Xác minh: không có role trong schema (`schema.prisma:10-18`), `/api/users` chỉ có CORS + JSON parser + `userRouter` (`app.ts:51-54`), `authenticateUser` chỉ dùng cho `/interaction` (`app.ts:45`, `:89`; kiểu ở `identity-server/src/interactions/routes.ts:8`). Tiền lệ "inject hàm xác thực" đúng, nên dùng `resolveActor(req)` inject vào router, không thêm file `src/auth/*`. |
| P7 | Sửa `src/users/authentication.ts` để lộ role (`ai-plan.md:59`) | Reject | `AccountForProvider = Pick<User,"id"\|"email">` (`authentication.ts:9`) và select chỉ `id,email` (`:25-28`); `User` không có cột role để lộ ra. Sửa file này kéo theo schema + migration (xem P3) và chạm đường OIDC login không liên quan. Router không mount nên không sửa `src/app.ts` (plan `:57` định sửa) và `authentication.ts`. |
| P8 | Resource `Submission` có `ownerId`, DRAFT/SUBMITTED, owner edit và submit (`ai-plan.md:22-28`) | Modify | Change request chỉ có đọc/approve/không sửa data gốc; owner/submit là scope creep. Rút gọn thành `ReviewItem` với `pending -> approved\|rejected` và role `admin` sửa `data`. Plan tự thừa nhận resource là "a guess" (`ai-plan.md:14`, `:90`). |
| P9 | Chặn race Approve/Reject qua predicate `status` trong một `UPDATE` duy nhất (`ai-plan.md:49-51`) | Accept (ý tưởng), Modify (hiện thực) | Ý tưởng đúng nhưng là kỹ thuật DB. Với store in-memory, tương đương là CAS đồng bộ trong `compareAndSet` (`research.md:56`). Ghi chú trong code: với DB thật dùng `UPDATE ... WHERE version = $1`. |
| P10 | Nhận 403 cho reviewer khi PATCH/POST; non-owner nhận 404 để che sự tồn tại (`ai-plan.md:45`) | Accept (403) / Reject (404 che) | 403 đúng (`research.md:14`). Không có khái niệm owner nên bỏ quy tắc 404; id không tồn tại vẫn 404. |

Tóm tắt: 10 điểm: Accept 1 (P1), Accept có chỉnh 3 (P6, P9, P10 phần 403), Modify 3 (P2, P5, P8), Reject 3 (P3, P4, P7). Hai điểm đáng chú ý nhất: P3 (Prisma/Postgres mâu thuẫn "runnable without external services") và P4 (idempotency "same decision -> 200" không phân biệt retry với request xung đột).

## 6. Risk-based test strategy

Rủi ro xếp theo mức độ: (1) race condition gây lost update hoặc double decision (P1); (2) reviewer sửa được data gốc hoặc admin tự approve (P1); (3) retry/key misuse áp dụng hai lần hoặc trả sai response (P1); (4) sai mã trạng thái (428/412/409/422/400) (P2).

- **Unit** (`identity-server/test/review-store.test.ts`): `compareAndSet` (version khớp/lệch, mutate không chạy khi lệch, hai lần gọi đồng bộ liên tiếp cùng expectedVersion), bản sao dữ liệu (store trả bản copy, sửa object trả về không làm đổi store), idempotency reservation (reserve/replay/in-flight/release). Kỹ thuật: boundary (version cũ/đúng), state-based.
- **API / integration** (`review-authz.test.ts`, `review-concurrency.test.ts`): mount `createReviewRouter` lên `express()` mới, `app.listen(0, "127.0.0.1")`, gọi bằng `fetch` (không có `supertest` trong `package.json`). `resolveActor` đọc bearer token từ map cố định. `beforeCommit` inject: không-op (authz), `setImmediate`/gate Promise có điều khiển (race, in-flight), hàm throw (failure path). Clock inject để `decidedAt` deterministic.
- **Load (NFR1)**: harness riêng ghi `evidence/07-load.log`, 60 request đồng thời tới cùng server `listen(0)`, tính p95 nearest-rank; không nằm trong bảng TC (đo hiệu năng, không phải đúng/sai chức năng). Bản trong TC-09 (60 concurrent race) kiểm tra tính đúng, không đo thời gian.
- **E2E: không cần và không thể.** Router chưa mount vào `src/app.ts` và chưa có đăng nhập cho reviewer (không có cột role, không có UI), nên không có luồng người dùng thật để chạy E2E qua OIDC; mọi hành vi đã được phủ ở tầng API với HTTP thật. Thêm E2E sẽ phải thay đổi schema/OIDC (xem P3, P7).
- **Không được test (limitation công khai):** persistence Prisma/Postgres (CAS dựa trên `UPDATE ... WHERE version`); race giữa nhiều process/instance (CAS in-memory chỉ đúng trong một process); TTL của idempotency record; xác thực token thật qua oidc-provider; áp lực mạng/TLS thật.

## 7. Decision table

Conditions: Role = `admin` / `reviewer` / `other` (role không trong bảng quyền, ví dụ `guest`) / `none` (không có actor). Action = GET / PATCH / DECISION. If-Match = missing / stale / current. Idempotency-Key = missing / new / replay-same / replay-different (kể cả in-flight). Status = pending / decided. Kết hợp đầy đủ: 4 x 3 x 3 x 4 x 2 = 288 cột; chỉ 17 cột khác nhau về outcome, phần còn lại gộp bằng "-" (don't care).

Lý do gộp (theo thứ tự kiểm tra ở mục 4): bước authn/authz đứng trước mọi điều kiện khác nên khi Role là `none`/`other`/sai quyền thì outcome không phụ thuộc If-Match, Key, Status (R1, R2, R4, R8). GET không đọc If-Match/Key. PATCH không dùng Key. DECISION: thiếu Key hoặc thiếu If-Match chặn trước khi chạm state nên không phụ thuộc Status. replay-same / replay-different / in-flight được xử lý trước 412 và 409 nên không phụ thuộc If-Match còn current hay đã stale, và không phụ thuộc Status (R15-R17).

| Rule | Role | Action | If-Match | Idem-Key | Status | Outcome |
|---|---|---|---|---|---|---|
| R1 | none | - | - | - | - | 401 |
| R2 | other | - | - | - | - | 403 |
| R3 | admin/reviewer | GET | - | - | - | 200 + `ETag: "v<n>"` (id lạ -> 404) |
| R4 | reviewer | PATCH | - | - | - | 403, data/version không đổi |
| R5 | admin | PATCH | missing | - | - | 428 |
| R6 | admin | PATCH | stale | - | - | 412, không đổi |
| R7 | admin | PATCH | current | - | - | 200, data mới, version+1 |
| R8 | admin | DECISION | - | - | - | 403 (separation of duties) |
| R9 | reviewer | DECISION | - | missing | - | 400 |
| R10 | reviewer | DECISION | missing | present | - | 428 |
| R11 | reviewer | DECISION | present | present | - | 400 nếu `decision` không phải approve/reject (kiểm tra trước idempotency, không reserve) |
| R12 | reviewer | DECISION | current | new | pending | 200, status set, decidedBy/At, version+1, data nguyên vẹn |
| R13 | reviewer | DECISION | stale | new | - | 412, không đổi, key được release |
| R14 | reviewer | DECISION | current | new | decided | 409 |
| R15 | reviewer | DECISION | - | replay-same | - | replay status+body cũ, không apply lần hai |
| R16 | reviewer | DECISION | - | replay-different | - | 422 (fingerprint khác) |
| R17 | reviewer | DECISION | - | replay-same, request đầu đang chạy (in-flight) | - | 409 |

Ghi chú: R14 dùng `If-Match` bằng version hiện tại của item đã decided (v2) với key mới; nếu `If-Match` cũ thì rơi vào R13 (412 trước 409). Đồng thời hai request R12 + R13 với key khác nhau, cùng `If-Match: "v1"` chính là kịch bản AC4.

Chọn test data: mỗi test tạo store và item riêng (không dùng chung state giữa test), id cố định (`item-1`), version bắt đầu 1 và chỉ đi 1 -> 2 (biên: `"v1"` stale sau khi lên v2, `"v2"` current), token cố định (`admin-token`, `reviewer-token`, `guest-token`, map -> actor `{id:"admin-1"|"reviewer-1"|"reviewer-2"|"guest-1", role}`), key cố định (`k-1`, `k-2`...), clock inject trả `2026-01-01T00:00:00.000Z`, không dùng `Math.random`, `Date.now` hay sleep theo thời gian (độ trễ giả lập bằng `setImmediate` hoặc deferred Promise có điều khiển). Mỗi rule có ít nhất một TC; R13, R15, R16, R17 mỗi rule có thêm biến thể đồng thời.

## 8. Test cases

| ID | Risk / AC | Rule | Level | Precondition / Input | Expected | Pri | Planned file |
|---|---|---|---|---|---|---|---|
| TC-01 | AC1 | R3 | API | item v1; GET bằng `admin-token`, rồi `reviewer-token` | 200, `{item}`, `ETag: "v1"` cho cả hai | P1 | `identity-server/test/review-authz.test.ts` |
| TC-02 | AC1 / deny-by-default (negative) | R1, R2, R3 | API | GET không token; GET bằng `guest-token`; GET id không tồn tại bằng `admin-token` | 401; 403; 404 | P1 | `identity-server/test/review-authz.test.ts` |
| TC-03 | AC3 (negative) | R4 | API | item v1; `reviewer-token` PATCH `{title:"X"}` với `If-Match:"v1"` rồi không có `If-Match` | 403 cả hai; `data` byte-identical, `version=1` | P1 | `identity-server/test/review-authz.test.ts` |
| TC-04 | AC3 (negative) | R8 | API | item pending; `admin-token` POST decision approve, đủ `If-Match` + key | 403; `status=pending`, `version=1` | P1 | `identity-server/test/review-authz.test.ts` |
| TC-05 | AC2 | R12 | API | item pending v1; `reviewer-token` approve, `If-Match:"v1"`, key `k-1` (rồi item khác với `reject`) | 200; `status=approved` (`rejected`); `decidedBy=reviewer-1`; `decidedAt` = clock; `version=2`; `data` byte-identical so với trước | P1 | `identity-server/test/review-authz.test.ts` |
| TC-06 | Mã trạng thái / AC5 | R5, R6, R9, R10, R11 | API | PATCH admin thiếu `If-Match`; PATCH admin `"v0"`; decision thiếu key; decision thiếu `If-Match`; `{decision:"maybe"}` | 428; 412; 400; 428; 400; item không đổi trong mọi trường hợp | P2 | `identity-server/test/review-authz.test.ts` |
| TC-07 | AC3 / invariant | R7, R14 | API | admin PATCH `If-Match:"v1"` -> 200, data mới, `v2`; sau đó reviewer approve với `If-Match:"v2"` key mới trên item đã decided | PATCH 200 `ETag:"v2"`; approve lần hai trên item đã decided -> 409 và status giữ nguyên | P2 | `identity-server/test/review-authz.test.ts` |
| TC-08 | Race / AC4 | R12 + R13 | API | item pending v1; 2 request approve và reject đồng thời, key `k-a`/`k-b` khác nhau, cùng `If-Match:"v1"`, `beforeCommit` await `setImmediate` | đúng một 200 và một 412; `version=2`; `status` khớp request thắng; `data` không đổi | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-09 | Race / AC4 | R12 + R13 | API | như TC-08 nhưng 60 request đồng thời, key `k-0..k-59` | đúng 1 x 200, 59 x 412; `version=2`; một `decidedBy` duy nhất | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-10 | Race / AC4 | R6, R7 | API | admin: 2 PATCH đồng thời cùng `If-Match:"v1"` (title khác nhau), `beforeCommit` có độ trễ | một 200, một 412; `data` bằng đúng payload của request thắng (không trộn); `version=2` | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-11 | Race: PATCH vs decision / invariant | R7, R12, R13 | API | admin PATCH và reviewer approve đồng thời cùng `If-Match:"v1"` | đúng một 200 và một 412; nếu approve thắng thì `data` giữ giá trị gốc; không có trạng thái "approved + data mới" | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-12 | AC5 | R15 | API | approve `k-1` thành công (v2); gửi lại cùng `k-1`, cùng body, cùng `If-Match:"v1"` | cùng status 200 và body đã lưu; `version` vẫn 2; `decidedAt` không đổi | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-13 | AC5 (negative) | R16 | API | approve `k-1` thành công; gửi `k-1` với `decision:"reject"` (hoặc item khác) | 422; trạng thái không đổi | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-14 | Race + idempotency | R15, R17 | API | 10 request đồng thời cùng `k-1`, cùng fingerprint, `beforeCommit` dùng gate Promise (giữ request đầu in-flight rồi mở gate) | decision chỉ apply một lần (`version=2`); request in-flight nhận 409; sau khi mở gate, gửi lại `k-1` nhận replay 200 | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-15 | Failure path / race | R13, R17 | API | `beforeCommit` throw ở lần đầu cho `k-1`; sau đó `beforeCommit` bình thường, gửi lại cùng `k-1` + `If-Match:"v1"` | lần đầu 500 không lộ chi tiết; item không đổi (`pending`, `v1`, `data` nguyên); không partial write; key được release nên retry cùng `k-1` thành công 200 (`v2`) | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-16 | Race / unit | R12 + R13 | unit | `store.compareAndSet("item-1", 1, mutate)` gọi hai lần liên tiếp đồng bộ (không await giữa hai lần) | lần 1 `ok`, version 2; lần 2 `conflict`, `mutate` không được gọi; sai version (0, 2) cũng `conflict` | P1 | `identity-server/test/review-store.test.ts` |
| TC-17 | Invariant / unit | R7, R12 | unit | lấy item từ store, sửa object trả về (`item.data.title="X"`); gọi `compareAndSet` với `mutate` cố ghi `data` ngoài đường PATCH | store không đổi khi sửa bản copy; `get` kế tiếp trả data gốc | P2 | `identity-server/test/review-store.test.ts` |
| TC-18 | AC5 / unit | R15, R16, R17 | unit | idempotency: `reserve(actor,key,fp)` -> `new`; lần 2 cùng fp khi chưa complete -> `in-flight`; `complete` rồi reserve cùng fp -> `replay`; fp khác -> `mismatch`; `release` rồi reserve -> `new`; cùng key khác actor -> `new` | đúng từng kết quả; khóa theo (actorId, key) | P1 | `identity-server/test/review-store.test.ts` |
| TC-19 | AC5 / AI review R7 | R15 | API | approve `k-1` thành công (200, `ETag:"v2"`); gửi lại cùng `k-1`, cùng body, cùng `If-Match:"v1"` | replay 200 cùng body và cùng header `ETag:"v2"` như response gốc (không phải ETag yếu do Express tự sinh); `version` vẫn 2 | P1 | `identity-server/test/review-concurrency.test.ts` |
| TC-20 | AC5 / AI review R8 | R15, R17 | API | item `v2` (sau admin PATCH); reviewer approve `k-1` với `If-Match:"v1"` -> 412; gửi lại cùng `k-1` với `If-Match:"v2"` | 412 không để lại reservation; retry 200, `version=3`, `ETag:"v3"` (characterization: pass ngay khi thêm) | P1 | `identity-server/test/review-concurrency.test.ts` |

Đếm: 20 TC (TC-19, TC-20 thêm sau AI review, xem `ai-review-verdicts.md`). Negative: TC-02, TC-03, TC-04, TC-13 (cộng các nhánh lỗi trong TC-06). Failure path gắn với race risk: TC-15. Race: TC-08, TC-09, TC-10, TC-11, TC-14, TC-16. Mutation "bỏ idempotency/concurrency guard" phải làm đỏ ít nhất TC-08, TC-09, TC-10, TC-11, TC-12, TC-14, TC-16, TC-18.

Phân bổ priority: P1 = 17 TC, P2 = 3 TC (TC-06, TC-07, TC-17), không có P3: slice nhỏ nên mọi case đều bảo vệ rủi ro chính hoặc mã trạng thái, ghi nhận là lựa chọn có chủ đích.
