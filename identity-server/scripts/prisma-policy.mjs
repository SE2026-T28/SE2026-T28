import { realpathSync } from 'node:fs';
import { assertTestDatabase, assertManagedDatabase, lockedConfig, lockedSchema, lockedMigrations } from './test-database.mjs';

export function prismaPlan(operation, extra = []) {
  // No pass-through flags: config/schema/URL overrides cannot reach Prisma.
  const commands = { generate: ['generate'], deploy: ['migrate', 'deploy'], status: ['migrate', 'status'], dev: ['migrate', 'dev'] };
  if (!commands[operation]) throw new Error('S3 Prisma policy: command not supported (db push/execute/seed/reset are not enabled)');
  if (extra.length && !(operation === 'dev' && extra.length === 2 && extra[0] === '--name' && /^[a-zA-Z0-9_-]{1,80}$/.test(extra[1]))) {
    throw new Error('S3 Prisma policy: override or unknown arguments refused');
  }
  if (realpathSync(lockedSchema) !== lockedSchema || realpathSync(lockedConfig) !== lockedConfig) throw new Error('S3 Prisma policy: source path mismatch');
  return [...commands[operation], ...extra, '--config', lockedConfig];
}

export function configDatasource(args, env = process.env) {
  const operation = env.S3_PRISMA_OPERATION;
  if (!operation) throw new Error('S3 Prisma policy: use the controlled npm database commands');
  const extra = operation === 'dev' && args[2] === '--name' ? args.slice(2, 4) : [];
  if (JSON.stringify(args) !== JSON.stringify(prismaPlan(operation, extra))) throw new Error('S3 Prisma policy: actual CLI arguments differ from locked plan');
  if (env.S3_DATABASE_MANIFEST) {
    if (operation === 'dev') throw new Error('S3 Prisma policy: migrate dev/shadow database is not allowed in a test session');
    return assertManagedDatabase(env);
  }
  if (operation === 'generate') return 'postgresql://127.0.0.1:1/app04_test'; // generate never accesses DB
  if (env.APP04_ALLOW_DEV_MIGRATIONS !== '1' || env.NODE_ENV === 'production') throw new Error('S3 database safety: managed session or explicit development opt-in required');
  let url;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { throw new Error('Development database URL refused'); }
  assertTestDatabase({ ...env, DATABASE_URL: url.href.replace(/\/app04(?=\?|$)/, '/app04_test') });
  if (url.pathname !== '/app04') throw new Error('Development database must be local app04');
  return url.href;
}

export { lockedSchema, lockedMigrations };
