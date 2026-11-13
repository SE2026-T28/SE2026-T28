import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import argon2 from "argon2";
import * as fc from "fast-check";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";

let server: Server | undefined;
let baseUrl = "";
let databaseConnected = false;

async function findAvailablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");

  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = (address as AddressInfo).port;

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });

  return port;
}

async function register(email: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "Set DATABASE_URL to a dedicated PostgreSQL test database");

  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ""));
  assert.match(
    databaseName,
    /(?:^|_)test$/i,
    "Safety check: integration tests only run against a database whose name ends with _test",
  );

  const prisma = getPrisma();
  await prisma.$connect();
  databaseConnected = true;

  // Dọn dữ liệu do lần chạy test trước để lại, chỉ trong database *_test.
  await prisma.user.deleteMany({
    where: { email: { startsWith: "a1-test-" } },
  });

  const port = await findAvailablePort();
  const config = {
    port,
    issuer: `http://localhost:${port}`,
    clientId: "app04-react-demo",
    redirectUri: "http://localhost:5173/callback",
    postLogoutRedirectUri: "http://localhost:5173/",
    scopes: ["openid", "profile", "email"],
    corsOrigin: "http://localhost:5173",
  };

  server = createApp(config).listen(port);
  await once(server, "listening");
  baseUrl = config.issuer;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
  }

  try {
    if (databaseConnected) {
      await getPrisma().user.deleteMany({
        where: { email: { startsWith: "a1-test-" } },
      });
    }
  } finally {
    await disconnectPrisma();
  }
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
  const allowed = await fetch(`${baseUrl}/api/users/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

  const denied = await fetch(`${baseUrl}/api/users/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5174",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(denied.status, 403);
});

test("import bulk xử lý độc lập bản ghi hợp lệ và không trả password", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const validEmail1 = `${prefix}-1@example.com`;
  const invalidEmail = `${prefix}-invalid`;
  const validEmail2 = `${prefix}-2@example.com`;
  const password1 = "Valid-Password-123";
  const password2 = "Valid-Password-456";
  const password3 = "Valid-Password-789";

  const response = await fetch(`${baseUrl}/api/users/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      users: [
        { email: validEmail1, password: password1 },
        { email: invalidEmail, password: password2 },
        { email: validEmail2, password: password3 },
      ],
    }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
  );
  const data = JSON.parse(responseText) as {
    summary: { total: number; succeeded: number; failed: number };
    results: Array<{
      index: number;
      status: "succeeded" | "failed";
      user?: { id: string; email: string; createdAt: string };
      error?: { code: string };
    }>;
  };

  assert.deepEqual(data.summary, { total: 3, succeeded: 2, failed: 1 });
  assert.deepEqual(data.results.map((result) => result.index), [0, 1, 2]);
  assert.equal(data.results[0]?.status, "succeeded");
  assert.equal(data.results[0]?.user?.email, validEmail1);
  assert.equal(data.results[2]?.status, "succeeded");
  assert.equal(data.results[2]?.user?.email, validEmail2);
  assert.equal(data.results[1]?.status, "failed");
  assert.equal(data.results[1]?.error?.code, "INVALID_INPUT");

  for (const result of [data.results[0], data.results[2]]) {
    assert.equal(result?.status, "succeeded");
    assert.ok(result?.user);
    assert.deepEqual(Object.keys(result.user).sort(), ["createdAt", "email", "id"]);
  }

  assert.equal(responseText.includes(password1), false);
  assert.equal(responseText.includes(password2), false);
  assert.equal(responseText.includes(password3), false);
  assert.equal(responseText.toLowerCase().includes("passwordhash"), false);

  const storedUsers = await getPrisma().user.findMany({
    where: { email: { in: [validEmail1, validEmail2, invalidEmail] } },
    select: { email: true, passwordHash: true },
    orderBy: { email: "asc" },
  });

  assert.deepEqual(storedUsers.map((user) => user.email), [validEmail1, validEmail2].sort());
  assert.equal(storedUsers.length, 2);
  for (const user of storedUsers) {
    assert.match(user.passwordHash, /^\$argon2id\$/);
  }
  assert.equal(storedUsers.some((user) => user.email === invalidEmail), false);
});

test("import bulk nhận diện email trùng sau chuẩn hóa", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const email = `${prefix}@example.com`;
  const password = "Valid-Password-123";

  const response = await fetch(`${baseUrl}/api/users/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      users: [
        { email: ` ${email.toUpperCase()} `, password },
        { email: ` ${email} `, password },
      ],
    }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
  );
  const data = JSON.parse(responseText) as {
    summary: { total: number; succeeded: number; failed: number };
    results: Array<{ status: string; error?: { code: string } }>;
  };

  assert.deepEqual(data.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(data.results[0]?.status, "succeeded");
  assert.equal(data.results[1]?.status, "failed");
  assert.equal(data.results[1]?.error?.code, "EMAIL_EXISTS");

  const storedUsers = await getPrisma().user.findMany({
    where: { email: email.toLowerCase() },
    select: { email: true },
  });
  assert.deepEqual(storedUsers.map((user) => user.email), [email.toLowerCase()]);
});

test("import bulk không để bản ghi invalid chiếm email trong Set", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const email = `${prefix}@example.com`;

  const response = await fetch(`${baseUrl}/api/users/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      users: [
        { email: ` ${email.toLowerCase()} `, password: "short" },
        { email: ` ${email.toUpperCase()} `, password: "Valid-Password-123" },
      ],
    }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
  );
  const data = JSON.parse(responseText) as {
    summary: { total: number; succeeded: number; failed: number };
    results: Array<{ status: string; error?: { code: string } }>;
  };

  assert.deepEqual(data.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(data.results[0]?.status, "failed");
  assert.equal(data.results[0]?.error?.code, "INVALID_INPUT");
  assert.equal(data.results[1]?.status, "succeeded");

  const storedUser = await getPrisma().user.findUnique({
    where: { email: email.toLowerCase() },
    select: { email: true },
  });
  assert.equal(storedUser?.email, email.toLowerCase());
});

test("import bulk giữ bản ghi trước và sau lỗi persistence", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const firstEmail = `${prefix}-first@example.com`;
  const failingEmail = `${prefix}-failure@example.com`;
  const lastEmail = `${prefix}-last@example.com`;
  const constraintName = `bulk_import_reject_${randomUUID().replaceAll("-", "_")}`;
  const prisma = getPrisma();

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "users" ADD CONSTRAINT "${constraintName}" CHECK (email <> '${failingEmail.replaceAll("'", "''")}')`,
  );

  try {
    const response = await fetch(`${baseUrl}/api/users/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        users: [
          { email: firstEmail, password: "Valid-Password-123" },
          { email: failingEmail, password: "Valid-Password-456" },
          { email: lastEmail, password: "Valid-Password-789" },
        ],
      }),
    });
    const responseText = await response.text();
    assert.equal(
      response.status,
      200,
      `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
    );
    const data = JSON.parse(responseText) as {
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ index: number; status: string; error?: { code: string } }>;
    };

    assert.deepEqual(data.summary, { total: 3, succeeded: 2, failed: 1 });
    assert.deepEqual(data.results.map((result) => result.index), [0, 1, 2]);
    assert.equal(data.results[0]?.status, "succeeded");
    assert.equal(data.results[1]?.status, "failed");
    assert.equal(data.results[1]?.error?.code, "PERSISTENCE_ERROR");
    assert.equal(data.results[2]?.status, "succeeded");

    const storedUsers = await prisma.user.findMany({
      where: { email: { in: [firstEmail, failingEmail, lastEmail] } },
      select: { email: true },
      orderBy: { email: "asc" },
    });
    assert.deepEqual(storedUsers.map((user) => user.email), [firstEmail, lastEmail].sort());
    assert.equal(storedUsers.some((user) => user.email === failingEmail), false);
    assert.equal(responseText.includes("Valid-Password-123"), false);
    assert.equal(responseText.includes("Valid-Password-456"), false);
    assert.equal(responseText.includes("Valid-Password-789"), false);
    assert.equal(responseText.toLowerCase().includes("passwordhash"), false);
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "${constraintName}"`,
    );
  }
});

test("import bulk giữ invariant cho danh sách hỗn hợp", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          emailKind: fc.constantFrom("valid", "invalid", "empty", "unicode"),
          unicodeName: fc.constantFrom("Nguyễn", "Đặng", "Hồ", "Lê", "Trần"),
          passwordValid: fc.boolean(),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      async (records) => {
        const prefix = `a1-test-bulk-${randomUUID()}`;
        const users = records.map((record, index) => {
          const email =
            record.emailKind === "valid"
              ? `${prefix}-valid-${index}@example.com`
              : record.emailKind === "invalid"
                ? `${prefix}-invalid-${index}`
                : record.emailKind === "empty"
                  ? ""
                  : `${prefix}-${record.unicodeName}-${index}@example.com`;
          const password = record.passwordValid
            ? index % 2 === 0
              ? `Valid-${prefix}-${index}`
              : `Mật-khẩu-${prefix}-${index}`
            : "short";
          return { email, password };
        });
        const expectedValid = records.map((record, index) => ({
          email:
            record.emailKind === "valid"
              ? `${prefix}-valid-${index}@example.com`
              : record.emailKind === "unicode"
                ? `${prefix}-${record.unicodeName.toLowerCase()}-${index}@example.com`
                : "",
          valid:
            (record.emailKind === "valid" || record.emailKind === "unicode") &&
            record.passwordValid,
        }));

        const response = await fetch(`${baseUrl}/api/users/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ users }),
        });
        const responseText = await response.text();
        assert.equal(
          response.status,
          200,
          `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
        );
        const data = JSON.parse(responseText) as {
          summary: { total: number; succeeded: number; failed: number };
          results: Array<{
            index: number;
            status: string;
            user?: { email: string };
            error?: { code: string };
          }>;
        };

        const successCount = expectedValid.filter((record) => record.valid).length;
        assert.equal(data.summary.total, users.length);
        assert.equal(data.summary.succeeded, successCount);
        assert.equal(data.summary.failed, users.length - successCount);
        assert.deepEqual(data.results.map((result) => result.index), users.map((_, index) => index));
        assert.equal(data.results.length, users.length);

        for (const [index, expected] of expectedValid.entries()) {
          const result = data.results[index];
          if (expected.valid) {
            assert.equal(result?.status, "succeeded");
            assert.equal(result?.user?.email, expected.email);
          } else {
            assert.equal(result?.status, "failed");
            assert.equal(result?.error?.code, "INVALID_INPUT");
          }
        }

        const storedUsers = await getPrisma().user.findMany({
          where: { email: { startsWith: prefix } },
          select: { email: true },
          orderBy: { email: "asc" },
        });
        assert.deepEqual(
          storedUsers.map((user) => user.email).sort(),
          expectedValid.filter((record) => record.valid).map((record) => record.email).sort(),
        );
        for (const user of users) {
          assert.equal(responseText.includes(user.password), false);
        }
        assert.equal(responseText.toLowerCase().includes("passwordhash"), false);
      },
    ),
    { numRuns: 10 },
  );
});

test("import bulk nhận diện duplicate email bằng property", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 1_000_000_000 }), async (identifier) => {
      const prefix = `a1-test-bulk-${randomUUID()}`;
      const normalizedEmail = `${prefix}-${identifier}@example.com`;
      const response = await fetch(`${baseUrl}/api/users/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          users: [
            { email: ` ${normalizedEmail.toUpperCase()} `, password: "Valid-Password-123" },
            { email: ` ${normalizedEmail} `, password: "Valid-Password-456" },
          ],
        }),
      });
      const responseText = await response.text();
      assert.equal(
        response.status,
        200,
        `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
      );
      const data = JSON.parse(responseText) as {
        summary: { total: number; succeeded: number; failed: number };
        results: Array<{ status: string; error?: { code: string } }>;
      };

      assert.deepEqual(data.summary, { total: 2, succeeded: 1, failed: 1 });
      assert.equal(data.results[0]?.status, "succeeded");
      assert.equal(data.results[1]?.status, "failed");
      assert.equal(data.results[1]?.error?.code, "EMAIL_EXISTS");

      const storedUsers = await getPrisma().user.findMany({
        where: { email: normalizedEmail },
        select: { email: true },
      });
      assert.deepEqual(storedUsers.map((user) => user.email), [normalizedEmail]);
    }),
    { numRuns: 10 },
  );
});

test("TC-20: từ chối request bulk có envelope không hợp lệ", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const requests = [
    {},
    { users: { email: `${prefix}@example.com`, password: "Valid-Password-123" } },
    { users: [] },
  ];

  for (const body of requests) {
    const response = await fetch(`${baseUrl}/api/users/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(data.error.code, "INVALID_REQUEST");
  }

  const storedUsers = await getPrisma().user.findMany({
    where: { email: { startsWith: prefix } },
    select: { email: true },
  });
  assert.equal(storedUsers.length, 0);
});

test("TC-21: từ chối mọi bản ghi bulk sai kiểu dữ liệu", async () => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const users = [
    null,
    "not-an-object",
    { email: 123, password: "Valid-Password-123" },
    { email: `${prefix}@example.com`, password: 456 },
  ];

  const response = await fetch(`${baseUrl}/api/users/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ users }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
  );
  const data = JSON.parse(responseText) as {
    summary: { total: number; succeeded: number; failed: number };
    results: Array<{ index: number; status: string; error?: { code: string } }>;
  };

  assert.deepEqual(data.summary, { total: 4, succeeded: 0, failed: 4 });
  assert.deepEqual(data.results.map((result) => result.index), [0, 1, 2, 3]);
  for (const result of data.results) {
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "INVALID_INPUT");
  }

  const storedUsers = await getPrisma().user.findMany({
    where: { email: { startsWith: prefix } },
    select: { email: true },
  });
  assert.equal(storedUsers.length, 0);
});

test("TC-22: trả HASH_ERROR khi Argon2id hash thất bại", async (t) => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  const email = `${prefix}@example.com`;
  t.mock.method(argon2, "hash", async () => {
    throw new Error("controlled hash failure");
  });

  const response = await fetch(`${baseUrl}/api/users/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      users: [{ email, password: "Valid-Password-123" }],
    }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `Expected bulk import HTTP 200, received ${response.status}. Response: ${responseText}`,
  );
  const data = JSON.parse(responseText) as {
    summary: { total: number; succeeded: number; failed: number };
    results: Array<{ status: string; error?: { code: string } }>;
  };

  assert.deepEqual(data.summary, { total: 1, succeeded: 0, failed: 1 });
  assert.equal(data.results[0]?.status, "failed");
  assert.equal(data.results[0]?.error?.code, "HASH_ERROR");

  const storedUser = await getPrisma().user.findUnique({
    where: { email },
    select: { email: true },
  });
  assert.equal(storedUser, null);
  assert.equal(responseText.includes("Valid-Password-123"), false);
  assert.equal(responseText.toLowerCase().includes("passwordhash"), false);
});

test("giới hạn tám thao tác Argon2id đồng thời", async (t) => {
  const prefix = `a1-test-bulk-${randomUUID()}`;
  let activeHashes = 0;
  let peakHashes = 0;
  t.mock.method(argon2, "hash", async () => {
    activeHashes += 1;
    peakHashes = Math.max(peakHashes, activeHashes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeHashes -= 1;
    return "fake-argon2id-hash";
  });

  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) => fetch(`${baseUrl}/api/users/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        users: [{
          email: `${prefix}-${index}@example.com`,
          password: `Valid-Password-${index}`,
        }],
      }),
    })),
  );
  const responseBodies = await Promise.all(responses.map(async (response) => ({
    response,
    data: await response.json() as {
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ status: string }>;
    },
  })));

  assert.ok(peakHashes > 1, `Expected concurrent hash peak > 1, received ${peakHashes}`);
  assert.ok(peakHashes <= 8, `Expected concurrent hash peak <= 8, received ${peakHashes}`);
  for (const { response, data } of responseBodies) {
    assert.equal(response.status, 200);
    assert.deepEqual(data.summary, { total: 1, succeeded: 1, failed: 0 });
    assert.equal(data.results[0]?.status, "succeeded");
  }

  const storedUsers = await getPrisma().user.findMany({
    where: { email: { startsWith: prefix } },
    select: { email: true },
  });
  assert.equal(storedUsers.length, 12);
});
