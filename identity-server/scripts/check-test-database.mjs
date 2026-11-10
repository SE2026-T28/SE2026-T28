import { assertManagedDatabase } from './test-database.mjs';

try {
  assertManagedDatabase();
  console.log('S3 managed PostgreSQL identity verified.');
} catch {
  console.error('S3 database safety: run npm run test:isolated. No database operation was started.');
  process.exitCode = 1;
}
