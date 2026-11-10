import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { assertManagedDatabase } from "../scripts/test-database.mjs";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";
import { createFixtureScope } from "./fixture-scope.js";

export function createUserFixtures() {
  assertManagedDatabase();
  return createFixtureScope(async emails => {
    assertManagedDatabase();
    await getPrisma().user.deleteMany({ where: { email: { in: emails } } });
  });
}

export async function withUserFixtures<T>(run: (fixtures: ReturnType<typeof createUserFixtures>) => Promise<T>): Promise<T> {
  const fixtures = createUserFixtures();
  try { return await run(fixtures); }
  finally { await fixtures.cleanup(); }
}

export async function createIntegrationTestContext() {
  assertManagedDatabase(); // before Prisma connects, server starts, or any cleanup runs
  const fixtures = createUserFixtures();
  let server: Server | undefined;
  const close = async () => {
    try {
      await fixtures.cleanup(); // drain tracked registration before closing its HTTP server
    } finally {
      try { if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
      finally { await disconnectPrisma(); }
    }
  };
  try {
    await getPrisma().$connect();
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const issuer = `http://localhost:${port}`;
    server = createApp({
      port, issuer, clientId: "app04-react-demo", redirectUri: "http://localhost:5173/callback",
      postLogoutRedirectUri: "http://localhost:5173/", scopes: ["openid", "profile", "email"], corsOrigin: "http://localhost:5173",
    }).listen(port);
    await once(server, "listening");
    return { baseUrl: issuer, fixtures, close };
  } catch (error) {
    await close();
    throw error;
  }
}
