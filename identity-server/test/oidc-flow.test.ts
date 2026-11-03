import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrisma } from "../src/db/prisma.js";

test("registered account completes login, consent and one-use S256 code", { skip: !process.env.DATABASE_URL }, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  assert.match(decodeURIComponent(new URL(databaseUrl).pathname), /(?:^|_)test$/i);
  const prisma = getPrisma();
  const email = `o2-test-${randomBytes(6).toString("hex")}@example.test`;
  const user = await prisma.user.create({ data: { email, passwordHash: "test-only-not-an-actual-hash" } });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close(); await once(probe, "close");
  const issuer = `http://localhost:${port}`;
  const redirectUri = "http://localhost:5173/callback";
  const clientId = "app04-react-demo";
  const server = createApp({ port, issuer, clientId, redirectUri, postLogoutRedirectUri: "http://localhost:5173/", scopes: ["openid", "profile", "email"], corsOrigin: "http://localhost:5173" }, async (inputEmail, password) => inputEmail === email && password === "correct-test-password" ? { id: user.id, email } : null).listen(port);
  const jar = new Map<string, string>();
  const request = async (url: string | URL, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, redirect: "manual", headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      const index = pair.indexOf("=");
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  try {
    await once(server, "listening");
    const auth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: "openid email", state: "flow-state", nonce: "flow-nonce", code_challenge: challenge, code_challenge_method: "S256" })) auth.searchParams.set(key, value);
    let response = await request(auth);
    let location = response.headers.get("location")!;
    assert.match(location, /^\/interaction\//);

    let html = await (await request(new URL(location, issuer))).text();
    let csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const post = async (path: string, fields: Record<string, string>) => request(new URL(path, issuer), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    const wrong = await post(`${location}/login`, { email, password: "wrong", csrf });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("location"), null);
    response = await post(`${location}/login`, { email, password: "correct-test-password", csrf });
    assert.equal(response.status, 303);
    location = response.headers.get("location")!;
    response = await request(new URL(location, issuer));
    location = response.headers.get("location")!;
    if (location.startsWith("/interaction/")) {
      html = await (await request(new URL(location, issuer))).text();
      assert.match(html, /Cấp quyền/);
      csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      assert.ok(csrf);
      response = await post(`${location}/consent`, { allow: "yes", csrf });
      assert.equal(response.status, 303);
      response = await request(new URL(response.headers.get("location")!, issuer));
      location = response.headers.get("location")!;
    }
    const callback = new URL(location, issuer);
    assert.equal(callback.origin, "http://localhost:5173");
    assert.equal(callback.searchParams.get("state"), "flow-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const token = (authorizationCode: string, codeVerifier: string) => fetch(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:5173" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: authorizationCode, redirect_uri: redirectUri, code_verifier: codeVerifier }) });
    const first = await token(code, verifier);
    assert.equal(first.status, 200);
    const payload = await first.json() as { id_token: string; access_token: string };
    const claims = JSON.parse(Buffer.from(payload.id_token.split(".")[1], "base64url").toString()) as Record<string, unknown>;
    assert.equal(claims.sub, user.id);
    assert.notEqual(claims.email_verified, true);
    const userInfo = await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${payload.access_token}` } });
    assert.equal(userInfo.status, 200);
    const info = await userInfo.json() as Record<string, unknown>;
    assert.equal(info.sub, user.id);
    assert.equal(info.email, email);
    const replay = await token(code, verifier);
    assert.notEqual(replay.status, 200);

    // Existing session and grant may skip prompts, but still issue a fresh code
    // bound to the new S256 challenge.
    const secondAuth = await request(auth);
    let secondLocation = new URL(secondAuth.headers.get("location")!, issuer);
    for (let i = 0; i < 10 && secondLocation.origin === issuer; i++) {
      let continuation;
      if (secondLocation.pathname.startsWith("/interaction/")) {
        const formHtml = await (await request(secondLocation)).text();
        const formCsrf = formHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
        assert.ok(formCsrf);
        continuation = formHtml.includes("name=\"password\"")
          ? await post(`${secondLocation.pathname}/login`, { email, password: "correct-test-password", csrf: formCsrf })
          : await post(`${secondLocation.pathname}/consent`, { allow: "yes", csrf: formCsrf });
      } else {
        continuation = await request(secondLocation);
      }
      secondLocation = new URL(continuation.headers.get("location")!, issuer);
    }
    assert.equal(secondLocation.origin, "http://localhost:5173", secondLocation.pathname);
    const secondCode = secondLocation.searchParams.get("code");
    assert.ok(secondCode);
    const wrongVerifier = await token(secondCode, "x".repeat(43));
    assert.notEqual(wrongVerifier.status, 200);
  } finally {
    server.close(); await once(server, "close");
    await prisma.user.delete({ where: { id: user.id } });
    await disconnectPrisma();
  }
});
