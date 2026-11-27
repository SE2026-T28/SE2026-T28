import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIntegrationTestContext } from "./helpers.js";
import { authenticateUser } from "../src/users/authentication.js";
import { getPrisma } from "../src/db/prisma.js";

test("M3 password login requires a bound, one-time MFA challenge before Provider issues a code", async () => {
  const previous = {
    enabled: process.env.MFA_MOCK_ENABLED,
    demo: process.env.MFA_DEMO_CODE_ENABLED,
    pepper: process.env.MFA_CODE_PEPPER,
  };
  process.env.MFA_MOCK_ENABLED = "true";
  process.env.MFA_DEMO_CODE_ENABLED = "true";
  process.env.MFA_CODE_PEPPER = randomBytes(32).toString("hex");
  let context: Awaited<ReturnType<typeof createIntegrationTestContext>> | undefined;
  try {
    context = await createIntegrationTestContext(authenticateUser);
    const issuer = context.baseUrl;
    const email = context.fixtures.email();
    const password = "m3-mfa-provider-fixture";
    const registered = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }));
    assert.equal(registered.status, 201);
    const registeredUser = await registered.json() as { user: { id: string } };
    const jar = new Map<string, string>();
    const request = async (url: URL | string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await fetch(url, { ...init, headers, redirect: "manual" });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const separator = pair!.indexOf("=");
        if (separator > 0) jar.set(pair!.slice(0, separator), pair!.slice(separator + 1));
      }
      return response;
    };
    const post = (path: string, fields: Record<string, string>) => request(new URL(path, issuer), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    const verifier = randomBytes(32).toString("base64url");
    const auth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({
      client_id: "app04-react-demo", response_type: "code", redirect_uri: "http://localhost:5173/callback",
      scope: "openid email", state: "m3-mfa-state", nonce: "m3-mfa-nonce", prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })) auth.searchParams.set(key, value);
    const start = await request(auth);
    assert.equal(start.status, 303);
    const loginPath = start.headers.get("location");
    if (!loginPath?.startsWith("/interaction/")) throw new Error("Expected login interaction path");
    const login = await request(new URL(loginPath, issuer));
    const loginHtml = await login.text();
    const loginCsrf = loginHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(loginCsrf);

    const badPassword = await post(`${loginPath}/login`, { email, password: "wrong-password", csrf: loginCsrf });
    assert.equal(badPassword.status, 401);

    const passwordResult = await post(`${loginPath}/login`, { email, password, csrf: loginCsrf });
    assert.equal(passwordResult.status, 200);
    assert.equal(passwordResult.headers.get("location"), null, "Password alone must not finish the interaction");
    assert.equal(passwordResult.headers.get("cache-control"), "no-store");
    const mfaHtml = await passwordResult.text();
    const mfaCsrf = mfaHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    const demoCode = mfaHtml.match(/MOCK — LOCAL\/TEST ONLY:<\/strong> <code>(\d{6})<\/code>/)?.[1];
    assert.ok(mfaCsrf && demoCode);
    assert.notEqual(mfaCsrf, loginCsrf, "MFA must rotate the password-form CSRF token");
    const reload = await request(new URL(loginPath, issuer));
    assert.equal(reload.status, 200);
    assert.match(await reload.text(), /Xác minh MFA/);

    const wrongCsrf = await post(`${loginPath}/mfa`, { csrf: loginCsrf, code: demoCode });
    assert.equal(wrongCsrf.status, 403);
    const wrongCode = await post(`${loginPath}/mfa`, { csrf: mfaCsrf, code: demoCode === "000000" ? "111111" : "000000" });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.headers.get("location"), null);
    const verified = await post(`${loginPath}/mfa`, { csrf: mfaCsrf, code: demoCode });
    assert.equal(verified.status, 303);
    await context.drainAudit();
    const loginAudit = await getPrisma().auditEvent.findMany({ where: {
      actorId: registeredUser.user.id, eventType: "login.success",
    } });
    assert.equal(loginAudit.length, 1, "Only completed Provider handoff can create login.success");
    const correlationId = loginAudit[0]!.correlationId;
    assert.ok(correlationId);
    const interactionAudit = await getPrisma().auditEvent.findMany({ where: { correlationId } });
    assert.deepEqual(interactionAudit.map(row => row.eventType).sort(),
      ["login.failure", "login.success", "mfa.failure", "mfa.success"].sort());
    assert.ok(interactionAudit.every(row => row.clientId === "app04-react-demo"));
    assert.ok(interactionAudit.filter(row => row.eventType.startsWith("mfa.")).every(row => row.actorId === registeredUser.user.id));
    assert.ok(!JSON.stringify(interactionAudit.map(row => row.metadata)).includes(password));
    assert.ok(!JSON.stringify(interactionAudit.map(row => row.metadata)).includes(demoCode));
    await getPrisma().auditEvent.deleteMany({ where: { correlationId } });
    let destination = new URL(verified.headers.get("location")!, issuer);
    for (let step = 0; step < 10 && destination.origin === issuer; step++) {
      if (destination.pathname.startsWith("/interaction/")) {
        const form = await request(destination);
        const html = await form.text();
        assert.match(html, /Cấp quyền/);
        const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
        assert.ok(csrf);
        const next = await post(`${destination.pathname}/consent`, { allow: "yes", csrf });
        assert.equal(next.status, 303);
        destination = new URL(next.headers.get("location")!, issuer);
      } else {
        const next = await request(destination);
        assert.equal(next.status, 303);
        destination = new URL(next.headers.get("location")!, issuer);
      }
    }
    assert.equal(destination.origin, "http://localhost:5173");
    assert.equal(destination.searchParams.get("state"), "m3-mfa-state");
    const code = destination.searchParams.get("code");
    assert.ok(code);
    const exchanged = await fetch(`${issuer}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "app04-react-demo",
        redirect_uri: "http://localhost:5173/callback", code, code_verifier: verifier }),
    });
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json() as Record<string, unknown>;
    assert.ok(typeof tokens.access_token === "string" && typeof tokens.id_token === "string");
    const replay = await post(`${loginPath}/mfa`, { csrf: mfaCsrf, code: demoCode });
    assert.notEqual(replay.status, 303, "Consumed MFA must not complete Provider twice");

    // A new browser verifies MFA, but Provider completion fails. The challenge
    // stays consumed and no login.success may be persisted for this attempt.
    jar.clear();
    const failedStart = await request(new URL(auth));
    assert.equal(failedStart.status, 303);
    const failedPath = failedStart.headers.get("location");
    if (!failedPath?.startsWith("/interaction/")) throw new Error("Expected a fresh login interaction");
    const failedLoginHtml = await (await request(new URL(failedPath, issuer))).text();
    const failedLoginCsrf = failedLoginHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(failedLoginCsrf);
    const failedPassword = await post(`${failedPath}/login`, { email, password, csrf: failedLoginCsrf });
    assert.equal(failedPassword.status, 200);
    const failedMfaHtml = await failedPassword.text();
    const failedMfaCsrf = failedMfaHtml.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    const failedCode = failedMfaHtml.match(/MOCK — LOCAL\/TEST ONLY:<\/strong> <code>(\d{6})<\/code>/)?.[1];
    assert.ok(failedMfaCsrf && failedCode);
    const provider = context.getProvider();
    const originalFinish = provider.interactionFinished;
    try {
      provider.interactionFinished = async () => { throw new Error("test-only Provider completion failure"); };
      const failedHandoff = await post(`${failedPath}/mfa`, { csrf: failedMfaCsrf, code: failedCode });
      assert.equal(failedHandoff.status, 503);
    } finally {
      provider.interactionFinished = originalFinish;
    }
    await context.drainAudit();
    const failedMfaAudit = await getPrisma().auditEvent.findMany({ where: {
      actorId: registeredUser.user.id, eventType: "mfa.success",
    } });
    assert.equal(failedMfaAudit.length, 1);
    const failedCorrelation = failedMfaAudit[0]!.correlationId;
    assert.ok(failedCorrelation);
    assert.equal(await getPrisma().auditEvent.count({ where: {
      correlationId: failedCorrelation, eventType: "login.success",
    } }), 0);
    await getPrisma().auditEvent.deleteMany({ where: { correlationId: failedCorrelation } });
  } finally {
    await context?.close();
    for (const [name, value] of Object.entries({ MFA_MOCK_ENABLED: previous.enabled,
      MFA_DEMO_CODE_ENABLED: previous.demo, MFA_CODE_PEPPER: previous.pepper })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
