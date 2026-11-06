export type LoginPageError = "invalid_credentials" | "expired_interaction";

export interface LoginPageOptions {
  uid: string;
  /** Interaction-bound token generated and verified by the interaction handler. */
  csrfToken: string;
  error?: LoginPageError;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

/**
 * Render the Identity Server-hosted login form used by the OIDC interaction.
 * No inline JS/CSS is emitted, so the existing Helmet CSP remains applicable.
 * The interaction handler must verify `_csrf` before authenticating credentials.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  if (typeof options.uid !== "string" || !options.uid.trim()) {
    throw new TypeError("A non-empty interaction uid is required.");
  }
  if (typeof options.csrfToken !== "string" || !options.csrfToken.trim()) {
    throw new TypeError("A session-bound CSRF token is required.");
  }

  const action = `/interaction/${encodeURIComponent(options.uid)}/login`;
  const errorMessage = options.error === "invalid_credentials"
    ? "Email hoặc mật khẩu không chính xác. Vui lòng thử lại."
    : options.error === "expired_interaction"
      ? "Phiên đăng nhập đã hết hạn. Vui lòng quay lại ứng dụng và thử lại."
      : "";

  const errorMarkup = errorMessage
    ? `<p id="login-error" role="alert">${errorMessage}</p>`
    : "";

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Đăng nhập — APP-04</title>
  </head>
  <body>
    <main>
      <h1>Đăng nhập</h1>
      <p>Đăng nhập vào tài khoản Identity Server để tiếp tục.</p>
      ${errorMarkup}
      <form method="post" action="${escapeHtml(action)}" accept-charset="UTF-8">
        <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" maxlength="254" required>
        </div>
        <div>
          <label for="password">Mật khẩu</label>
          <input id="password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required>
        </div>
        <button type="submit">Đăng nhập</button>
      </form>
    </main>
  </body>
</html>`;
}
