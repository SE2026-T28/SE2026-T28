import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { getPrisma, disconnectPrisma } from '../src/db/prisma.js';
test('real PKCE issuance and old-grant eligibility', { skip: process.env.VT113_ISOLATED_TEST_DB !== 'confirmed' }, async (t) => {
    const db = new URL(process.env.DATABASE_URL!);
    assert.equal(db.hostname, '127.0.0.1');
    assert.equal(db.port, '55432');
    assert.equal(db.pathname, '/vt113_user_search_test');
    const allowed: string[] = [];
    const server = createServer().listen(0);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    const issuer = "http://localhost:" + port, clientId = 'app04-react-demo', redirect = 'http://localhost:5173/callback';
    const config = { port, issuer, clientId, redirectUri: redirect, postLogoutRedirectUri: 'http://localhost:5173/', corsOrigin: 'http://localhost:5173', scopes: ['openid', 'profile', 'email'], searchAccountIds: allowed };
    server.on('request', createApp(config));
    const jar = new Map<string, string>();
    const email = `vt113-flow-${randomBytes(8).toString('hex')}@example.test`, password = randomBytes(24).toString('hex');
    let id: string | undefined;
    async function request(path: string, init: RequestInit = {}) { const r = await fetch(new URL(path, issuer), { ...init, redirect: 'manual', headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } }); for (const c of r.headers.getSetCookie()) {
        const p = c.split(';')[0], i = p.indexOf('=');
        jar.set(p.slice(0, i), p.slice(i + 1));
    } return r; }
    async function flow(scope: string, resource?: string, client = clientId, consent = true) { const verifier = randomBytes(32).toString('base64url'); let r = await request('/auth?' + new URLSearchParams({ client_id: client, response_type: 'code', redirect_uri: redirect, scope, state: 'state', nonce: randomBytes(12).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(resource ? { resource } : {}) })); for (let i = 0; i < 20; i++) {
        const loc = r.headers.get('location');
        if (!loc)
            return { error: await r.text(), status: r.status };
        const u = new URL(loc, issuer);
        if (u.origin === new URL(redirect).origin) {
            if (u.searchParams.has('error'))
                return { error: u.searchParams.get('error') };
            const code = u.searchParams.get('code');
            assert.ok(code);
            const t = await request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client, redirect_uri: redirect, code, code_verifier: verifier, ...(resource ? { resource } : {}) }) });
            return { ...await t.json(), status: t.status };
        }
        r = await request(u.href);
        if (u.pathname.startsWith('/interaction/')) {
            const html = await r.text(), csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
            assert.ok(csrf, 'login/consent form must exist');
            const login = html.includes('name="password"');
            r = await request(u.pathname + '/' + (login ? 'login' : 'consent'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(login ? { email, password, csrf } : { allow: consent ? 'yes' : 'no', csrf }) });
        }
    } throw new Error('redirect limit'); }
    try {
        const reg = await request('/api/users/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
        assert.equal(reg.status, 201);
        id = (await reg.json()).user.id;
        allowed.push(id!);
        const token = await flow('openid users:read', issuer + '/api/users');
        assert.equal(token.status, 200, JSON.stringify(token));
        assert.ok(token.access_token);
        const result = await request('/api/users/search?email=' + email, { headers: { authorization: 'Bearer ' + token.access_token } });
        assert.equal(result.status, 200);
        assert.equal((await result.json()).data[0].id, id);
        jar.clear();
        assert.ok((await flow('openid users:read', issuer + '/api/users', clientId, false)).error);
        const noScope = await flow('openid', issuer + '/api/users');
        assert.equal(noScope.status, 200);
        assert.equal((await request('/api/users/search', { headers: { authorization: 'Bearer ' + noScope.access_token } })).status, 403);
        const legacy = await flow('openid email');
        assert.equal(legacy.status, 200);
        assert.equal((await request('/me', { headers: { authorization: 'Bearer ' + legacy.access_token } })).status, 200);
        assert.notEqual((await request('/api/users/search', { headers: { authorization: 'Bearer ' + legacy.access_token } })).status, 200);
        assert.ok((await flow('openid users:read', 'http://wrong.example/api')).error);
        assert.ok((await flow('openid users:read', issuer + '/api/users', 'unknown-client')).error);
        allowed.length = 0;
        const old = await flow('openid users:read', issuer + '/api/users');
        assert.ok(old.error);
        assert.equal(old.access_token, undefined);
        assert.equal((await request('/api/users/search', { headers: { authorization: 'Bearer ' + token.access_token } })).status, 403);
        allowed.push(id!);
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 360000 });
        assert.equal((await request('/api/users/search', { headers: { authorization: 'Bearer ' + token.access_token } })).status, 401);
        t.mock.timers.reset();
        allowed.length = 0;
        jar.clear();
        const denied = await flow('openid users:read', issuer + '/api/users');
        assert.ok(denied.error);
        assert.equal(denied.access_token, undefined);
    }
    finally {
        t.mock.timers.reset();
        server.close();
        await once(server, 'close');
        try {
            if (id)
                await getPrisma().user.delete({ where: { id } });
        }
        finally {
            await disconnectPrisma();
        }
    }
});
