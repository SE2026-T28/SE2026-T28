import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const config = readConfig({
  NODE_ENV: "test", PORT: "3000", OIDC_ISSUER: "http://localhost:3000",
  OIDC_CLIENT_ID: "app04-react-demo", OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/", OIDC_SCOPES: "openid profile email",
  OIDC_CORS_ORIGIN: "http://localhost:5173",
});

async function serve(run: (issuer: string) => Promise<void>, authenticateUser?: Parameters<typeof createApp>[1]) {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  const issuer = `http://localhost:${port}`;
  const server = createApp({ ...config, issuer }, authenticateUser).listen(port);
  try { await once(server, "listening"); await run(issuer); }
  finally { server.close(); await once(server, "close"); }
}

function authUrl(issuer: string, overrides: Record<string, string | null> = {}) {
  const url = new URL(`${issuer}/auth`);
  const params = {
    client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri,
    scope: "openid email", state: "test-state", nonce: "test-nonce",
    code_challenge: "a".repeat(43), code_challenge_method: "S256",
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return url;
}

test("valid S256 request reaches login interaction; unavailable auth cannot create a session", async () => {
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    assert.equal(start.status, 303);
    const location = start.headers.get("location")!;
    assert.match(location, /^\/interaction\/[\w-]+$/);
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const form = await fetch(new URL(location, issuer), { headers: { cookie } });
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /action="\/interaction\/[^\"]+\/login"/);
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const postUrl = new URL(`${location}/login`, issuer);
    const rejected = await fetch(postUrl, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.com", password: "test-password", csrf: "wrong" }), redirect: "manual" });
    assert.equal(rejected.status, 403);
    const missing = await fetch(postUrl, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.com", password: "test-password" }), redirect: "manual" });
    assert.equal(missing.status, 403);
    const unavailable = await fetch(postUrl, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.com", password: "test-password", csrf }), redirect: "manual" });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("location"), null);
  });
});

test("missing PKCE, plain PKCE and wrong redirect URI are rejected", async () => {
  await serve(async issuer => {
    const cases: Record<string, string | null>[] = [
      { code_challenge: null, code_challenge_method: null },
      { code_challenge_method: "plain" },
      { redirect_uri: "http://localhost:5173/other" },
    ];
    for (const overrides of cases) {
      const result = await fetch(authUrl(issuer, overrides), { redirect: "manual" });
      assert.notEqual(result.headers.get("location")?.startsWith("/interaction/"), true);
      assert.notEqual(result.status, 200);
    }
  });
});

test("failed login attempts are limited for an interaction even after form reload", async () => {
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const form = await fetch(new URL(location, issuer), { headers: { cookie } });
    const csrf = (await form.text()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = () => fetch(new URL(`${location}/login`, issuer), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.test", password: "wrong-password", csrf }), redirect: "manual" });
    for (let i = 0; i < 5; i++) assert.equal((await submit()).status, 401);
    assert.equal((await fetch(new URL(location, issuer), { headers: { cookie } })).status, 200);
    assert.equal((await submit()).status, 429);
    const restart = await fetch(authUrl(issuer), { redirect: "manual" });
    const anotherLocation = restart.headers.get("location")!;
    const anotherCookie = restart.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const anotherForm = await fetch(new URL(anotherLocation, issuer), { headers: { cookie: anotherCookie } });
    const anotherCsrf = (await anotherForm.text()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(anotherCsrf);
    const acrossInteraction = await fetch(new URL(`${anotherLocation}/login`, issuer), { method: "POST", headers: { cookie: anotherCookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.test", password: "wrong-password", csrf: anotherCsrf }), redirect: "manual" });
    assert.equal(acrossInteraction.status, 429);
  }, async () => null);
});

test("CSRF token from one interaction cannot be submitted with another browser cookie", async () => {
  let authentications = 0;
  await serve(async issuer => {
    const startA = await fetch(authUrl(issuer, { state: "browser-a" }), { redirect: "manual" });
    const uidA = startA.headers.get("location")!;
    const cookieA = startA.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const htmlA = await (await fetch(new URL(uidA, issuer), { headers: { cookie: cookieA } })).text();
    const csrfA = htmlA.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrfA);

    const startB = await fetch(authUrl(issuer, { state: "browser-b" }), { redirect: "manual" });
    const cookieB = startB.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const response = await fetch(new URL(`${uidA}/login`, issuer), {
      method: "POST", redirect: "manual",
      headers: { cookie: cookieB, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf: csrfA }),
    });
    assert.equal(response.status, 403);
    assert.equal(authentications, 0);
  }, async () => { authentications++; return { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" }; });
});

test("expired CSRF form token is rejected before password verification", async () => {
  let authentications = 0;
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const originalNow = Date.now();
    const clock = mock.method(Date, "now", () => originalNow + 10 * 60 * 1000 + 1);
    try {
      const response = await fetch(new URL(`${location}/login`, issuer), {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf }),
      });
      assert.equal(response.status, 403);
      assert.equal(authentications, 0);
    } finally { clock.mock.restore(); }
  }, async () => { authentications++; return null; });
});

test("completed login interaction rejects replay of its CSRF token", async () => {
  let authentications = 0;
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = () => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf }),
    });
    assert.equal((await submit()).status, 303);
    assert.notEqual((await submit()).status, 303);
    assert.equal(authentications, 1);
  }, async () => { authentications++; return { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" }; });
});

test("simultaneous login submissions claim one interaction and allow retry after bad credentials", async () => {
  let authenticateCalls = 0;
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = () => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "wrong-password", csrf }),
    });

    const first = submit();
    await entered;
    const concurrent = await submit();
    releaseFirst();
    const firstResponse = await first;
    assert.equal(concurrent.status, 409);
    assert.equal(firstResponse.status, 401);
    assert.equal(authenticateCalls, 1);
    assert.equal((await submit()).status, 401);
    assert.equal(authenticateCalls, 2);
  }, async () => {
    authenticateCalls++;
    if (authenticateCalls === 1) { firstEntered(); await firstPending; }
    return null;
  });
});

test("simultaneous successful login submissions finish an interaction at most once", async () => {
  let authenticateCalls = 0;
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = () => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf }),
    });
    const first = submit();
    await entered;
    const concurrent = await submit();
    releaseFirst();
    assert.equal(concurrent.status, 409);
    assert.equal((await first).status, 303);
    assert.equal(authenticateCalls, 1);
    assert.notEqual((await submit()).status, 303);
    assert.equal(authenticateCalls, 1);
  }, async () => {
    authenticateCalls++;
    firstEntered();
    await firstPending;
    return { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" };
  });
});

test("authentication backend error releases the interaction for a later retry", async () => {
  let authenticateCalls = 0;
  await serve(async issuer => {
    const start = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = start.headers.get("location")!;
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = () => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf }),
    });
    assert.equal((await submit()).status, 500);
    assert.equal((await submit()).status, 401);
    assert.equal(authenticateCalls, 2);
  }, async () => {
    authenticateCalls++;
    if (authenticateCalls === 1) throw new Error("injected authentication failure");
    return null;
  });
});

test("concurrent interactions reserve the email limit before authentication completes", async () => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fifthEntered = new Promise<void>(resolve => { entered = resolve; });
  await serve(async issuer => {
    const submissions: Array<() => Promise<Response>> = [];
    for (let i = 0; i < 6; i++) {
      const start = await fetch(authUrl(issuer, { state: `reservation-${i}` }), { redirect: "manual" });
      const location = start.headers.get("location")!;
      const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
      const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      submissions.push(() => fetch(new URL(`${location}/login`, issuer), {
        method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "same@example.test", password: "wrong-password", csrf }),
      }));
    }
    const firstFive = submissions.slice(0, 5).map(submit => submit());
    await fifthEntered;
    const blocked = await submissions[5]();
    assert.equal(blocked.status, 429);
    assert.equal(calls, 5);
    release();
    for (const response of await Promise.all(firstFive)) assert.equal(response.status, 401);
  }, async () => { calls++; if (calls === 5) entered(); await gate; return null; });
});

test("expired in-flight claim cannot finish interaction or consume replacement form", async () => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await serve(async issuer => {
    const begin = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = begin.headers.get("location")!;
    const cookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const submit = (token: string) => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf: token }),
    });
    const old = submit(csrf);
    await started;
    const now = Date.now();
    const clock = mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1);
    try {
      const replacement = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
      const newCsrf = replacement.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(newCsrf);
      assert.notEqual(newCsrf, csrf);
      let timeout!: ReturnType<typeof setTimeout>;
      const competing = await Promise.race([
        submit(newCsrf),
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 2000); }),
      ]);
      clearTimeout(timeout);
      assert.equal(competing?.status, 409);
      assert.equal(calls, 1);
      release();
      assert.equal((await old).status, 403);
      assert.equal((await submit(newCsrf)).status, 303);
      assert.equal(calls, 2);
    } finally { clock.mock.restore(); release(); }
  }, async () => { calls++; entered(); await gate; return { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" }; });
});

test("expired failed login still counts against email and IP limits", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  await serve(async issuer => {
    const openForm = async (state: string) => {
      const begin = await fetch(authUrl(issuer, { state }), { redirect: "manual" });
      const location = begin.headers.get("location")!;
      const cookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
      const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      return { location, cookie, csrf };
    };
    const submit = ({ location, cookie, csrf }: Awaited<ReturnType<typeof openForm>>) => fetch(new URL(`${location}/login`, issuer), {
      method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "expired-failure@example.test", password: "wrong-password", csrf }),
    });
    for (let i = 0; i < 4; i++) assert.equal((await submit(await openForm(`prior-${i}`))).status, 401);
    const fifth = await openForm("expires-during-auth");
    const pending = submit(fifth);
    await started;
    const now = Date.now();
    const clock = mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1);
    try {
      const replacement = await (await fetch(new URL(fifth.location, issuer), { headers: { cookie: fifth.cookie } })).text();
      assert.match(replacement, /name="csrf" value="[a-f0-9]+"/);
      release();
      assert.equal((await pending).status, 403);
      assert.equal((await submit(await openForm("after-expired-failure"))).status, 429);
      assert.equal(calls, 5);
    } finally { clock.mock.restore(); release(); }
  }, async () => { calls++; if (calls === 5) { entered(); await gate; } return null; });
});

test("IP limit counts concurrent attempts with different email addresses", async () => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const twentiethEntered = new Promise<void>(resolve => { entered = resolve; });
  await serve(async issuer => {
    const submissions: Array<() => Promise<Response>> = [];
    for (let i = 0; i < 21; i++) {
      const begin = await fetch(authUrl(issuer, { state: `ip-${i}` }), { redirect: "manual" });
      const location = begin.headers.get("location")!;
      const cookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
      const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      submissions.push(() => fetch(new URL(`${location}/login`, issuer), {
        method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: `different-${i}@example.test`, password: "wrong-password", csrf }),
      }));
    }
    const pending = submissions.slice(0, 20).map(submit => submit());
    await twentiethEntered;
    assert.equal((await submissions[20]()).status, 429);
    assert.equal(calls, 20);
    const now = Date.now();
    const clock = mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1);
    try {
      release();
      for (const response of await Promise.all(pending)) assert.equal(response.status, 403);
      const begin = await fetch(authUrl(issuer, { state: "ip-after-expired-failures" }), { redirect: "manual" });
      const location = begin.headers.get("location")!;
      const cookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const html = await (await fetch(new URL(location, issuer), { headers: { cookie } })).text();
      const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      const blockedAfterCompletion = await fetch(new URL(`${location}/login`, issuer), {
        method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "another-address@example.test", password: "wrong-password", csrf }),
      });
      assert.equal(blockedAfterCompletion.status, 429);
      assert.equal(calls, 20);
    } finally { clock.mock.restore(); release(); }
  }, async () => { calls++; if (calls === 20) entered(); await gate; return null; });
});

test("Unicode CSRF values are rejected without reaching Authentication", async () => {
  let calls = 0;
  await serve(async issuer => {
    const begin = await fetch(authUrl(issuer), { redirect: "manual" });
    const location = begin.headers.get("location")!;
    const cookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await fetch(new URL(location, issuer), { headers: { cookie } });
    for (const token of ["é".repeat(64), "😀".repeat(32)]) {
      const response = await fetch(new URL(`${location}/login`, issuer), {
        method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "a@example.test", password: "correct-password", csrf: token }),
      });
      assert.equal(response.status, 403);
    }
    assert.equal(calls, 0);
  }, async () => { calls++; return null; });
});
