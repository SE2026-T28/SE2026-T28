import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import pg from 'pg';
import { ownedDocker, cleanupSteps } from './harness-cleanup.mjs';
import { assertManagedDatabase, digest, lockedConfig, lockedSchema, projectRoot, runtimeRoot } from './test-database.mjs';

const requested = process.argv.slice(2);
const driver = requested[0]?.replace('--driver=', '') ?? (process.platform === 'win32' ? 'native' : 'docker');
if (requested.length > 1 || (requested.length && requested[0] !== `--driver=${driver}`) || !['native', 'docker'].includes(driver)) {
  throw new Error('Use test:isolated with only --driver=native or --driver=docker');
}
mkdirSync(runtimeRoot, { recursive: true });
const runDir = mkdtempSync(join(runtimeRoot, 'run-'));
const data = join(runDir, 'pgdata');
const manifest = join(runDir, 'session.json');
const passwordFile = join(runDir, 'init-password');
let password = randomBytes(32).toString('hex');
let capability = randomBytes(32).toString('hex');
const runId = randomUUID();
const bin = process.env.S3_POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const tool = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
let container;
let nativeStarted = false;
let client;
let sessionEnv;
const docker = ownedDocker(command, runId);

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error('S3 harness: infrastructure command failed (details retained in private runtime logs)');
  return result.stdout.trim();
}

async function npmRun(args, env) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Start harness through npm run test:isolated');
  const child = spawn(process.execPath, [npm, ...args], { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error('S3 harness: test stage failed');
}

try {
  console.log(`S3 harness: creating new ${driver} PostgreSQL instance.`);
  let port;
  let identifier;
  let expectedDirectory;
  let pid;
  if (driver === 'native') {
    if (!command(tool('postgres'), ['--version']).includes('17.11')) throw new Error('PostgreSQL 17.11 required');
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    port = probe.address().port;
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' });
    command(tool('initdb'), ['-D', data, '-U', 's3review', '-A', 'scram-sha-256', '--pwfile', passwordFile, '--encoding=UTF8', '--locale=C']);
    unlinkSync(passwordFile);
    identifier = command(tool('pg_controldata'), ['-D', data]).match(/Database system identifier:\s+(\d+)/)?.[1];
    command(tool('pg_ctl'), ['-D', data, '-l', join(runDir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c log_min_error_statement=panic`, '-w', 'start']);
    nativeStarted = true;
    expectedDirectory = data;
    pid = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
  } else {
    const info = docker.start([
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=s3review', '--env', `POSTGRES_PASSWORD=${password}`,
      '--env', 'POSTGRES_DB=app04_test', '--env', 'PGDATA=/var/lib/postgresql/data/pgdata', 'postgres:17.11']);
    container = info.Id;
    port = Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort);
    expectedDirectory = '/var/lib/postgresql/data/pgdata';
    pid = info.State.Pid;
  }
  const base = `postgresql://s3review:${password}@127.0.0.1:${port}/`;
  // Only the freshly created instance is contacted. Its random credentials and
  // control-file identity must match before CREATE DATABASE or any migration.
  for (let attempt = 0; attempt < 60; attempt++) {
    client = new pg.Client({ connectionString: base + (driver === 'native' ? 'postgres' : 'app04_test'), connectionTimeoutMillis: 1000 });
    try { await client.connect(); break; }
    catch { await client.end().catch(() => {}); client = undefined; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!client) throw new Error('Owned PostgreSQL did not become ready');
  if (driver === 'docker') identifier = command('docker', ['exec', container, 'pg_controldata', expectedDirectory]).match(/Database system identifier:\s+(\d+)/)?.[1];
  const { rows: [actual] } = await client.query(`SELECT system_identifier::text AS id,
    current_setting('data_directory') AS directory, pg_postmaster_start_time()::text AS started FROM pg_control_system()`);
  if (!identifier || actual.id !== identifier || actual.directory.replaceAll('\\', '/') !== expectedDirectory.replaceAll('\\', '/')) throw new Error('Owned server identity mismatch');
  if (driver === 'native') await client.query('CREATE DATABASE app04_test');
  await client.end(); client = undefined;
  const url = base + 'app04_test?schema=public';
  writeFileSync(manifest, JSON.stringify({ url, capabilityHash: digest(capability), systemIdentifier: identifier,
    dataDirectory: actual.directory, startedAt: actual.started, pid, driver,
    schemaHash: digest(readFileSync(lockedSchema)), configHash: digest(readFileSync(lockedConfig)), runId,
  }), { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, S3_DATABASE_MANIFEST: manifest, S3_DATABASE_CAPABILITY: capability };
  sessionEnv = env;
  for (const key of ['S3_TEST_DATABASE_ISOLATED', 'S3_PRISMA_OPERATION', 'APP04_ALLOW_DEV_MIGRATIONS', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGOPTIONS', 'SHADOW_DATABASE_URL']) delete env[key];
  assertManagedDatabase(env);
  console.log('S3 isolation proof: control-file system_identifier, live data_directory, startup time, and app04_test match.');
  await npmRun(['run', 'db:generate'], env);
  await npmRun(['run', 'test:safety'], env);
  await npmRun(['run', 'db:deploy'], env);
  await npmRun(['run', 'db:deploy'], env);
  await npmRun(['test'], env);
  console.log('S3 harness: running two fixture/registration suites concurrently.');
  const suite = async () => {
    const child = spawn(process.execPath, ['--test', 'dist/test/registration.test.js', 'dist/test/fixtures.test.js'], {
      cwd: projectRoot, env, stdio: 'inherit', windowsHide: true,
    });
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error('Parallel suite failed');
  };
  const parallel = await Promise.allSettled([suite(), suite()]);
  if (parallel.some(result => result.status === 'rejected')) throw new Error('Parallel suites failed');
  await npmRun(['run', 'test:headers'], env);
  client = new pg.Client({ connectionString: url }); await client.connect();
  const { rows } = await client.query('SELECT count(*)::int AS count FROM users');
  if (rows[0].count !== 0) throw new Error('Fixture residue found');
  console.log('S3 harness: remaining users=0; all managed stages PASS.');
} catch {
  console.error('S3 harness FAILED. No shared/development database fallback is allowed.');
  process.exitCode = 1;
} finally {
  const failures = await cleanupSteps([
    ['session invalidation', () => { if (existsSync(manifest)) writeFileSync(manifest, '{}'); }],
    ['credential references', () => {
      if (sessionEnv) for (const key of ['DATABASE_URL', 'S3_DATABASE_MANIFEST', 'S3_DATABASE_CAPABILITY']) delete sessionEnv[key];
      password = ''; capability = '';
    }],
    ['client disconnect', async () => { await client?.end(); }],
    ['manifest removal', () => { if (existsSync(manifest)) unlinkSync(manifest); }],
    ['password file removal', () => { if (existsSync(passwordFile)) unlinkSync(passwordFile); }],
    ['owned PostgreSQL stop', () => {
      if (driver === 'native' && (nativeStarted || existsSync(join(data, 'postmaster.pid')))) {
        command(tool('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
      }
    }],
    ['owned Docker cleanup', () => { if (driver === 'docker') docker.cleanup(); }],
  ]);
  if (failures.length) {
    console.error(`S3 harness cleanup incomplete: ${failures.join(', ')}. Manual recovery of owned resources required.`);
    process.exitCode = 1;
  } else console.log('S3 harness: session revoked; owned instance stopped; runtime files remain Git-ignored.');
}
