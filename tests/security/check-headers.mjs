// Explicit URL required; do not accidentally test an unrelated local service.
const target = process.argv[2];
if (!target) throw new Error('Usage: node tests/security/check-headers.mjs <server-url>');
const url = new URL(target);
const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
if (response.status >= 400) throw new Error(`Unexpected HTTP status ${response.status}`);
const required = {
  'content-security-policy': /default-src\s+'self'/,
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /^no-referrer$/i,
};
if (url.protocol === 'https:') required['strict-transport-security'] = /max-age=[1-9][0-9]*/i;
for (const [name, pattern] of Object.entries(required)) {
  if (!pattern.test(response.headers.get(name) ?? '')) throw new Error(`Missing/incorrect header: ${name}`);
}
if (response.headers.has('x-powered-by')) throw new Error('x-powered-by must be disabled');
console.log('Header checks passed. This does not validate full CSP compatibility or browser flows.');
