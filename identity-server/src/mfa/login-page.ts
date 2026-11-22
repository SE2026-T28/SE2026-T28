function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

export function renderMfaPage(input: {
  uid: string;
  csrfToken: string;
  error?: "invalid_code" | "expired" | "locked";
  expiresAt: Date;
  demoCode?: string;
}): string {
  const messages = {
    invalid_code: "Mã xác minh không hợp lệ. Vui lòng thử lại.",
    expired: "Challenge đã hết hạn. Hãy bắt đầu lại luồng đăng nhập.",
    locked: "Đã vượt quá số lần thử. Vui lòng thử lại sau.",
  };
  const error = input.error ? `<p role="alert">${messages[input.error]}</p>` : "";
  const demo = input.demoCode
    ? `<aside aria-label="MFA mock demo code"><strong>MOCK — LOCAL/TEST ONLY:</strong> <code>${escapeHtml(input.demoCode)}</code><p>Đây chỉ là mã demo, không phải MFA production.</p></aside>`
    : "";
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Cache-Control" content="no-store">
  <title>Xác minh MFA (MOCK)</title>
</head>
<body>
  <main>
    <h1>Xác minh MFA (MOCK)</h1>
    <p>Nhập mã xác minh để tiếp tục đăng nhập.</p>
    <p>Challenge hết hạn lúc: <time>${escapeHtml(input.expiresAt.toISOString())}</time></p>
    ${error}
    ${demo}
    <form method="post" action="/interaction/${encodeURIComponent(input.uid)}/mfa" autocomplete="off">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
      <label for="code">Mã xác minh</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required autocomplete="one-time-code">
      <button type="submit">Xác minh</button>
    </form>
  </main>
</body>
</html>`;
}
