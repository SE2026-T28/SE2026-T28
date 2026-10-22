import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { userRouter } from "./users/user.routes.js";
import { prisma } from "./db/prisma.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/users", userRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Không ghi request body, password hoặc passwordHash vào log.
  console.error("Unhandled request error", error instanceof Error ? error.message : "unknown");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Đã xảy ra lỗi máy chủ." },
  });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Identity Server listening on port ${port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
