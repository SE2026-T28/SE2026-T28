import "dotenv/config";
import { defineConfig } from "prisma/config";
import { configDatasource, lockedSchema, lockedMigrations } from "./scripts/prisma-policy.mjs";

export default defineConfig({
  schema: lockedSchema,
  migrations: {
    path: lockedMigrations,
  },
  datasource: {
    url: configDatasource(process.argv.slice(2)),
  },
});
