import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";

export interface IntegrationTestContext {
  baseUrl: string;
  close: () => Promise<void>;
}

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

/**
 * Starts the real Express/Provider app against a dedicated *_test database.
 * Each test file must use its own email prefix to avoid cross-file cleanup.
 */
export async function createIntegrationTestContext(
  emailPrefix: string,
): Promise<IntegrationTestContext> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(
    databaseUrl,
    "Set DATABASE_URL to a dedicated PostgreSQL test database",
  );

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\/+/, ""),
  );
  assert.match(
    databaseName,
    /(?:^|_)test$/i,
    "Safety check: integration tests only run against a database whose name ends with _test",
  );

  const prisma = getPrisma();
  let server: Server | undefined;
  try {
    await prisma.$connect();

    // Remove only records owned by this test file.
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
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

    return {
      baseUrl: config.issuer,
      close: async () => {
        try {
          if (server?.listening) {
            await new Promise<void>((resolve, reject) => {
              server!.close((error) => (error ? reject(error) : resolve()));
            });
          }
        } finally {
          try {
            await prisma.user.deleteMany({
              where: { email: { startsWith: emailPrefix } },
            });
          } finally {
            await disconnectPrisma();
          }
        }
      },
    };
  } catch (error) {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await disconnectPrisma();
    throw error;
  }
}
