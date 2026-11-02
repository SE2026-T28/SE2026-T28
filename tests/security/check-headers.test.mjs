import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./check-headers.mjs', import.meta.url));
const headers = {
  'content-security-policy': "default-src 'self';object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

test('Header checker accepts expected headers and rejects missing/unsafe headers', async () => {
  for (const variant of ['valid', ...Object.keys(headers), 'powered-by', 'server-error']) {
    const fixture = { ...headers };
    if (variant in fixture) delete fixture[variant];
    if (variant === 'powered-by') fixture['x-powered-by'] = 'fixture';
    const server = createServer((_req, res) => {
      res.writeHead(variant === 'server-error' ? 500 : 200, fixture);
      res.end('{}');
    }).listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const target = `http://127.0.0.1:${server.address().port}/`;
      if (variant === 'valid') {
        const result = await run(process.execPath, [script, target]);
        assert.match(result.stdout, /Header checks passed/);
      } else {
        await assert.rejects(run(process.execPath, [script, target]), error => error.code === 1);
      }
    } finally {
      server.close();
      await once(server, 'close');
    }
  }
});

test('Header checker requires an explicit URL', async () => {
  await assert.rejects(run(process.execPath, [script]), error => error.code === 1 && error.stderr.includes('Usage:'));
});
