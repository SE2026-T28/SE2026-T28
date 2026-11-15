import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import argon2 from "argon2";
import { getPrisma } from "../src/db/prisma.js";
import { createIntegrationTestContext } from "./helpers.js";

let context: Awaited<ReturnType<typeof createIntegrationTestContext>> | undefined;

async function register(email: string, password: string): Promise<Response> {
  assert.ok(context, "Integration test server is not running");
  return fetch(`${context.baseUrl}/api/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  context = await createIntegrationTestContext("a1-test-");
});

after(async () => {
  await context?.close();
});

test("đăng ký thành công, lưu Argon2id và không trả password hash", async () => {
  const email = `a1-test-${randomUUID()}@example.com`;
  const password = "A1-Test-Password-123!";

  const response = await register(email, password);
  const responseText = await response.text();
  const data = JSON.parse(responseText) as {
    user: { id: string; email: string; createdAt: string };
  };

  assert.equal(response.status, 201);
  assert.equal(data.user.email, email);
  assert.ok(data.user.id);
  assert.ok(data.user.createdAt);
  assert.deepEqual(Object.keys(data.user).sort(), ["createdAt", "email", "id"]);
  assert.equal(responseText.includes(password), false);
  assert.equal(responseText.toLowerCase().includes("passwordhash"), false);

  const stored = await getPrisma().user.findUnique({
    where: { email },
    select: { passwordHash: true },
  });
  assert.ok(stored);
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(stored.passwordHash, password), true);
});

test("từ chối email trùng, không phân biệt chữ hoa/thường", async () => {
  const email = `a1-test-${randomUUID()}@example.com`;
  const password = "A1-Test-Password-123!";

  const first = await register(email, password);
  assert.equal(first.status, 201);

  const second = await register(email.toUpperCase(), password);
  const data = await second.json() as { error: { code: string } };

  assert.equal(second.status, 409);
  assert.equal(data.error.code, "EMAIL_EXISTS");
});

test("từ chối email sai định dạng", async () => {
  const response = await register("not-an-email", "A1-Test-Password-123!");
  const data = await response.json() as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(data.error.code, "INVALID_INPUT");
});

test("từ chối mật khẩu ngắn hơn 8 ký tự", async () => {
  const email = `a1-test-${randomUUID()}@example.com`;
  const response = await register(email, "123");
  const data = await response.json() as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(data.error.code, "INVALID_INPUT");
});

test("hai request đồng thời cùng email chỉ tạo một người dùng", async () => {
  const email = `a1-test-${randomUUID()}@example.com`;
  const password = "A1-Test-Password-123!";

  const responses = await Promise.all([
    register(email, password),
    register(email.toUpperCase(), password),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [201, 409],
  );

  const count = await getPrisma().user.count({ where: { email } });
  assert.equal(count, 1);
});

test("Registration CORS chỉ cho phép origin của React demo", async () => {
  assert.ok(context);
  const allowed = await fetch(`${context.baseUrl}/api/users/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

  const denied = await fetch(`${context.baseUrl}/api/users/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5174",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(denied.status, 403);
});
