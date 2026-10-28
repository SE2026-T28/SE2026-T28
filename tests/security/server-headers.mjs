import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const cwd = fileURLToPath(new URL('../../identity-server/', import.meta.url));
const check = fileURLToPath(new URL('./check-headers.mjs', import.meta.url));
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
probe.close();
await once(probe, 'close');
const issuer = `http://localhost:${port}`;
const target = `http://127.0.0.1:${port}/.well-known/openid-configuration`;
// Isolated CI process: no .env or real credentials are needed.
const server = spawn(process.execPath, ['dist/src/server.js'], {
  cwd,
  env: {
    ...process.env,
    NODE_ENV: 'test', PORT: String(port), OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'app04-react-demo',
    OIDC_REDIRECT_URI: 'http://localhost:5173/callback',
    OIDC_POST_LOGOUT_REDIRECT_URI: 'http://localhost:5173/',
    OIDC_SCOPES: 'openid profile email', OIDC_CORS_ORIGIN: 'http://localhost:5173',
  },
  stdio: 'ignore',
});
const stopped = once(server, 'close');
let startError;
server.on('error', error => { startError = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startError || server.exitCode !== null) throw new Error('Server did not start');
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && (await response.json()).issuer === issuer) {
        ready = true;
        break;
      }
    } catch { /* Retry only while waiting for startup. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Discovery did not become ready within the startup deadline');
  const checker = spawn(process.execPath, [check, target], { stdio: 'inherit' });
  const [code] = await once(checker, 'close');
  if (code !== 0) throw new Error('Server header checks failed');
} finally {
  if (server.exitCode === null) server.kill();
  await stopped;
}
