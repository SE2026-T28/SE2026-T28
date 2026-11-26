import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const browserPath = process.env.M3_CHROME_PATH ?? '/usr/bin/google-chrome';
const clientRoot = resolve(import.meta.dirname, '../../client-demo');
const clientOrigin = 'http://localhost:5173';
const previous = {
  MFA_MOCK_ENABLED: process.env.MFA_MOCK_ENABLED,
  MFA_DEMO_CODE_ENABLED: process.env.MFA_DEMO_CODE_ENABLED,
  MFA_CODE_PEPPER: process.env.MFA_CODE_PEPPER,
};
process.env.MFA_MOCK_ENABLED = 'true';
process.env.MFA_DEMO_CODE_ENABLED = 'true';
process.env.MFA_CODE_PEPPER = randomBytes(32).toString('hex');
let context;
let vite;
let chrome;
let browser;
let profileDir;

async function waitUntil(check, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* navigation can destroy the current JavaScript context */ }
    await delay(100);
  }
  throw new Error(`M3 browser E2E timed out: ${label}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.waiters = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const waiter = this.waiters.get(message.id);
      if (!waiter) return;
      this.waiters.delete(message.id);
      if (message.error) waiter.reject(new Error('Chrome DevTools command failed'));
      else waiter.resolve(message.result);
    });
  }
  command(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('Browser expression failed');
    return response.result?.value;
  }
  close() { this.ws.close(); }
}

async function startBrowser() {
  profileDir = await mkdtemp(join(tmpdir(), 'app04-m3-chrome-'));
  chrome = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const port = await waitUntil(async () => {
    const content = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
    return Number(content.split('\n')[0]);
  }, 'Chrome debugging endpoint');
  const target = await waitUntil(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find(page => page.type === 'page')?.webSocketDebuggerUrl;
  }, 'Chrome page target');
  const ws = new WebSocket(target);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  browser = new Cdp(ws);
  await browser.command('Page.enable');
  await browser.command('Runtime.enable');
  return browser;
}

async function run() {
  // Resolve emitted files at runtime. A static import would make tsc include
  // dist/ as source input because this repository compiles scripts/*.mjs.
  const helpersUrl = new URL('../dist/test/helpers.js', import.meta.url);
  const authUrl = new URL('../dist/src/users/authentication.js', import.meta.url);
  const { createIntegrationTestContext } = await import(helpersUrl.href);
  const { authenticateUser } = await import(authUrl.href);
  context = await createIntegrationTestContext(authenticateUser);
  const email = context.fixtures.email();
  const password = `M3-browser-${randomBytes(12).toString('hex')}`;
  const registered = await context.fixtures.track(() => fetch(`${context.baseUrl}/api/users/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  if (registered.status !== 201) throw new Error('Browser fixture registration failed');
  const { user } = await registered.json();
  vite = spawn(process.execPath, [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--host', 'localhost', '--port', '5173', '--strictPort'], {
    cwd: clientRoot, stdio: 'ignore', env: {
      ...process.env,
      VITE_OIDC_AUTHORITY: context.baseUrl,
      VITE_OIDC_CLIENT_ID: 'app04-react-demo',
      VITE_OIDC_REDIRECT_URI: `${clientOrigin}/callback`,
      VITE_OIDC_POST_LOGOUT_REDIRECT_URI: `${clientOrigin}/`,
      VITE_OIDC_SCOPE: 'openid profile email api:read offline_access',
      VITE_API_RESOURCE: `${context.baseUrl}/api`,
    },
  });
  await waitUntil(async () => (await fetch(clientOrigin)).status === 200, 'React Vite server');
  const tab = await startBrowser();
  await tab.command('Page.navigate', { url: clientOrigin });
  await waitUntil(() => tab.evaluate("document.body?.innerText.includes('Login')"), 'React login button');
  await tab.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Login')?.click()");
  await waitUntil(() => tab.evaluate("Boolean(document.querySelector('input[name=email]'))"), 'Provider login form');
  await tab.evaluate(`document.querySelector('input[name=email]').value = ${JSON.stringify(email)}; document.querySelector('input[name=password]').value = ${JSON.stringify(password)}; document.querySelector('form').requestSubmit()`);
  const demoCode = await waitUntil(() => tab.evaluate("document.querySelector('aside code')?.textContent"), 'mock MFA challenge');
  const prematureCode = await tab.evaluate("new URL(location.href).searchParams.has('code')");
  if (prematureCode) throw new Error('Password bypassed MFA');
  await tab.evaluate(`document.querySelector('input[name=code]').value = ${JSON.stringify(demoCode)}; document.querySelector('form').requestSubmit()`);
  await waitUntil(() => tab.evaluate("Boolean(document.querySelector('button[name=allow][value=yes]'))"), 'Provider consent');
  await tab.evaluate("document.querySelector('button[name=allow][value=yes]').click()");
  const profileSub = await waitUntil(() => tab.evaluate("document.querySelector('[data-testid=api-sub]')?.textContent"), 'protected API profile', 45000);
  if (profileSub !== user.id) throw new Error('Browser profile subject mismatch');
  const accessToken = await tab.evaluate(`(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith('oidc.user:')) continue;
      try { const value = JSON.parse(sessionStorage.getItem(key)); if (value.access_token) return value.access_token; } catch {}
    }
    return null;
  })()`);
  if (!accessToken) throw new Error('Browser did not retain the API Access Token');
  await tab.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Logout')?.click()");
  await waitUntil(() => tab.evaluate("Boolean(document.getElementById('op.logoutForm')) || document.body?.innerText.includes('You are logged out')"), 'Provider logout confirmation');
  const confirmation = await tab.evaluate("Boolean(document.getElementById('op.logoutForm'))");
  if (confirmation) await tab.evaluate("document.querySelector('button[name=logout][value=yes]').click()");
  await waitUntil(() => tab.evaluate("document.body?.innerText.includes('You are logged out')"), 'React logout return', 45000);
  const protectedDataRemains = await tab.evaluate("Boolean(document.querySelector('[data-testid=api-sub]'))");
  if (protectedDataRemains) throw new Error('Protected data remained after logout');
  const afterRevoke = await fetch(`${context.baseUrl}/api/protected/profile`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (afterRevoke.status !== 401) throw new Error('Revoked browser Access Token still accessed API');
  console.log('M3 browser E2E PASS: password→MFA→consent→callback→profile→revoke→RP logout; same AT 401.');
}

try { await run(); }
finally {
  browser?.close();
  chrome?.kill('SIGTERM');
  vite?.kill('SIGTERM');
  await context?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
