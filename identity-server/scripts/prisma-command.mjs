import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configDatasource, prismaPlan } from './prisma-policy.mjs';
import { projectRoot } from './test-database.mjs';

try {
  const [operation, ...extra] = process.argv.slice(2);
  const args = prismaPlan(operation, extra);
  const env = { ...process.env, S3_PRISMA_OPERATION: operation };
  configDatasource(args, env); // validate the actual locked plan before starting Prisma
  const result = spawnSync(process.execPath, [join(projectRoot, 'node_modules/prisma/build/index.js'), ...args], {
    cwd: projectRoot, env, stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} catch {
  console.error('S3 database safety / Prisma policy: command, override, or database proof refused. No Prisma operation was started.');
  process.exitCode = 1;
}
