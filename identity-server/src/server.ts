import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { disconnectPrisma, getPrisma } from "./db/prisma.js";

async function startServer(): Promise<void> {
  const config = readConfig();

  // A1: xác nhận PostgreSQL sẵn sàng trước khi nhận request.
  await getPrisma().$connect();

  const server = createApp(config).listen(config.port, () => {
    // O1: giữ nguyên thông tin issuer và Discovery.
    console.log(`Identity Server listening at ${config.issuer}`);
    console.log(`Discovery: ${config.issuer}/.well-known/openid-configuration`);
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Identity Server...`);

    server.close((serverError) => {
      void (async () => {
        try {
          await disconnectPrisma();
        } catch (error) {
          console.error("Prisma shutdown failed", error);
          process.exitCode = 1;
        }

        if (serverError) {
          console.error("HTTP server shutdown failed", serverError);
          process.exitCode = 1;
        }
      })();
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void startServer().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  try {
    await disconnectPrisma();
  } catch (disconnectError) {
    console.error("Prisma cleanup failed", disconnectError);
  }
  process.exitCode = 1;
});
