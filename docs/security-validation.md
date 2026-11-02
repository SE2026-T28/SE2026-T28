# Kết quả kiểm tra S4 — issue #6

**Cập nhật local:** 02/11/2026. Nhánh `feat/security-ci` đang được ghép với `main` gồm O1, C1 và A1. Phạm vi S4 chỉ gồm CI, security headers, chặn file `.env` và secret scanning. Không thêm Protected API, audit, MFA hay các chức năng của issue khác.

## Đã chạy trên máy chuẩn bị PR

| Kiểm tra | Kết quả |
| --- | --- |
| Node | Dùng binary local 24.22.0; Node mặc định toàn máy vẫn là 24.21.0 |
| Backend `npm ci` theo lockfile đã ghép | Đạt; npm báo 0 vulnerabilities khi cài |
| Prisma `db:generate` với URL mẫu trỏ tới `app04_test` | Đạt; lệnh này chỉ generate client, không kết nối hay sửa database |
| Backend `npm run build` | Đạt |
| Test Discovery O1 và security headers S4 không cần database | 7/7 đạt; gồm headers trên route `/health` và preflight đăng ký A1, CORS vẫn đúng |
| Test script kiểm tra headers | 2/2 đạt |
| React C1 `npm ci`, `npm test`, `npm run build` | Đạt; 8/8 test và Vite build đạt |
| `check-tracked-env.mjs` | Đạt; không có `.env` được Git theo dõi |
| Gitleaks quét lịch sử Git | 22 commit, không thấy leak |
| Gitleaks quét nguồn hiện tại | Không thấy leak |

## Chưa chạy hoặc chưa thể xác nhận

- Máy chuẩn bị PR không có PostgreSQL test đang chạy; Docker daemon không khả dụng. Vì vậy **chưa chạy local** migration, 6 test A1 cần database, full `npm test` (dự kiến 13 test) và smoke test `server-headers.mjs` khởi động `server.ts` có kết nối database. Review PR #10 của Quang ghi nhận migration và 9/9 test của O1+A1 trên PostgreSQL 17 ở commit A1 trước khi ghép S4; bằng chứng đó không thay cho run của nhánh S4.
- Workflow đã được cấu hình với PostgreSQL 17.11 service và `DATABASE_URL` chỉ vào `app04_test`, nhưng **chưa chạy trên GitHub cho commit tích hợp S4**. Cần kiểm tra URL run, kết quả backend/frontend/secrets và migration sau khi được phép push.
- Chưa thử toàn bộ browser flow và CSP của trang login/MFA vì các chức năng đó chưa nằm trong phạm vi code đã ghép. Kiểm tra lại headers/CSP khi các route mới xuất hiện.

## Cách xử lý xung đột khi ghép `main`

Giữ `package.json` và lockfile đầy đủ của A1/O1/C1, thêm script `test:headers` của S4. `main` đã có Helmet 8.3.0; bỏ lần gắn Helmet trùng trong `app.ts`, giữ middleware `securityHeaders(config.issuer)` của S4 **trước** các route đăng ký và provider. OIDC Discovery và route đăng ký cùng nằm trong `createApp()`; không sửa logic A1 hoặc React.

Xem [hướng dẫn CI](ci.md) để chạy lại. Kết quả local không được coi là kết quả GitHub Actions của PR #9.
