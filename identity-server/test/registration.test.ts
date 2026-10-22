import { describe, it, expect } from "vitest";

const BASE_URL =
  process.env.TEST_BASE_URL ?? "http://localhost:3000";

async function register(email: string, password: string) {
  return fetch(`${BASE_URL}/api/users/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
}

describe("POST /api/users/register", () => {
  it("đăng ký thành công với email hợp lệ", async () => {
    const email = `test-${Date.now()}@example.com`;
    const password = "TestPass123!";

    const response = await register(email, password);
    const responseText = await response.text();
    const data = JSON.parse(responseText);

    expect(response.status).toBe(201);
    expect(data.user.email).toBe(email);
    expect(data.user.id).toBeDefined();
    expect(responseText).not.toContain(password);
    expect(responseText).not.toContain("password_hash");
  });

  it("từ chối email đã tồn tại", async () => {
    const email = `duplicate-${Date.now()}@example.com`;
    const password = "TestPass123!";

    const first = await register(email, password);
    expect(first.status).toBe(201);

    const second = await register(email, password);
    const data = await second.json();

    expect(second.status).toBe(409);
    expect(data.error.code).toBe("EMAIL_EXISTS");
  });

  it("từ chối email sai định dạng", async () => {
    const response = await register("abc", "TestPass123!");

    expect(response.status).toBe(400);
  });

  it("từ chối mật khẩu quá ngắn", async () => {
    const email = `short-${Date.now()}@example.com`;
    const response = await register(email, "123");

    expect(response.status).toBe(400);
  });
});