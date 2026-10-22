# CI và kiểm tra bảo mật — S4

Workflow `Security foundation` chạy khi mở/cập nhật PR và push vào main, với quyền contents:read và Node 24.22.0.

| Job | Nội dung |
| --- | --- |
| applications | Phát hiện scaffold, yêu cầu lockfile khi có package.json; ghi Pending nếu chưa có |
| backend | npm ci, npm test (gồm TypeScript build và test Discovery/CORS/Helmet), npm run test:headers |
| frontend | npm ci, npm test, npm run build khi client-demo/package.json có trong cùng nhánh |
| secrets | Chặn .env được Git theo dõi; Gitleaks 8.30.1 quét lịch sử Git và thư mục nguồn, che giá trị secret |

Backend là kiểm tra bắt buộc ở nhánh S4 này. Frontend hiện chưa có trong nhánh: job sẽ skip và summary ghi Pending; không coi skip là frontend build đạt. Không tự checkout nhánh TV3 trong CI vì cần kiểm tra đúng code của commit đang review. Khi C1 được merge vào cùng nhánh tích hợp, job frontend tự chạy.

## Chạy local

Trong identity-server, với Node 24.22.0:

```text
npm ci
npm test
npm run test:headers
```

Từ thư mục repo:

```text
node tests/security/check-tracked-env.mjs
gitleaks git . --redact --log-opts=--all
gitleaks dir . --redact
```

Gitleaks có thể dùng binary local; Docker chỉ cần trong runner Ubuntu của CI. Không cần container hóa ứng dụng. Không thêm allowlist toàn thư mục để bỏ qua phát hiện.

Script server-headers dùng cổng tạm, khởi động bản build O1 bằng cấu hình test, xác nhận issuer của Discovery, kiểm tra headers rồi dừng tiến trình. Không cần .env/credential thật và không sửa server đang chạy của thành viên khác. Với server đã chạy, có thể dùng `node tests/security/check-headers.mjs <URL>` từ repo.

## Trạng thái và review

Xem [kết quả kiểm tra](security-validation.md). Chưa có GitHub Actions run vì chưa push/tạo PR. Sau khi được phép up, PR cần ghi `Refs #6`, nguồn phụ thuộc O1, các lệnh/kết quả local, frontend còn chờ C1 và URL Actions run. Chỉ đóng issue sau khi các kiểm tra bắt buộc trên PR đã chạy thực sự và được review; không dùng kết quả local để thay thế bằng chứng CI.

Nhánh feat/security-ci được tạo từ commit O1 của TV2, không thay đổi nhánh TV2. Khi mở PR vào main trước khi O1 merge, diff sẽ bao gồm scaffold O1; cần ghi rõ phụ thuộc và chờ O1 merge để review riêng phần S4. Không tự merge các nhánh của nhóm.
