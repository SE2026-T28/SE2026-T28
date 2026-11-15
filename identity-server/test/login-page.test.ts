
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLoginPage } from "../src/users/login-page.js";

test("login page post tới interaction login và gửi CSRF token cùng credentials", () => {
  const html = renderLoginPage({
    uid: "uid-123",
    csrfToken: "csrf-456",
  });

  assert.ok(
    html.includes(
      '<form method="post" action="/interaction/uid-123/login"'
    )
  );
  assert.match(html, /name="csrf" value="csrf-456"/);
  assert.doesNotMatch(html, /name="_csrf"/);
  assert.match(html, /name="email" type="email"/);
  assert.match(html, /name="password" type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.doesNotMatch(html, /<script|<style|\sstyle=/i);
});

test("login page URL-encode uid and HTML-escape CSRF token", () => {
  const html = renderLoginPage({
    uid: "uid-<script>alert(1)</script>",
    csrfToken: 'token-" - <img src=x>',
    error: "invalid_credentials",
  });

  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("<img src=x>"), false);

  assert.match(html, /%3Cscript%3E/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&quot;/);
  assert.match(html, /Email hoặc mật khẩu không chính xác/);
});

test("login page displays expired interaction error without exposing credentials", () => {
  const html = renderLoginPage({
    uid: "uid-expired",
    csrfToken: "csrf-expired",
    error: "expired_interaction",
  });

  assert.match(html, /Phiên đăng nhập đã hết hạn/);
  assert.equal(html.includes("passwordHash"), false);
});

test("login page requires interaction uid and a CSRF token", () => {
  assert.throws(
    () => renderLoginPage({ uid: "", csrfToken: "csrf" }),
    /uid/
  );

  assert.throws(
    () => renderLoginPage({ uid: "uid", csrfToken: " " }),
    /CSRF/
  );
});
