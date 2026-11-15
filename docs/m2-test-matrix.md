# S3 — Ma trận kiểm thử M2

Phạm vi nghiệm thu trên main sau PR #21. Owner S3 là Phương; owner logic ghi theo từng ca. Hồ sơ lịch sử PR #16 được giữ trong [s3-test-evidence.md](s3-test-evidence.md).

## Quy tắc an toàn và phân loại bằng chứng

- Test/migration use a fresh harness-owned PostgreSQL 17.11 instance, exact app04_test, live server identity and a per-run capability. S3_TEST_DATABASE_ISOLATED=1 is ignored; no shared/development database fallback.
- URL chỉ cho `postgres`/`postgresql`, host `localhost`/`127.0.0.1`/`[::1]`, query tùy chọn duy nhất `schema=public`. Không cho tham số ghi đè host/dbname/options. Không in URL có credentials.
- Controlled Prisma commands lock config/schema and arguments; default config refuses raw push/execute and unsupported commands. External configs/direct SQL are outside the guard boundary. See ci.md for explicit development-only workflow.
- test/helpers.ts uses exact scope-owned emails and tracked writes. Cleanup closes the scope, drains pending work, joins concurrent cleanup and retains ownership on delete failure. No prefix deletion. Kill/untracked writes are outside the guarantee.
- Fixture user tạo qua A1 thật, chỉ dùng dữ liệu tổng hợp. Không đưa password, raw token/code, client secret, email/UUID fixture, URL callback đầy đủ hoặc trace chưa lọc vào evidence. Chỉ ghi `sub_matches_fixture=true`, status, mã lỗi allowlist và số lượng.
- PASS = mọi assertion trong hàng đạt; FAIL = có assertion sai; SKIP = runner bỏ qua; NOT RUN = chưa thực thi; BLOCKED = không thể thực thi vì phụ thuộc/môi trường đã nêu. SKIP/NOT RUN/BLOCKED không tính PASS.
- Test chữ ký/nonce bằng token fixture là bằng chứng kiểm soát âm tính, không thay E2E thành công bằng user/Provider/browser thật.

## Preconditions và evidence dùng chung

- **P0:** Node 24.22.0, oidc-provider 9.12.2; server test mới, cổng tạm; endpoint lấy từ Discovery. Không DB, không cookie đăng nhập trước.
- **P1:** P0 + instance PostgreSQL riêng đã xác minh/migrate; A2–A3 và O2–O3 được duyệt/tích hợp trong môi trường test; user đăng ký qua A1; mỗi ca cần code sử dụng giao dịch và code mới. Cookie jar riêng theo ca.
- **P2:** C2 được duyệt, stateStore và userStore riêng theo browser context; JWKS/issuer/client đúng local contract; fixture token âm tính không đổi cấu hình production.
- **E0:** Test ID/subcase, SHA gốc và tình trạng local chưa commit, lệnh, expected/actual đã lọc, trạng thái, môi trường, ngày giờ, link CI hoặc đoạn log tổng hợp.
- **E1:** E0 + HTTP status, mã OAuth lỗi, `has_code`/`has_token` boolean; không ghi giá trị code/token/state/nonce.
- **E2:** E1 + browser/version, số token requests, `sub_matches_fixture`, dashboard visible, URL query sạch, kết quả reload, trạng thái cleanup. Screenshot/trace chỉ được lưu sau khi kiểm tra không có dữ liệu nhạy cảm.

## Ma trận M2-00 đến M2-11

Nguồn **[B]** là backend CI, **[F]** là frontend CI trên `c853682`, **[E]** là Browser E2E trên snapshot trước PR #21. Xem [lệnh, môi trường và log đã lọc](s3-test-evidence.md#m2--hồ-sơ-nghiệm-thu). Khi một biến thể chưa có evidence riêng, ghi NOT VERIFIED cho biến thể đó.

| ID / owner sửa logic | Preconditions | Steps | Expected result / tiêu chí PASS (sai bất kỳ điều kiện = FAIL) | Evidence | Trạng thái / phụ thuộc |
| --- | --- | --- | --- | --- | --- |
| M2-00 — Quang; Phương test | P0, client public/redirect đã đăng ký | GET Discovery; authorize code + S256 hợp lệ | 303 tới interaction cùng issuer; không có code/error; không phải bằng chứng login hoàn tất | E1, test đối chứng | PASS [B] — HTTP thật |
| M2-01 — Nam + Quang + Châu Anh; Phương E2E | P1 + P2; React 5173, issuer 3000; context sạch để có consent | Đăng ký A1; Login từ React; nhập mật khẩu trên IdP; đồng ý consent; xử lý callback; reload | Code đổi đúng một lần; xác minh chữ ký/iss/aud/exp/nonce trước dashboard; sub khớp user; URL sạch; reload xác minh lại | E2 | PASS [E+B+F] — browser login/consent/reload; backend đối chiếu sub với users.id; frontend kiểm xác minh trước dashboard |
| M2-02a — Nam | P1, form/cookie/CSRF hợp lệ | Lần lượt dùng email không tồn tại và sai mật khẩu của user thật | Cùng thông báo credentials chung; không hoàn tất interaction, không cấp code/token; không lộ hash/password | E1, so thông báo đã lọc | PASS [B] — cùng lỗi credentials chung; [E] xác nhận sai mật khẩu trên browser |
| M2-02b — Nam + Quang | P1; giới hạn thử được owner chốt | POST form thiếu/sai CSRF; sau đó thử sai đến/vượt ngưỡng, reload và mở interaction mới | CSRF bị từ chối trước auth; giới hạn thử không bị né bằng reload/interaction mới theo contract; không code/token | E1, ngưỡng và status; không credentials | PASS [B] — CSRF, giới hạn email/IP qua interaction mới và request đồng thời |
| M2-03 — Quang | P0 | Bỏ challenge và challenge_method khỏi authorize | 303 về đúng callback đã đăng ký; error=invalid_request; state được giữ; không code | E1 | PASS [B] — HTTP thật |
| M2-04a — Quang | P1; code A mới gắn S256; client/redirect/verifier format hợp lệ | Đổi code A bằng verifier khác, đúng độ dài | HTTP 400, error=invalid_grant, không access_token/id_token/refresh_token; không nhầm lỗi client hay redirect; đối chứng đổi lại chính code đó với verifier gốc, cùng client/redirect, phải trả 200 có token | E1 | PASS [B] — 400 invalid_grant, không token; cùng code với verifier gốc trả 200, có token |
| M2-04b — Quang | P1; code B mới, chưa đổi; các field khác hợp lệ | Đổi code B nhưng bỏ code_verifier | HTTP 400, error=invalid_grant theo oidc-provider 9.12.2; không token; không dùng code đã fail của M2-04a; đối chứng đổi lại chính code đó với verifier gốc, cùng client/redirect, phải trả 200 có token | E1 | PASS [B] — 400 invalid_grant, không token; cùng code với verifier gốc trả 200, có token |
| M2-05 — Quang | P0 | Gửi authorize với method=plain | 303 về callback đã đăng ký; invalid_request; giữ state; không code. Phạm vi hiện chỉ kiểm plain | E1 | PASS [B] — HTTP thật |
| M2-06 — Quang | P0 | Đổi redirect_uri thành URI chưa đăng ký | HTTP 400, không Location; trường lỗi invalid_redirect_uri; không redirect tới URI lạ | E1 | PASS [B] — HTTP thật |
| M2-07a — Châu Anh | P2; kiểm cả chưa đăng nhập và đang có phiên hợp lệ | Callback không có state | Không token request, không tạo dashboard mới; báo lỗi an toàn; phiên hợp lệ trước đó không bị callback giả xóa | E2 | PASS [E+F] — browser báo thiếu state; frontend từ chối và kiểm giữ phiên đã xác minh |
| M2-07b — Châu Anh | P2; state không có trong stateStore | Callback với state lạ | Không đổi code, không tạo phiên mới; giữ phiên hợp lệ có sẵn; không hiện error_description/token/code | E2 | PASS [E+F] — từ chối state lạ; browser giữ phiên hợp lệ; frontend kiểm thông báo cố định |
| M2-07c — Châu Anh | P2; hai subcase state hợp lệ và state lạ | Callback error=access_denied; thêm error_description không đáng tin | Không token request; hiển thị lỗi cố định/mã allowlist; state hợp lệ: consume transaction và dọn user chưa tin cậy; state lạ: không phá phiên hợp lệ | E2 | PASS [E+F] — consent denial không đổi code; fixture kiểm state khớp bị consume và state lạ giữ phiên hợp lệ |
| M2-07d — Châu Anh | P2; state hợp lệ | Callback thiếu code, không có OAuth error | Không token request; báo thiếu code; consume transaction/dọn user chưa tin cậy; không dashboard mới | E2 | PASS [F] — thiếu code với state khớp, không đổi code |
| M2-08a/b/c — Châu Anh | P2; mỗi subcase dùng state/nonce mới; token fixture có chữ ký/iss/aud/exp hợp lệ | Lần lượt trả ID Token nonce thiếu, khác kỳ vọng, chuỗi rỗng | Cả 3 bị từ chối; không dashboard; user/marker chưa tin cậy bị xóa. Nonce kỳ vọng thiếu: dừng trước token request; nonce kỳ vọng rỗng: bị bộ xác minh từ chối | E2, 3 kết quả riêng và ca stateStore riêng | PASS [F] — fixture kiểm nonce thiếu, sai, rỗng; kiểm cả nonce kỳ vọng thiếu hoặc rỗng |
| M2-09a/b/c/d — Châu Anh | P2; giữ nonce và các claim không bị kiểm tra hợp lệ | Từng token sai chữ ký, sai iss, sai aud, exp quá hạn ngoài clock tolerance | Cả 4 bị xác minh từ chối; không dashboard; xóa user/marker chưa tin cậy; reload cũng không tin token | E2, 4 kết quả riêng; không token fixture trong report | PASS [F] — 4 lỗi token khi xác minh callback; reload có regression chữ ký, audience và expiry. NOT VERIFIED riêng cho issuer sai khi reload |
| M2-10 — Quang; Phương integration | P1; code mới + đúng verifier | Đổi code một lần thành công; gửi lại cùng code/verifier/client/redirect | Lần 1 HTTP 200 có token; lần 2 HTTP 400 invalid_grant, không token; không lấy lỗi verifier làm bằng chứng replay | E1, hai status và booleans | PASS [B+E] — lần đầu 200 có token; replay 400 invalid_grant không token |
| M2-11 — Quang; Phương integration | P1; code mới chưa dùng; TTL thực tế được ghi rõ | Giữ code tới sau expiry + margin; đổi bằng verifier đúng; không thay TTL production | HTTP 400 invalid_grant, không token; lưu thời gian tương đối/TTL; không dùng code đã tiêu thụ hoặc verifier sai | E1, TTL và elapsed; không code | NOT RUN — supplemental, ngoài gate M2 |

M2-04a/b dùng đối chứng dương trên cùng code, client và redirect. Đối chứng xác nhận phản hồi âm tính không do code hết hạn, đã bị consume hoặc không hợp lệ. M2-11 chưa chạy.

## Lệnh và gate

Run in identity-server: npm ci, npm run test:safety, npm run test:s3; then npm run test:isolated -- --driver=native (Windows PostgreSQL 17.11), or --driver=docker. Do not supply a database URL or isolation flag. The harness generates the client, verifies its owned datasource, deploys twice, runs all backend tests and parallel fixtures, checks headers and residue, then revokes/stops its instance. No browser E2E is implied. M2-11 code expiration is a proposed supplemental protocol regression, not an added M2 acceptance requirement without team approval.

## Phạm vi chuyển sang M3

Browser E2E đã chạy trên snapshot trước PR #21, không chạy lại trên merge commit của PR #21. M2 chứng minh login mật khẩu, consent, callback đã xác minh và local logout. MFA mock, Protected API/audit đầy đủ, persistence qua restart, refresh/revoke và RP-initiated logout theo kế hoạch M3; session/Grant in-memory và local logout không chứng minh các tính năng này.
