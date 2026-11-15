import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownedDocker, cleanupSteps } from '../scripts/harness-cleanup.mjs';

const runId = '12345678-1234-4234-8234-123456789abc';
const id = 'a'.repeat(64);
const foreignId = 'b'.repeat(64);
function info(containerId = id, label = runId, name = `/app04-s3-${runId}`) {
  return { Id: containerId, Name: name, Config: { Image: 'postgres:17.11', Labels: { 'app04.s3.run': label } } };
}

for (const failure of ['ETIMEDOUT', 'create failed after daemon allocated container']) {
  test(`HARNESS-DOCKER: recover owned container after ${failure}`, async () => {
    const removed: string[] = [];
    const docker = ownedDocker((_exe, args) => {
      if (args[0] === 'run') {
        assert.equal(args[args.indexOf('--name') + 1], `app04-s3-${runId}`);
        assert.equal(args[args.indexOf('--label') + 1], `app04.s3.run=${runId}`);
        throw new Error(failure);
      }
      if (args[0] === 'ps') {
        assert.deepEqual(args.slice(-2), ['--filter', `label=app04.s3.run=${runId}`]);
        assert.ok(args.includes('--all')); // include created/stopped containers
        return id;
      }
      if (args[0] === 'inspect') return JSON.stringify([info()]);
      assert.deepEqual(args, ['rm', '--force', id]);
      removed.push(args[2]); return '';
    }, runId);
    assert.throws(() => docker.start(['postgres:17.11']), new RegExp(failure));
    assert.deepEqual(await cleanupSteps([['Docker', () => docker.cleanup()]]), []);
    assert.deepEqual(removed, [id]);
  });
}

test('HARNESS-DOCKER: failure before creation leaves nothing to remove', () => {
  const docker = ownedDocker((_exe, args) => {
    if (args[0] === 'run') throw new Error('create refused');
    assert.equal(args[0], 'ps'); return '';
  }, runId);
  assert.throws(() => docker.start([]), /create refused/);
  docker.cleanup();
});

test('HARNESS-DOCKER: reject foreign label/name/image/ID and still remove an owned candidate', () => {
  for (const invalid of [info(foreignId, 'another-run'), info(foreignId, runId, '/foreign'),
    { ...info(foreignId), Config: { ...info().Config, Image: 'another-image' } }, info(id)]) {
    const removed: string[] = [];
    const docker = ownedDocker((_exe, args) => {
      if (args[0] === 'ps') return `${foreignId}\n${id}`;
      if (args[0] === 'inspect') return JSON.stringify([args[1] === foreignId ? invalid : info()]);
      removed.push(args[2]); return '';
    }, runId);
    assert.throws(() => docker.cleanup(), /incomplete/);
    assert.deepEqual(removed, [id]);
  }
});

test('HARNESS-CLEANUP: unlink failures do not prevent revocation or either shutdown step', async () => {
  const attempted: string[] = [];
  let manifest = 'valid capability';
  let credential = 'private';
  const errors = await cleanupSteps([
    ['invalidate', () => { manifest = '{}'; attempted.push('invalidate'); }],
    ['credentials', () => { credential = ''; attempted.push('credentials'); }],
    ['manifest unlink', () => { attempted.push('manifest unlink'); throw new Error('EACCES secret'); }],
    ['password unlink', () => { attempted.push('password unlink'); throw new Error('EPERM secret'); }],
    ['native stop', () => { attempted.push('native stop'); }],
    ['Docker stop', () => { attempted.push('Docker stop'); }],
  ]);
  assert.deepEqual(errors, ['manifest unlink', 'password unlink']);
  assert.deepEqual(attempted, ['invalidate', 'credentials', 'manifest unlink', 'password unlink', 'native stop', 'Docker stop']);
  assert.equal(manifest, '{}'); assert.equal(credential, '');
  assert.doesNotMatch(errors.join(','), /EACCES|EPERM|secret/);
});

test('HARNESS-CLEANUP: failed invalidation/disconnect/stop still attempt removal and later steps', async () => {
  const attempted: string[] = [];
  const failures = await cleanupSteps(['invalidate', 'clear credentials', 'disconnect', 'unlink', 'native stop', 'Docker stop']
    .map(name => [name, async () => {
      attempted.push(name);
      if (['invalidate', 'disconnect', 'native stop'].includes(name)) throw new Error('private details');
    }] as [string, () => Promise<void>]));
  assert.deepEqual(attempted, ['invalidate', 'clear credentials', 'disconnect', 'unlink', 'native stop', 'Docker stop']);
  assert.deepEqual(failures, ['invalidate', 'disconnect', 'native stop']);
});
