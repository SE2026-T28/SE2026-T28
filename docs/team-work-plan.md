# Kế hoạch phân việc APP-04 cho nhóm 4 người

**Trạng thái:** Dự thảo để nhóm duyệt trong PR  
**Thời lượng:** 8 tuần kể từ khi nhóm bắt đầu triển khai  
**Mốc bắt đầu để lập lịch:** 19/10/2026 (đề xuất, cần cả nhóm xác nhận)  
**Kiến trúc đã thống nhất:** Modular Monolith gồm Identity Server Node.js/TypeScript/Express/`oidc-provider`, React demo client và PostgreSQL. Xem [kiến trúc](architecture.md) và [sơ đồ](architecture-diagram.md).

## Phiên bản tech stack dùng chung

**Mốc tra cứu:** 15/10/2026. Đây là **các phiên bản cụ thể để toàn nhóm cùng dùng**, không phải khoảng phiên bản để mỗi người tự chọn. Repo hiện chưa có `package.json`/lockfile, nên tính tương thích cuối cùng phải được xác nhận bằng cài đặt, build và chạy Discovery Endpoint cùng React callback. Nếu một phiên bản cần đổi, cập nhật bảng này và lockfile trong cùng PR.

| Thành phần | Phiên bản thống nhất | Áp dụng / ghi chú |
| --- | --- | --- |
| Node.js | **24.22.0 LTS** | Cả nhóm và CI dùng cùng phiên bản qua `.nvmrc`; dùng npm đi kèm Node 24 |
| TypeScript | **5.9.3** | Backend và frontend dùng cùng phiên bản; bật `strict` |
| Express | **5.2.1** | HTTP routes/middleware của Identity Server |
| `oidc-provider` | **9.12.2** | Khóa đúng bản khi viết interactions và PostgreSQL adapter |
| PostgreSQL | **17.11** | Cả nhóm dùng cùng bản 17.11; migration phải chạy được trên bản này |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | **7.10.0 cho cả ba** | Prisma cho dữ liệu ứng dụng; adapter OIDC vẫn phải theo API riêng của `oidc-provider` |
| React và `react-dom` | **19.3.0 cho cả hai** | React demo client |
| Vite / `@vitejs/plugin-react` | **8.3.0 / 6.1.2** | Công cụ build React |
| `oidc-client-ts` | **3.5.0** | Authorization Code + PKCE, callback và xác minh ID Token ở React |
| `argon2` | **0.45.1** | TV1 dùng biến thể Argon2id cho password hashing |
| Helmet | **8.3.0** | Security headers của Identity Server; chỉnh CSP theo UI thực tế |
| Vitest | **5.0.4** | Unit/integration tests |
| Playwright Test | **1.64.1** | Chỉ dùng cho các E2E quan trọng; CI cài đúng browser binaries của bản này |

**Quy tắc khóa phiên bản:** khi khởi tạo, cài các dependency bằng `npm install --save-exact` hoặc `npm install -D --save-exact`, để `package.json` ghi số phiên bản cụ thể (ví dụ `"vitest": "5.0.4"`, không dùng `5.x`, `^5.0.4` hay `latest`). Commit `package-lock.json` ở root nếu dùng npm workspaces, hoặc trong từng app nếu cài riêng; CI dùng `npm ci`. Node được chốt trong `.nvmrc` và CI. `oidc-provider` và Prisma 7 dùng ESM, vì vậy backend đặt `"type": "module"` và cấu hình TypeScript phù hợp. Prisma 7 kết nối PostgreSQL qua `@prisma/adapter-pg`. Không cần Python `venv` cho stack này; môi trường chạy là Node.js + npm + PostgreSQL. [Node.js LTS](https://nodejs.org/uk/blog/release/v24.22.0), [`oidc-provider` 9.12.2](https://github.com/panva/node-oidc-provider/releases/tag/v9.12.2), [Prisma 7.10.0](https://github.com/prisma/orm/releases), [Prisma 7 và ESM/adapter](https://www.prisma.io/docs/orm/v7).

**Nguồn kiểm tra frontend và công cụ:** [React 19.3](https://react.dev/blog/2026/09/09/react-19-3), [Vite 8.3.0](https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md), [`@vitejs/plugin-react` 6.1.2](https://github.com/vitejs/vite-plugin-react/releases), [`oidc-client-ts` 3.5.0](https://github.com/authts/oidc-client-ts/releases), [Vitest 5.0.4](https://github.com/vitest-dev/vitest/releases), [Playwright 1.64.1](https://github.com/microsoft/playwright/releases), [PostgreSQL 17.11](https://www.postgresql.org/docs/17/release-17-11.html).

## 1. Kết quả cuối cùng cần bàn giao

Người dùng đăng ký trên Identity Server, bắt đầu đăng nhập từ React, hoàn tất mật khẩu và MFA mock trên Identity Server, nhận Authorization Code, đổi code bằng PKCE S256, xác minh ID Token, gọi Protected Resource API bằng Access Token, thực hiện refresh/revoke và logout. Repo có hướng dẫn chạy, protocol/security tests, audit, threat model, security headers, secret scanning và review checklist.

Các chức năng trên thuộc MVP hoặc minh chứng bắt buộc. Docker, triển khai VPS, Email Service và API quản trị client là phần tùy chọn; không đưa vào đường găng của MVP.

## 2. Phân vai và quyền sở hữu

Phân công do nhóm trưởng cung cấp: TV1 Lê Hoàng Nam (`RMLunaria`), TV2 Đặng Minh Quang (`dangminhquang3006-sketch`), TV3 Bùi Thùy Châu Anh (`synaamin`), TV4 Đặng Bích Minh Phương (`mphuong1702`). TV2 là đầu mối tích hợp theo phân công này; từng thành viên xác nhận phạm vi trong issue của mình. Mỗi người viết test cho phần mình triển khai; TV4 phụ trách test xuyên module và bằng chứng bảo mật, không phải người duy nhất viết test.

| Vai trò | Phạm vi sở hữu | Bàn giao chính | Người phối hợp sát nhất |
| --- | --- | --- | --- |
| **TV1 — Authentication: Lê Hoàng Nam** (`RMLunaria`) | `users`, đăng ký/đăng nhập, password hashing, session/interaction UI, MFA mock | User schema, luồng password → MFA → hoàn tất interaction, test hợp lệ/lỗi | TV2 |
| **TV2 — OIDC Provider & tích hợp: Đặng Minh Quang** (`dangminhquang3006-sketch`) | Cấu hình `oidc-provider`, client public, Discovery, PKCE, persistence adapter, token lifecycle | Provider chạy được, adapter PostgreSQL, refresh/revoke, test giao thức; chịu trách nhiệm ghép luồng OIDC xuyên suốt | TV1, TV3 |
| **TV3 — React demo client: Bùi Thùy Châu Anh** (`synaamin`) | React/Vite, OIDC client, callback, ID Token validation, dashboard, protected routes, logout UI | Đăng nhập từ React, hiển thị hồ sơ, gọi API demo, xử lý lỗi và logout | TV2, TV4 |
| **TV4 — Resource API & assurance: Đặng Bích Minh Phương** (`mphuong1702`) | Protected Resource API, token validation, audit, protocol/security integration tests, threat model, CI/tài liệu bảo mật | API từ chối token sai, audit sạch secret, test/CI và bằng chứng GitHub | Cả nhóm |

**Quy tắc sở hữu:** TV2 là đầu mối tích hợp, không tự sửa thay module của người khác. Người sở hữu module xử lý lỗi trong module đó; TV2 tái hiện lỗi và phối hợp ghép luồng. Các thay đổi issuer, redirect URI, claims, token policy hoặc schema adapter phải được TV2 thông báo cho TV1/TV3/TV4 trước khi merge.

## 3. Quyết định chung phải chốt sớm

| Quyết định | Hạn chốt | Người chuẩn bị | Đầu ra |
| --- | --- | --- | --- |
| Xác nhận bộ phiên bản ở bảng trên bằng cài đặt, build và chạy thử; ghi mọi điều chỉnh | Trước khi chia sẻ scaffold cho nhóm | TV2 + TV3 | `.nvmrc`, `package.json`, lockfile và lệnh chạy local khớp nhau |
| Local issuer, port, `client_id`, redirect URI, post-logout URI, scopes và CORS origin | Tuần 1 | TV2 + TV3 | Bảng cấu hình và `.env.example` |
| Shape của user ID và claims (`sub`, email, profile tối thiểu) | Tuần 1 | TV1 + TV2 + TV3 | Hợp đồng dữ liệu ngắn trong PR/issue |
| Giao diện Authentication ↔ provider interaction | Trước khi làm login | TV1 + TV2 | Khi nào yêu cầu login/MFA; kết quả trả provider; xử lý lỗi |
| Cách cung cấp mã MFA mock | Trước khi làm MFA | TV1 + TV4 | Kịch bản demo và test; mặc định đề xuất hiện mã trên trang local, ghi rõ đây là mock |
| Chính sách Refresh Token: điều kiện cấp, lưu ở client, rotation, revoke | Trước khi làm refresh | TV2 + TV3 + TV4 | Tài liệu chính sách và các ca test |
| Định dạng Access Token và cách API xác minh; audience/scope | Trước khi làm Protected API | TV2 + TV4 | Hợp đồng Token Validation và test |
| Logout ở client và Identity Server | Trước khi làm logout | TV2 + TV3 | Kịch bản logout và hành vi khi truy cập lại |

Không cần chốt toàn bộ chính sách token để chạy Discovery Endpoint. Các URL OIDC lấy từ Discovery Endpoint sau khi provider chạy, không tự giả định path.

### Bản quyết định tuần 1 để cả nhóm duyệt

Các giá trị dưới đây là **đề xuất để review**, chưa được coi là quyết định chung cho tới khi TV1–TV4 xác nhận trong issue/PR. Nếu đổi, sửa bảng này và `.env.example`/lockfile trong cùng PR liên quan.

| Nội dung | Đề xuất cụ thể | Người xác nhận |
| --- | --- | --- |
| Cách chạy local | Identity Server `http://localhost:3000`; React client `http://localhost:5173`. Dùng PostgreSQL cài trực tiếp nếu Docker chưa chạy được; Docker là tùy chọn. | TV2 + TV3 + TV4 |
| Kết nối PostgreSQL | Chọn **một** cổng và ghi đúng vào `.env.example`: `5432` nếu PostgreSQL cài trực tiếp, `5433` nếu dùng `identity-server/docker-compose.yml` hiện có. File mẫu trên nhánh auth đang ghi `5432` trong khi Compose map `5433:5432`; cần sửa khi ghép nhánh. | TV1 + TV2 |
| OIDC local contract | Issuer đề xuất `http://localhost:3000`; `client_id` đề xuất `app04-demo`; callback `http://localhost:5173/callback`; post-logout `http://localhost:5173/`; scope khởi đầu `openid profile email`; CORS origin chỉ `http://localhost:5173`. Endpoint giao thức được lấy qua Discovery khi provider chạy. | TV2 + TV3 |
| User/claims | `sub` dùng ID ổn định của user trong DB, không dùng email có thể thay đổi; claim `email`/`profile` tối thiểu chỉ trả khi scope và cấu hình cho phép. Chốt kiểu ID và schema thực tế trong PR A1/O1. | TV1 + TV2 + TV3 |
| Login interaction | TV1 xử lý mật khẩu/MFA trong interaction của Identity Server; TV2 cung cấp giao diện tích hợp và hoàn tất interaction sau khi TV1 báo thành công. Ghi rõ contract lỗi và session trong issue O2/A3 trước khi code. | TV1 + TV2 |
| MFA mock | Chỉ dùng tài khoản demo và hiển thị mã thử nghiệm trong môi trường local; thử sai, hết hạn, dùng lại phải bị từ chối. Không gọi đây là MFA production. | TV1 + TV4 |
| Phiên bản chung | Bảng phiên bản ở đầu tài liệu là mục tiêu, **chưa xác minh tương thích**. TV2/TV3 kiểm tra bằng cài đặt, build, Discovery và React callback rồi chốt `.nvmrc`/lockfile. Nhánh auth mẫu hiện dùng JS/Express 4/PostgreSQL 16, khác mục tiêu TypeScript/Express 5/PostgreSQL 17. | TV2 + TV3; TV1 phối hợp chuyển phần auth |

Chính sách refresh/revoke, định dạng Access Token, cách API xác minh và logout sẽ được ghi thành quyết định riêng trước O5/S1/C4/C5; chưa tự chốt khi chưa có luồng OIDC chạy được.

## 4. Backlog theo từng người

Mã việc dưới đây có thể dùng làm tiêu đề hoặc nhãn GitHub Issue. Một issue được hoàn thành khi có code/tài liệu, cách kiểm tra và bằng chứng chạy; không chỉ khi đã tạo file.

### TV1 — Authentication và người dùng

| Mã | Việc cần làm | Phụ thuộc | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| A1 | Thiết kế `users`, migration, đăng ký email/mật khẩu; hash bằng Argon2id, kiểm tra input và email trùng | Cấu hình DB chung | Đăng ký hợp lệ thành công; email trùng và input sai bị từ chối; test không lưu mật khẩu thô |
| A2 | Tra cứu user và cung cấp claims tối thiểu cho provider | Hợp đồng `sub`/claims với TV2 | Provider nhận đúng user ID/claims; test với user tồn tại và không tồn tại |
| A3 | Trang login và xử lý mật khẩu trong interaction của Identity Server | TV2 có interaction tối thiểu | Login đúng/sai chạy qua provider; có session phù hợp; giới hạn thử và lỗi không lộ tài khoản |
| A4 | MFA mock sau mật khẩu: challenge có hạn, `code_hash`, giới hạn thử, chống dùng lại | A3; kịch bản mock đã chốt | Chỉ hoàn tất interaction sau MFA đúng; test sai, hết hạn, dùng lại và quá số lần thử |
| A5 | Bảo vệ form login/MFA: CSRF, cookie/session và hướng dẫn demo | A3–A4 | Test các trường hợp chính; không ghi mật khẩu/mã MFA vào log |

### TV2 — Provider, adapter và tích hợp

| Mã | Việc cần làm | Phụ thuộc | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| O1 | Khởi tạo TypeScript/Express/`oidc-provider`, cấu hình issuer và public client | Version và local contract | Server chạy local; Discovery Endpoint trả issuer/endpoints đúng |
| O2 | Cấu hình Authorization Code + PKCE S256, redirect URI, `state`/`nonce` ở ranh giới client/provider | O1; phối hợp TV3 | Đăng nhập xuyên suốt đạt; verifier sai/thiếu và redirect URI sai bị từ chối |
| O3 | Nối interaction login/MFA và claims từ TV1 vào provider | A2–A3 | Một user đăng nhập từ React, nhận và xác minh ID Token đúng `sub` |
| O4 | Viết OIDC persistence adapter cho PostgreSQL theo API phiên bản đã khóa | O1; DB local | Artifact/session còn đúng qua restart theo thiết kế; tra cứu, hết hạn, thu hồi có test |
| O5 | Cấu hình refresh, revoke, thời hạn token, logout phía provider | O2–O4; token policy | Refresh hợp lệ chạy; token bị revoke cho kết quả đúng theo loại token; code dùng lại bị từ chối |
| O6 | Giữ tài liệu cấu hình và kịch bản chạy tích hợp | O1–O5 | Thành viên khác chạy được bằng README + `.env.example` không chứa secret thật |

### TV3 — React demo client

| Mã | Việc cần làm | Phụ thuộc | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| C1 | Khởi tạo React/Vite/TypeScript và thư viện OIDC client; cấu hình từ môi trường local | Discovery và contract TV2 | Trang demo chạy; nút Login chuyển đúng Authorization Endpoint |
| C2 | Callback Authorization Code + PKCE, đối chiếu `state`, xác minh ID Token/`nonce` bằng thư viện | O2–O3 | Dashboard chỉ hiện khi ID Token hợp lệ; callback lỗi được hiển thị an toàn |
| C3 | Dashboard, hồ sơ cơ bản, protected routes và gọi Protected Resource API | C2; hợp đồng API TV4 | API nhận Access Token; thiếu/sai token bị từ chối và UI xử lý được lỗi |
| C4 | Xử lý refresh theo chính sách đã chốt; không mặc định lưu Refresh Token vào `localStorage` | O5; token policy | Session hoạt động theo chính sách; refresh lỗi không để UI ở trạng thái đăng nhập giả |
| C5 | Logout ở React phối hợp kết thúc session Identity Server | O5; logout contract | Trạng thái client được xóa; truy cập route bảo vệ sau logout không xem được dữ liệu |
| C6 | Hướng dẫn thao tác demo và test luồng UI chính | C1–C5 | Một người khác thực hiện được kịch bản login → API → logout |

### TV4 — Protected API, audit và minh chứng bảo mật

| Mã | Việc cần làm | Phụ thuộc | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| S1 | Viết Protected Resource API trong Identity Server và Token Validation theo policy đã chốt | O1; token contract với TV2 | Token hợp lệ/đủ quyền được trả dữ liệu; token thiếu, sai, hết hạn, thiếu quyền bị từ chối |
| S2 | Audit schema/service và sự kiện login, MFA, token issuance/revocation, logout | Hợp đồng event với TV1/TV2 | Event có metadata cần thiết; test xác nhận không có password, raw token, mã MFA hoặc secret |
| S3 | Protocol/integration tests: PKCE sai/thiếu, redirect URI sai, code hết hạn/dùng lại, token sai/hết hạn, refresh/revoke | O2–O5; phối hợp chủ module | Test chạy lặp lại được, nêu rõ token nào bị revoke và kết quả mong đợi |
| S4 | Security headers, secret scanning, CI; kiểm tra form/API cùng chủ module | O1; C1 | CI chạy build/test/scanning; headers được kiểm tra; không chứa secret thật trong Git |
| S5 | Threat model, security review checklist, tài liệu kết quả và kịch bản kiểm thử cuối | Có luồng tích hợp | Tài liệu gắn với hệ thống thực tế, có biện pháp giảm thiểu và bằng chứng test |

TV4 thiết kế test từ đầu và cập nhật khi tính năng xuất hiện; không đợi đến tuần 7. TV1–TV3 chịu trách nhiệm sửa lỗi mà các test đó phát hiện trong module của mình.

## 5. Thứ tự tích hợp và mốc nghiệm thu

```text
Quyết định chung + local config
    ├── O1: Provider + Discovery ────────────────┐
    ├── A1/A2: Users + claims ────────────────────┤
    └── C1: React client khung ───────────────────┤
                                                 ↓
                       O2 + A3 + C2: Login OIDC xuyên suốt
                                                 ↓
                         A4 + O4 + O5 + C3/C4/C5 + S1/S2
                                                 ↓
                              S3/S4/S5 + demo + review cuối
```

| Mốc | Thời điểm mục tiêu | Bằng chứng tối thiểu |
| --- | --- | --- |
| **M1 — Nền tảng** | Cuối tuần 2 | `/.well-known/openid-configuration` truy cập được; issuer và endpoint đúng; có lệnh chạy local |
| **M2 — Đăng nhập xuyên suốt** | Cuối tuần 4 | React → provider → login → callback → token → ID Token hợp lệ → dashboard; test PKCE/redirect/code lỗi |
| **M3 — MVP chức năng** | Cuối tuần 6 | Signup, MFA mock, session/logout, refresh/revoke, audit và Protected API đều có demo/test |
| **M4 — Minh chứng và bàn giao** | Cuối tuần 8 | Test/CI, threat model, headers, secret scanning, checklist, README và kịch bản trình bày |

**Lịch demo đề xuất (giờ Việt Nam, cần nhóm xác nhận):** M1 vào **20:00 thứ Bảy 31/10/2026** và M2 vào **20:00 thứ Bảy 14/11/2026**. Mỗi buổi 30–45 phút, chia sẻ màn hình chạy luồng hiện có, ghi kết quả và blocker vào issue. Chưa có link họp; nhóm trưởng thêm vào kênh nhóm sau khi chốt.

**Đường găng:** O1 → interaction A3/O3 → callback C2 → M2. Nếu M2 chưa đạt, cả nhóm ưu tiên sửa tích hợp trước khi mở rộng. OIDC adapter có thể phát triển song song bằng test của TV2 nhưng phải tích hợp trước khi nghiệm thu token/session bền vững.

## 6. Kế hoạch theo tuần

| Tuần | TV1 | TV2 | TV3 | TV4 | Kết quả chung |
| --- | --- | --- | --- | --- | --- |
| 1 | Chốt user/claims, thiết kế A1 | Chốt version, issuer/client contract | Chốt callback, client config | Lập test matrix/threat model bản đầu | Hợp đồng tích hợp và môi trường local được ghi lại |
| 2 | A1–A2 | O1, bắt đầu O4 | C1 | Khung CI và test Discovery | **M1** |
| 3 | A3 | O2–O3 | C2 | Test PKCE/redirect/callback cùng nhóm | Login đầu tiên từ React |
| 4 | Ổn định A3, hỗ trợ lỗi tích hợp | Ghép O2–O3, test code/token | Hoàn tất C2 | Test luồng hợp lệ và lỗi | **M2** |
| 5 | A4–A5 | O4–O5 | C3–C4 | S1–S2 | MFA, refresh và API demo tích hợp |
| 6 | Sửa lỗi auth/MFA | Hoàn tất O5/O6 | C5–C6 | Hoàn tất S1–S3 | **M3** |
| 7 | Test hồi quy auth | Test hồi quy OIDC | Test hồi quy UI | S3–S5, CI/scanning | Lỗ hổng và lỗi được ghi, sửa, chạy test lại |
| 8 | Hỗ trợ demo | Kiểm tra cấu hình/chạy lại | Hoàn thiện demo | Tổng hợp bằng chứng/checklist | **M4** |

Timeline là mục tiêu tham khảo; điều chỉnh theo tiến độ thực tế mà vẫn giữ đủ chức năng và minh chứng bắt buộc.

## 7. Quy tắc Git và định nghĩa hoàn thành

1. Tạo issue theo mã việc; mỗi issue nêu người phụ trách, phụ thuộc, đầu ra và cách kiểm tra. Dùng nhánh ngắn theo việc, ví dụ `feat/user-registration`, `feat/oidc-provider-bootstrap`, `feat/react-oidc-client`, `test/oidc-pkce-cases`.
2. **Quy tắc nhánh đề xuất để nhóm duyệt:** `main` là nhánh tích hợp; mỗi việc làm trên nhánh riêng từ `main`, mở PR vào `main`, tối thiểu một người khác review rồi mới merge. Không push trực tiếp vào `main`; không sửa nhánh của thành viên khác nếu chưa trao đổi. Nếu PR phụ thuộc việc chưa merge, ghi rõ issue/PR phụ thuộc và chỉ merge khi tích hợp chạy được.
3. Mỗi PR ghi rõ thay đổi, lệnh chạy/test, kết quả thật, ảnh hoặc log cần thiết và tác động tới hợp đồng tích hợp. Không merge chỉ dựa vào việc code biên dịch.
4. Khi thay đổi schema, biến môi trường, endpoint, claims hoặc token policy, cập nhật tài liệu và thông báo các chủ module bị ảnh hưởng trong PR.
5. Tính năng được coi là **Done** khi: chạy local theo README; có test phù hợp và đã chạy; xử lý lỗi cơ bản; không lộ secret; được review; ghép được với module liên quan. Test chưa chạy phải ghi rõ, không báo đạt.
6. Cuối mỗi tuần có một buổi demo ngắn trên nhánh tích hợp: chạy lại luồng hiện có, liệt kê blocker và cập nhật kế hoạch tuần sau. Ưu tiên PR nhỏ để giảm xung đột khi 4 người làm song song.

## 8. Việc cần làm ngay sau khi phân công

- [x] Điền tên thật và GitHub username cho TV1–TV4; TV2 là đầu mối tích hợp theo phân công của nhóm trưởng. Từng thành viên xác nhận phạm vi trong issue.
- [ ] Cả nhóm duyệt bảng quyết định tuần 1 ở trên; ghi kết quả cuối vào issue/PR và cấu hình mẫu.
- [ ] Đăng issue O1, A1, C1, S4 theo phạm vi ở mục 4 và gán đúng người.
- [ ] Cả nhóm xác nhận `main` là nhánh tích hợp và quy tắc PR ở mục 7 trước khi merge code.
- [ ] Cả nhóm xác nhận lịch M1/M2 đề xuất ở mục 5, thêm link họp và dùng kết quả chạy được làm thước đo tiến độ.
