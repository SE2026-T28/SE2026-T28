import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import argon2 from "argon2";
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
