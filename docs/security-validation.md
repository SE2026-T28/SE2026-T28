# Kết quả kiểm tra issue #6 — S4

Ngày: 22/10/2026. Phạm vi: CI, Helmet/security headers, secret scanning. Không triển khai Protected API, audit hay protocol tests của các issue khác.

## Nguồn và môi trường

- Nhánh bàn giao local: feat/security-ci, dựa trên O1 commit 33906593248f384331669b9f58c071810b9af58f.
- React được kiểm tra trên bản sao C1 commit 9796e7c9b2c8d30cc83629100b016f861cac4424; không đưa code React vào nhánh S4.
- Node kiểm thử: 24.22.0, cài riêng; không đổi Node toàn máy.
- Helmet 8.3.0, Gitleaks 8.30.1. Binary Gitleaks đối chiếu SHA256 với checksum của release chính thức.

## Kết quả local

| Kiểm tra | Kết quả |
| --- | --- |
| Backend npm ci theo lockfile | Đạt |
| Backend npm test: build TypeScript, Discovery/CORS và 3 test Helmet | 5/5 đạt |
| Test script kiểm tra headers: ca đúng, thiếu từng header, lộ x-powered-by, HTTP 500, thiếu URL | 2/2 nhóm test đạt |
| Kiểm tra headers trên server OIDC chạy thật | Đạt CSP tối thiểu, nosniff, no-referrer, không có x-powered-by |
| React npm ci trên bản sao C1 | Đạt |
| React npm test | 8/8 đạt |
| React npm run build | Type-check và Vite build đạt |
| Gitleaks git --all | 9 commit đã quét, không phát hiện secret |
| Gitleaks dir | Không phát hiện secret trong nguồn hiện tại |
| Gitleaks với token giả trong fixture riêng ngoài repo | Phát hiện 1 mẫu, exit 1 đúng mong đợi; chứng minh nhánh báo lỗi hoạt động |
| Kiểm tra file env được Git theo dõi | Không có .env trái quy định; chỉ cho phép .env.example |
| git check-ignore | .env, node_modules, dist của backend được bỏ qua |

Trước khi tích hợp Helmet, kiểm tra server O1 nguyên bản đã tái hiện lỗi thiếu Content-Security-Policy. Hiện Helmet đã được gắn trong app.ts của nhánh S4, dependency và lockfile đã cập nhật; không chỉ là module rời. Kiểm tra issuer HTTPS chỉ xác minh cấu hình header trên HTTP test harness, chưa chứng minh triển khai TLS.

## Điều chưa thể xác nhận trước khi up

- Workflow chưa chạy trên GitHub PR; chưa có URL run và review.
- Frontend job hiện chờ C1 có trong cùng nhánh tích hợp; kết quả React phía trên là local trên bản sao riêng.
- Login/MFA/API chưa có trong O1: cần kiểm tra headers/CSP trên các route đó khi chủ module bổ sung. Chưa thử browser flow/CSP toàn bộ giao diện.

## File và lệnh bàn giao

Code chính: identity-server/src/security/headers.ts; app.ts gắn middleware trước provider; package.json/package-lock.json khóa Helmet. Test: identity-server/test/security-headers.test.ts và tests/security. Workflow: .github/workflows/security.yml.

Chạy backend: npm ci, npm test, npm run test:headers trong identity-server với Node 24.22.0. Chi tiết CI và phụ thuộc PR: [ci.md](ci.md). Nguồn cấu hình: [Helmet](https://helmet.js.org/) và [Gitleaks](https://github.com/gitleaks/gitleaks).
