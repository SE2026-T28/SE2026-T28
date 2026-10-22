import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = tracked.filter(path => {
  const name = basename(path);
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
});
if (forbidden.length) {
  // Only filenames are printed, never file content.
  throw new Error(`Environment files must stay out of Git: ${forbidden.join(', ')}`);
}
console.log('Tracked environment files: only .env.example is permitted.');
