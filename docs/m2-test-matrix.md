# S3 — Ma trận kiểm thử M2 (bản làm việc)

**Phạm vi:** phần S3 cần cho login OIDC xuyên suốt ở issue #14. Tài liệu này tách bằng chứng hiện có trên O1 khỏi ca còn chờ A2–A3, O2–O3 và C2. Không dùng test mock để tuyên bố M2 đạt. Mốc tham chiếu: `main` tại `4c8e96e` ngày 03/11/2026; nhánh S3 `test/m2-protocol-baseline`.

## Quy tắc chạy và ghi bằng chứng

- Development/demo thủ công có thể dùng PostgreSQL `app04`; **mọi test tự động ghi dữ liệu chỉ dùng `app04_test`**, kiểm tra tên database kết thúc `_test`, áp migration trước test. Không chạy test tự động có dữ liệu với URL development.
- Fixture M2 dùng email tiền tố `s3-m2-test-` kèm ID ngẫu nhiên trong database test; tạo user qua A1 để đi qua đường đăng ký thật. Dọn đúng prefix fixture sau test, kể cả khi test thất bại. Không commit `.env`, mật khẩu thật, code, token hoặc secret; không đưa chúng vào log/test report.
- Mỗi bằng chứng ghi: commit/nhánh, Node và PostgreSQL, database test, lệnh hoặc thao tác browser, số test đạt/trượt/bị skip, link CI nếu có, blocker và chủ module. **Skip/chưa chạy không tính là đạt.**
- `identity-server/test/m2-authorization-boundary.test.ts` chỉ kiểm tra hành vi hiện có của O1, chạy không cần database. Khi Nam/Quang/Châu Anh có code, bổ sung test thật cho phần còn chờ; không sửa logic module khác trong PR S3.

## Ma trận ca M2

| ID | Ca và owner sửa lỗi | Fixture / cách chạy | Kết quả mong đợi | Tình trạng tại `main` 4c8e96e |
| --- | --- | --- | --- | --- |
| M2-00 | Đối chứng Authorization Code + PKCE S256 hợp lệ — Quang | Public client và redirect URI đã đăng ký; lấy Authorization Endpoint từ Discovery | Provider trả `303` tới interaction cùng issuer, chưa có code hoặc lỗi; **chưa phải login thành công** | **Đạt nền tảng O1**: test tự động; còn chờ interaction/login thật |
| M2-01 | Login thành công — Nam A2–A3, Quang O2–O3, Châu Anh C2; Phương kiểm thử xuyên module | User `s3-m2-test-*` đăng ký qua A1 trong `app04_test`; browser React → Provider → login → callback | Code đổi một lần, ID Token đã xác minh có `sub=users.id`, dashboard chỉ hiện sau xác minh | **Chờ** login/interaction/callback thật; C1 mới redirect |
| M2-02 | Sai mật khẩu hoặc email không có — Nam | Cùng form login với user thật, thử hai đầu vào lỗi; test CSRF/giới hạn thử của form | Thông báo chung, không hoàn tất interaction, không cấp code/token, không lộ user | **Chờ** A3 |
| M2-03 | Authorization request thiếu PKCE — Quang | Gửi request cho public client không có `code_challenge` | Provider trả `303` về đúng callback đã đăng ký với `error=invalid_request`, giữ `state`, không có code | **Đạt nền tảng O1**: test tự động `m2-authorization-boundary.test.ts`; Quang cần giữ bất biến khi làm O2 |
| M2-04 | PKCE sai hoặc thiếu `code_verifier` khi đổi code — Quang | Lấy code thật từ flow M2, gửi token request với verifier sai/thiếu trong `app04_test` | Token Endpoint từ chối, không cấp token | **Chờ** code thật từ O2–O3/A3 |
| M2-05 | Phương thức PKCE không phải S256 — Quang | Authorization request với `code_challenge_method=plain` | Provider trả `303` về đúng callback đã đăng ký với `error=invalid_request`, giữ `state`, không có code | **Đạt nền tảng O1**: test tự động; kiểm tra lại sau O2 |
| M2-06 | Redirect URI chưa đăng ký — Quang | Authorization request với `https://example.invalid/callback` | Provider trả `400`, không có `Location`, trường lỗi `invalid_redirect_uri`; không chuyển browser tới URI đó | **Đạt nền tảng O1**: test tự động; kiểm tra lại sau O2 |
| M2-07 | Callback thiếu/sai `state`, thiếu code hoặc OAuth error — Châu Anh | Thay callback URL trên browser/test client, không dùng token thật trong log | Không đổi code sai giao dịch, không hiện dashboard, dọn trạng thái lỗi | **Chờ** C2 |
| M2-08 | Nonce thiếu/sai sau khi đã gửi nonce — Châu Anh | Fixture ID Token có nonce sai/thiếu, đối chiếu giao dịch lưu bởi client | Không hiện dashboard, không giữ trạng thái đăng nhập giả | **Chờ** C2; C1 chưa gửi nonce |
| M2-09 | ID Token sai chữ ký, issuer, audience hoặc hết hạn — Châu Anh | Token/JWKS fixture test-only, không dùng secret thật | Xác minh bằng thư viện chuẩn thất bại; không hiện dashboard, xóa user chưa tin cậy | **Chờ** C2 và kiểm chứng `jose`/JWKS |
| M2-10 | Authorization Code dùng lại — Quang | Đổi một code thật hai lần; Phương gửi request thứ hai và lưu status/lỗi đã lọc | Lần đầu thành công, lần hai bị Token Endpoint từ chối | **Chờ** O2–O3/A3 và code thật |

**Phân công test:** chủ module viết test cho logic của mình; Phương sở hữu ma trận, fixture, test xuyên module và bằng chứng chung. Nếu một ca lỗi, ghi bước tái hiện vào issue/PR của đúng owner. Quang là đầu mối ghép luồng, không sửa nhánh của chủ module khác.

## Lệnh đã có và lệnh sẽ dùng khi tích hợp

```text
identity-server/: npm ci → npm run db:generate → npm run db:deploy → npm test
client-demo/: npm ci → npm test → npm run build
```

Với test có DB, đặt `DATABASE_URL` trỏ `app04_test` **trước** `db:deploy` và `npm test`. CI S4 đã tạo PostgreSQL 17.11 với database này; cần xem từng job thực sự chạy trên commit của PR, không tính job bị skip là đạt. Các bước browser M2-01 và callback cần hai app chạy cùng local contract (`http://localhost:3000` và `http://localhost:5173`) và user đăng ký trong DB development/test phù hợp; ghi rõ DB nào đã dùng.

## Bằng chứng local sau gia cố — 03/11/2026

- Môi trường: Windows, Node `24.22.0` bằng runtime local; code nền `main` `4c8e96e` cùng test trên branch `test/m2-protocol-baseline`.
- `npm run build` trong `identity-server/`: **đạt**.
- `node --test dist/test/m2-authorization-boundary.test.js`: **4/4 đạt, 0 skip**, gồm M2-00/03/05/06. Test dùng HTTP server cổng tạm và endpoint lấy từ Discovery, không kết nối database. Lỗi PKCE được kiểm bằng HTTP status, callback đã đăng ký và trường `error` ổn định; lỗi redirect URI được kiểm bằng mã `invalid_redirect_uri` trong trường `error` của trang lỗi mặc định `oidc-provider@9.12.2`, không so khớp câu mô tả lỗi.
- Chạy chung Discovery + headers + test S3 đã gia cố: **11/11 đạt, 0 skip**. `client-demo/` `npm test`: **8/8 đạt** và `npm run build`: **đạt**. Đây là kiểm tra hồi quy trên code hiện có, chưa chứng minh callback C2.
- Chưa chạy full backend `npm test`, migration hay ca A1/M2 cần PostgreSQL local: terminal không có `DATABASE_URL`, Docker daemon không hoạt động. Bằng chứng CI cho test mới phải đối chiếu riêng trên commit PR; kết quả local không thay thế CI. M2-01/02/04/07/08/09/10 **chưa được xác minh**.
