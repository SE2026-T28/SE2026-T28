import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
test('search HTTP uses real provider tokens and fails closed', async () => {
    let calls = 0;
    let fail = false;
    const repository = { count: async () => { calls++; if (fail)
            throw new Error('SECRET SQL'); return 1; }, findMany: async () => [{ id: 'id', email: 'a@example.test', createdAt: new Date('2026-01-01'), passwordHash: 'SECRET' }] };
    const config = { port: 3000, issuer: 'http://localhost:3000', clientId: 'app04-react-demo', redirectUri: 'http://localhost:5173/callback', postLogoutRedirectUri: 'http://localhost:5173/', searchAccountIds: ['fixture-account'], scopes: ['openid', 'profile', 'email'], corsOrigin: 'http://localhost:5173' };
    // Repository injection only; authentication always uses the application's provider.
    const app = createApp(config, { searchRepository: repository });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/users/search`;
    const request = (token?: string, query = '') => fetch(url + query, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    try {
        assert.equal((await request()).status, 401);
        assert.equal((await request('invalid')).status, 401);
        const provider = app.locals.oidcProvider;
        const client = await provider.Client.find(config.clientId);
        const issue = async (scope: string, extra: Record<string, unknown> = {}) => new provider.AccessToken({ client, accountId: 'fixture-account', grantId: 'fixture-grant', gty: 'authorization_code', scope, aud: `${config.issuer}/api/users`, ...extra }).save();
        const expired = await issue('users:read', { exp: Math.floor(Date.now() / 1000) - 120 });
        assert.equal((await request(expired)).status, 401);
        const missing = await issue('openid');
        assert.equal((await request(missing)).status, 403, 'TC-12: insufficient scope must not access search');
        assert.equal((await request(missing, '?page=0')).status, 403);
        await assert.rejects(issue('users:read', { aud: 'http://other.test/api' }));
        const idToken = await new provider.IdToken({ sub: 'fixture-account' }, { client }).issue({ use: 'idtoken' });
        assert.equal((await request(idToken)).status, 401);
        await assert.rejects(issue('users:read', { client: new provider.Client({ client_id: 'other-client', token_endpoint_auth_method: 'none', redirect_uris: [config.redirectUri], response_types: ['code'], grant_types: ['authorization_code'] }) }));
        assert.equal((await request(await issue('users:read', { jkt: 'proof-required' }))).status, 401);
        assert.equal((await request(await issue('users:read:all'))).status, 403);
        assert.equal(calls, 0);
        const valid = await issue('users:read');
        assert.equal((await request(valid, '?page=0')).status, 400);
        assert.equal((await request(valid, '?limit=1&limit=2')).status, 400);
        assert.equal((await request(valid, '?unknown=1')).status, 400);
        assert.equal(calls, 0);
        const response = await request(valid);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.pagination, { page: 1, limit: 10, total: 1, totalPages: 1 });
        assert.deepEqual(Object.keys(body.data[0]).sort(), ['createdAt', 'email', 'id']);
        fail = true;
        const failure = await request(valid);
        assert.equal(failure.status, 500);
        assert.equal((await failure.text()).includes('SECRET'), false);
    }
    finally {
        server.close();
        await once(server, 'close');
    }
});
