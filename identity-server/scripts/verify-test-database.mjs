import pg from 'pg';
import { readManagedSession } from './test-database.mjs';

let client;
try {
  const session = readManagedSession(); // validate capability, URL and source hashes first
  client = new pg.Client({ connectionString: session.url, connectionTimeoutMillis: 2000, query_timeout: 2000 });
  await client.connect();
  const { rows: [actual] } = await client.query(`SELECT current_database() AS db,
    system_identifier::text AS id, current_setting('data_directory') AS directory,
    pg_postmaster_start_time()::text AS started FROM pg_control_system()`);
  if (actual.db !== 'app04_test' || actual.id !== session.systemIdentifier
    || actual.directory.replaceAll('\\', '/') !== session.dataDirectory.replaceAll('\\', '/')
    || actual.started !== session.startedAt) throw new Error('identity mismatch');
} catch {
  console.error('S3 database safety: instance proof missing, stale, or mismatched');
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
