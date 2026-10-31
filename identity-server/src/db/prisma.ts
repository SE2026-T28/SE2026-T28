import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

let prismaClient: PrismaClient | undefined;

/**
 * Khởi tạo Prisma khi API thực sự cần dùng database.
 * Cách lazy này cho phép O1 Discovery tests import createApp() mà không cần
 * DATABASE_URL, miễn là các test đó không gọi Registration API.
 */
export function getPrisma(): PrismaClient {
  if (prismaClient) return prismaClient;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Registration API");
  }

  const adapter = new PrismaPg({ connectionString });
  prismaClient = new PrismaClient({ adapter });
  return prismaClient;
}

export async function disconnectPrisma(): Promise<void> {
  if (!prismaClient) return;

  const client = prismaClient;
  prismaClient = undefined;
  await client.$disconnect();
}
