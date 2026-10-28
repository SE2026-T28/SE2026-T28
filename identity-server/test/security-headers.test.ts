import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { test } from 'node:test';
import { securityHeaders } from '../src/security/headers.js';

for (const issuer of ['http://localhost:3000', 'https://identity.example.test']) {
  test(`Security headers for configured issuer ${issuer}`, async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders(issuer));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/test`);
      assert.equal(response.status, 200);
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.equal(csp.includes('unsafe-inline'), false);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('x-powered-by'), null);
      if (issuer.startsWith('https:')) {
        assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
        assert.ok(csp.includes('upgrade-insecure-requests'));
      } else {
        assert.equal(response.headers.get('strict-transport-security'), null);
        assert.equal(csp.includes('upgrade-insecure-requests'), false);
      }
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
}

test('HTTP headers configuration rejects non-local issuers', () => {
  assert.throws(() => securityHeaders('http://identity.example.test'), /loopback/);
});
