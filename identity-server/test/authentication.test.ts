import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  authenticateUser,
  findUserByEmail,
  findUserById,
} from "../src/users/authentication.js";
import { createIntegrationTestContext } from "./helpers.js";

let context: Awaited<ReturnType<typeof createIntegrationTestContext>> | undefined;

async function register(email: string, password: string): Promise<{ id: string; email: string }> {
  assert.ok(context, "Integration test server is not running");
  const response = await fetch(`${context.baseUrl}/api/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 201);
  const data = await response.json() as { user: { id: string; email: string } };
  return data.user;
}

before(async () => {
  context = await createIntegrationTestContext("a2-test-");
});

after(async () => {
  await context?.close();
});

test("tra cứu user thành công bằng ID và chỉ trả dữ liệu công khai", async () => {
  const email = `a2-test-${randomUUID()}@example.com`;
  const password = "M2-Test-Password-123!";
  const created = await register(email, password);

  const account = await findUserById(created.id);
  assert.ok(account);
  assert.equal(account.id, created.id);
  assert.equal(account.email, email);
  assert.deepEqual(Object.keys(account).sort(), ["email", "id"]);
});

test("tra cứu user thành công bằng email đã trim và chuẩn hóa chữ thường", async () => {
  const email = `a2-test-${randomUUID()}@example.com`;
  await register(email, "M2-Test-Password-123!");

  const account = await findUserByEmail(`  ${email.toUpperCase()}  `);
  assert.ok(account);
  assert.equal(account.email, email);
  assert.deepEqual(Object.keys(account).sort(), ["email", "id"]);
});

test("trả null khi tra cứu ID không tồn tại hoặc rỗng", async () => {
  assert.equal(await findUserById(randomUUID()), null);
  assert.equal(await findUserById(""), null);
  assert.equal(await findUserById("   "), null);
  assert.equal(await findUserById("not-a-uuid"), null);
  assert.equal(await findUserById("12345678-1234-1234-1234-not-a-uuid"), null);
});

test("trả null khi tra cứu email không tồn tại hoặc sai định dạng", async () => {
  assert.equal(await findUserByEmail(`missing-${randomUUID()}@example.com`), null);
  assert.equal(await findUserByEmail("invalid-email"), null);
});

test("authenticateUser trả account { id, email } khi mật khẩu chính xác", async () => {
  const email = `a2-test-${randomUUID()}@example.com`;
  const password = "M2-Test-Password-123!";
  const created = await register(email, password);

  const account = await authenticateUser(` ${email.toUpperCase()} `, password);
  assert.ok(account);
  assert.equal(account.id, created.id);
  assert.equal(account.email, email);
  assert.deepEqual(Object.keys(account).sort(), ["email", "id"]);
  assert.equal("passwordHash" in account, false);
});

test("authenticateUser trả null khi mật khẩu sai", async () => {
  const email = `a2-test-${randomUUID()}@example.com`;
  await register(email, "M2-Test-Password-123!");

  assert.equal(await authenticateUser(email, "Wrong-Password-123!"), null);
});

test("authenticateUser trả null khi email không tồn tại", async () => {
  assert.equal(
    await authenticateUser(`missing-${randomUUID()}@example.com`, "M2-Test-Password-123!"),
    null,
  );
});

test("authenticateUser trả null khi email sai định dạng hoặc mật khẩu ngoài policy", async () => {
  assert.equal(await authenticateUser("invalid-email", "M2-Test-Password-123!"), null);
  assert.equal(await authenticateUser(`a2-test-${randomUUID()}@example.com`, "short"), null);
  assert.equal(await authenticateUser(`a2-test-${randomUUID()}@example.com`, "x".repeat(129)), null);
});
