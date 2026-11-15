import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const moduleRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
export const projectRoot = basename(moduleRoot) === 'dist' ? realpathSync(join(moduleRoot, '..')) : moduleRoot;
export const lockedConfig = join(projectRoot, 'prisma.config.ts');
export const lockedSchema = join(projectRoot, 'prisma/schema.prisma');
export const lockedMigrations = join(projectRoot, 'prisma/migrations');
export const runtimeRoot = join(projectRoot, 'node_modules/.s3-runs');
export const digest = value => createHash('sha256').update(value).digest('hex');

// This is URL policy only. It does not prove isolation.
export function assertTestDatabase(env = process.env) {
  const reject = () => { throw new Error('S3 database safety: invalid test database URL policy'); };
  if (env.NODE_ENV === 'production') reject();
  let url;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { reject(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/app04_test' || url.hash) reject();
  // pg accepts connection overrides in query parameters: do not allow host/dbname/options.
  const entries = [...url.searchParams];
  if (entries.length > 1 || entries.some(([key, value]) => key !== 'schema' || value !== 'public')) reject();
  return url.href;
}

export function readManagedSession(env = process.env) {
  const reject = () => { throw new Error('S3 database safety: managed PostgreSQL session required; an isolation flag is not proof'); };
  try {
    const file = realpathSync(env.S3_DATABASE_MANIFEST ?? '');
    const rel = relative(realpathSync(runtimeRoot), file);
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.endsWith('session.json')) reject();
    const session = JSON.parse(readFileSync(file, 'utf8'));
    if (!env.S3_DATABASE_CAPABILITY || digest(env.S3_DATABASE_CAPABILITY) !== session.capabilityHash) reject();
    if (assertTestDatabase(env) !== session.url || !new URL(session.url).port) reject();
    if (!session.systemIdentifier || !session.dataDirectory || !session.startedAt || session.pid <= 0) reject();
    if (digest(readFileSync(lockedSchema)) !== session.schemaHash || digest(readFileSync(lockedConfig)) !== session.configHash) reject();
    return session;
  } catch { reject(); }
}

// Live verification uses the same manifest URL; arbitrary URLs never reach a socket.
export function assertManagedDatabase(env = process.env) {
  readManagedSession(env);
  const check = spawnSync(process.execPath, [join(projectRoot, 'scripts/verify-test-database.mjs')], {
    cwd: projectRoot, env, encoding: 'utf8', timeout: 10000,
  });
  if (check.status !== 0) throw new Error('S3 database safety: managed instance identity verification failed');
  return readManagedSession(env).url;
}
