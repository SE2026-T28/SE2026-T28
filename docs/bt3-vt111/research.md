# Research note — BT3 VT111: role "reviewer" (read + approve, không sửa data gốc)

Phạm vi: Express + oidc-provider (Node/TypeScript). Rủi ro chính: race condition khi 2 request đồng thời đổi cùng một resource. Test design: decision table. Mutation: bỏ idempotency/concurrency guard. Load: 60 concurrent tasks, p95 <= 2.0 s.
Tất cả URL bên dưới đã được fetch kiểm tra (HTTP 200) ngày 2026-11-16.

## 1. RBAC, least privilege, separation of duties

- NIST, "Role Based Access Control" (project page, mô tả RBAC model và ANSI/INCITS 359): https://csrc.nist.gov/projects/role-based-access-control
- OWASP, "Authorization Cheat Sheet": https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

Ý chính:
- **Least privilege**: role `reviewer` chỉ có permission `resource:read` và `resource:approve`; KHÔNG có `resource:update`. Permission gắn vào role, không check theo tên role rải rác trong handler.
- **Separation of duties (SoD)**: người sửa nội dung không được tự approve; reviewer không sửa được data gốc. Approve chỉ ghi vào field riêng (`status`, `approvedBy`, `approvedAt`), không đụng `data` gốc.
- OWASP: **deny by default**, **enforce authorization on every request** ở server-side (middleware), không tin client/UI ẩn nút; validate permission cả khi role hợp lệ nhưng thao tác không được phép (trả 403, không phải 404, trừ khi cần che sự tồn tại).
- Role lấy từ claim đã verify của token (oidc-provider `findAccount` / claims), không lấy từ body request.

## 2. Optimistic concurrency control: ETag, If-Match, 412 vs 409, 428

- RFC 9110 "HTTP Semantics": https://www.rfc-editor.org/rfc/rfc9110.html — các section liên quan: 8.8.3 ETag, 13.1.1 If-Match, 13.2 precondition evaluation, 15.5.10 `409 Conflict`, 15.5.13 `412 Precondition Failed`, 15.5.21 `422 Unprocessable Content`.
- RFC 6585 "Additional HTTP Status Codes", section 3 `428 Precondition Required`: https://www.rfc-editor.org/rfc/rfc6585.html

Ý chính:
- Mỗi resource có `version` (integer tăng dần). Server trả `ETag: "<version>"` khi GET. Client gửi `If-Match: "<version>"` khi PUT/PATCH/POST approve.
- Nếu `If-Match` không khớp version hiện tại: **412 Precondition Failed** (precondition do client gửi đã false — đúng ngữ nghĩa RFC 9110 15.5.13). Client phải GET lại rồi thử lại.
- Nếu request thiếu `If-Match` trên thao tác mutate: **428 Precondition Required** (RFC 6585) — ép client dùng conditional request, tránh "lost update".
- **409 Conflict** (RFC 9110 15.5.10): request xung đột với *trạng thái* resource, không liên quan header precondition. Ví dụ: resource đã `approved` mà bị approve/sửa lần nữa (state transition không hợp lệ). Phân biệt: 412 = "version bạn thấy đã cũ", 409 = "trạng thái hiện tại không cho phép thao tác này".
- Hai request đồng thời cùng `If-Match: "3"`: đúng một request thắng (200, version -> 4), request còn lại nhận 412.

## 3. Idempotency key cho POST

- IETF draft "The Idempotency-Key HTTP Header Field" (draft-ietf-httpapi-idempotency-key-header, bản mới nhất khi kiểm tra là -08; vẫn là Internet-Draft, chưa phải RFC): https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Stripe, "Idempotent requests": https://docs.stripe.com/api/idempotent_requests

Ý chính:
- Client sinh key duy nhất (UUID) cho mỗi thao tác logic, gửi header `Idempotency-Key`.
- Cùng key + cùng body: server **replay** response đã lưu (cùng status, body), không thực hiện lại side effect.
- Cùng key + body khác: draft quy định **422** (key bị dùng lại với payload khác). Stripe cũng từ chối lỗi tương tự.
- Cùng key đang được xử lý (request đầu chưa xong): draft cho **409 Conflict**.
- Thiếu key trên endpoint yêu cầu key: **400** theo draft (khác với 428 của If-Match; chọn một và ghi rõ trong design).
- Fingerprint body = hash của canonical JSON; lưu `{key, fingerprint, response, createdAt}` có TTL.
- Idempotency (retry an toàn) và optimistic concurrency (không ghi đè nhau) giải quyết hai vấn đề khác nhau; cần cả hai.

## 4. Race condition trong Node dù single-threaded

- Node.js docs, "The Node.js Event Loop": https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick
- PostgreSQL docs, "Transaction Isolation": https://www.postgresql.org/docs/current/transaction-iso.html và "Explicit Locking" (`SELECT ... FOR UPDATE`): https://www.postgresql.org/docs/current/explicit-locking.html

Ý chính:
- JS chạy một thread, nhưng mỗi `await` nhường event loop. Pattern **read-modify-write qua ranh giới async** bị race:
  ```ts
  const r = await repo.get(id);        // A đọc version 3
  await somethingAsync();              // B chen vào, ghi version 4
  r.status = 'approved';
  await repo.save(r);                  // A ghi đè mất cập nhật của B
  ```
- Fix in-memory: đưa **compare-and-set (CAS)** vào một đoạn code **đồng bộ** (không có `await` giữa check và write): `if (store.get(id).version !== expected) return CONFLICT; store.set(id, {...next, version: expected+1});`. Vì không có await, không request nào chen vào giữa. Không cần mutex.
- Với DB thật, check và write là hai round trip nên phải để DB làm atomic: `UPDATE resource SET ..., version = version + 1 WHERE id = $1 AND version = $2` rồi kiểm tra `rowCount === 1` (0 row = 412/409); hoặc `SELECT ... FOR UPDATE` trong transaction (pessimistic row lock); hoặc isolation SERIALIZABLE + retry. Với nhiều process/instance, CAS in-memory không còn đủ, bắt buộc phải dùng DB-level.
- Idempotency store cũng cần atomic "insert if absent" (in-memory: `Map.has`+`set` đồng bộ; DB: unique constraint trên key).

## 5. Decision table testing

- ISTQB Glossary, "decision table testing": https://glossary.istqb.org/en_US/term/decision-table-testing

Ý chính:
- Black-box technique: liệt kê **conditions** (cột đầu vào), **actions/outcomes**, mỗi cột (rule) là một tổ hợp. Mỗi rule -> ít nhất một test case.
- **Collapse rules**: nếu một condition không ảnh hưởng outcome với các giá trị của condition khác thì gộp thành "don't care" (`-`). Ví dụ: nếu role không có quyền thì outcome luôn 403 bất kể `If-Match`, key, state -> gộp thành một rule.
- Chọn test data: mỗi rule một bộ dữ liệu cụ thể, đại diện; kiểm tra các biên (version cũ/đúng, key mới/lặp/lặp khác body).
- Kiểm tra độ đầy đủ: 2^n tổ hợp ban đầu (đầy đủ) trước khi collapse, rồi chứng minh các rule gộp là hợp lệ.

## 6. Mutation testing, p95, giới hạn load test in-process

- Stryker Mutator docs (mutation testing cho JS/TS): https://stryker-mutator.io/docs/
- Percentile, mục nearest-rank method (Wikipedia, tham khảo định nghĩa): https://en.wikipedia.org/wiki/Percentile

Ý chính:
- **Mutation testing = "who tests the tests"**: cố ý đưa bug nhỏ (mutant) vào code; nếu test suite vẫn xanh thì mutant "survived" = test yếu. Mutation của slice này: **xóa guard idempotency/concurrency** (bỏ so khớp version hoặc bỏ lookup key). Test race phải đỏ (killed) với mutant này. Cần chứng minh bằng cách chạy test với mutant và ghi lại kết quả fail.
- **p95 nearest-rank**: sort N mẫu tăng dần, rank = ceil(0.95 * N), p95 = mẫu thứ rank (1-indexed). Với N = 60: rank = ceil(57.0) = 57 -> mẫu thứ 57. Cẩn thận lỗi float: dùng `Math.ceil(0.95 * N - 1e-9)` hoặc tính bằng số nguyên `Math.ceil(95 * N / 100)`.
- Yêu cầu: p95 <= 2.0 s với 60 task đồng thời; cần ghi nhận cả p50, max, số lỗi.
- **Giới hạn in-process load test**: client và server dùng chung một event loop/CPU nên số đo bị nhiễu và thường lạc quan (không có network latency, không có kernel/socket thật, GC chung); không phản ánh DB thật, nhiều instance, TLS, hay noisy neighbor. Dùng để phát hiện lỗi tương tranh và hồi quy tương đối, không phải để cam kết SLA production. Nên chạy qua HTTP thật (supertest hoặc `fetch` tới server listening) và `Promise.all` 60 request, warm-up trước, lặp vài lần lấy ổn định.

## Áp dụng cho slice

| # | Điểm nghiên cứu | Quyết định thiết kế |
|---|---|---|
| 1 | Least privilege, SoD, deny by default | Role `reviewer` có `read` + `approve`, không có `update`. Middleware authorize chạy mọi request, mặc định deny. Role lấy từ token đã verify. Reviewer gọi update -> **403**. Approve chỉ ghi field `status/approvedBy/approvedAt`, không đổi `data` gốc. |
| 2 | ETag/If-Match | GET trả `ETag: "<version>"`. Mutate (update, approve) bắt buộc `If-Match`. Thiếu -> **428**. Không khớp -> **412**. Trạng thái không cho phép (đã approved, approve lại bằng version mới) -> **409**. |
| 3 | Idempotency-Key | POST approve nhận `Idempotency-Key`. Cùng key + cùng body -> replay response cũ (cùng status). Cùng key + body khác -> **422**. Cùng key đang xử lý -> **409**. Thiếu key -> **400**. |
| 4 | Race qua `await` | In-memory repo: CAS version + ghi trong một hàm đồng bộ, không `await` giữa check và write. Hai request đồng thời cùng version: đúng một thắng (200), một nhận 412. Ghi chú trong code: với DB thật dùng `UPDATE ... WHERE version = $1` hoặc `FOR UPDATE`. |
| 5 | Decision table | Conditions: role hợp lệ, có `If-Match`, version khớp, state cho phép, idempotency key (mới / lặp cùng body / lặp khác body). Collapse: role sai -> 403 bất kể phần còn lại. Mỗi rule còn lại 1 test, kèm bảng trong docs. |
| 6 | Mutation + p95 + giới hạn | Mutant: xóa CAS/idempotency guard; test race phải fail, lưu bằng chứng. Load test: 60 request đồng thời, p95 nearest-rank (rank 57), assert <= 2000 ms; báo cáo rõ giới hạn in-process. |

Quy ước status code đã chọn: 403 (thiếu quyền), 428 (thiếu If-Match), 412 (version cũ), 409 (state conflict / key đang xử lý), 422 (key trùng body khác), 400 (thiếu Idempotency-Key).
