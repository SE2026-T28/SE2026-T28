import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIntegrationTestContext } from "./helpers.js";
import { authenticateUser } from "../src/users/authentication.js";
import { getPrisma } from "../src/db/prisma.js";

test("M3: API resource, rotated refresh, revocation and RP logout", async () => {
  const context = await createIntegrationTestContext(authenticateUser);
  try {
    const issuer = context.baseUrl;
    const resource = `${issuer}/api`;
    const email = context.fixtures.email();
    const password = "correct-test-password";
    const registered = await context.fixtures.track(() => fetch(`${issuer}/api/users/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }));
    assert.equal(registered.status, 201);
    const registeredUser = await registered.json() as { user: { id: string } };
    const jar = new Map<string, string>();
    const request = async (url: string | URL, init: RequestInit = {}) => {
      const response = await fetch(url, {
        ...init, redirect: "manual",
        headers: { ...init.headers, connection: "close", cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") },
      });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0];
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    const formPost = (path: string, fields: Record<string, string>) => request(new URL(path, issuer), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: new URLSearchParams(fields),
    });
    const auth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({
      client_id: "app04-react-demo", response_type: "code", redirect_uri: "http://localhost:5173/callback",
      scope: "openid profile email api:read offline_access", resource, prompt: "consent",
      code_challenge_method: "S256",
    })) auth.searchParams.set(key, value);
    const token = (fields: Record<string, string>) => fetch(`${issuer}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: new URLSearchParams(fields),
    });
    const tokenRevoke = (value: string, hint: "access_token" | "refresh_token") => fetch(`${issuer}/token/revocation`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: new URLSearchParams({ client_id: "app04-react-demo", token: value, token_type_hint: hint }),
    });
    type TokenSet = { access_token: string; refresh_token: string; id_token: string; expires_in: number };
    const issueTokens = async (state: string, apiResource = true): Promise<TokenSet> => {
      const verifier = randomBytes(32).toString("base64url");
      const authorization = new URL(auth);
      if (!apiResource) {
        authorization.searchParams.set("scope", "openid email");
        authorization.searchParams.delete("resource");
        authorization.searchParams.delete("prompt");
      }
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("nonce", randomBytes(16).toString("base64url"));
      authorization.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      let response = await request(authorization);
      let callback: URL | undefined;
      for (let step = 0; step < 12; step++) {
        assert.equal(response.status, 303);
        const next = new URL(response.headers.get("location")!, issuer);
        if (next.origin !== issuer) { callback = next; break; }
        if (next.pathname.startsWith("/interaction/")) {
          const html = await (await request(next)).text();
          const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
          assert.ok(csrf);
          response = html.includes('name="password"')
            ? await formPost(`${next.pathname}/login`, { email, password, csrf })
            : await formPost(`${next.pathname}/consent`, { allow: "yes", csrf });
        } else response = await request(next);
      }
      assert.ok(callback);
      assert.equal(callback.searchParams.get("state"), state);
      const code = callback.searchParams.get("code");
      assert.ok(code);
      const fields = { grant_type: "authorization_code", client_id: "app04-react-demo", code,
        redirect_uri: "http://localhost:5173/callback", code_verifier: verifier };
      const issued = await token(apiResource ? { ...fields, resource } : fields);
      assert.equal(issued.status, 200);
      return await issued.json() as TokenSet;
    };
    const firstTokens = await issueTokens("m3-state");
    assert.ok(firstTokens.access_token && firstTokens.refresh_token && firstTokens.id_token);
    assert.equal(firstTokens.expires_in, 300);
    assert.ok(!firstTokens.access_token.includes("."), "API token must be opaque, not a JWT");
    const apiToken = await context.getProvider().AccessToken.find(firstTokens.access_token);
    assert.ok(apiToken);
    assert.equal(apiToken.aud, resource);
    assert.ok(apiToken.scope?.split(" ").includes("api:read"));
    assert.equal(apiToken.clientId, "app04-react-demo");
    await context.drainAudit();
    const issuance = await getPrisma().auditEvent.findFirst({ where: {
      actorId: registeredUser.user.id, eventType: "token.issued", outcome: "success",
    } });
    assert.ok(issuance, "A completed token grant must produce a redacted audit event");
    assert.ok(issuance.correlationId);
    assert.ok(!JSON.stringify(issuance.metadata).includes(firstTokens.access_token));
    const profile = (bearer: string) => fetch(`${issuer}/api/protected/profile`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const validProfile = await profile(firstTokens.access_token);
    assert.equal(validProfile.status, 200);
    assert.deepEqual(await validProfile.json(), { sub: apiToken.accountId });
    const idTokenAsBearer = await profile(firstTokens.id_token);
    assert.equal(idTokenAsBearer.status, 401);
    const badAuthorization = new URL(auth);
    badAuthorization.searchParams.set("resource", `${issuer}/other`);
    badAuthorization.searchParams.set("state", "m3-invalid-target-state");
    badAuthorization.searchParams.set("nonce", randomBytes(16).toString("base64url"));
    badAuthorization.searchParams.set("code_challenge", createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"));
    const rejectedAuthorization = await request(badAuthorization);
    assert.equal(rejectedAuthorization.status, 303);
    const rejectedTarget = new URL(rejectedAuthorization.headers.get("location")!, issuer);
    assert.equal(rejectedTarget.searchParams.get("error"), "invalid_target");
    const noResource = await issueTokens("m3-userinfo-state", false);
    const userinfoToken = await context.getProvider().AccessToken.find(noResource.access_token);
    assert.ok(userinfoToken);
    assert.notEqual(userinfoToken.aud, resource, "M2 request without resource must not receive an API token");
    assert.ok(!userinfoToken.scope?.split(" ").includes("api:read"));
    assert.equal((await profile(noResource.access_token)).status, 401);
    const invalidResourceGrant = await issueTokens("m3-invalid-resource-state");
    const invalidResource = await token({ grant_type: "refresh_token", client_id: "app04-react-demo",
      refresh_token: invalidResourceGrant.refresh_token, resource: `${issuer}/other` });
    assert.equal(invalidResource.status, 400);
    assert.equal((await invalidResource.json() as { error: string }).error, "invalid_target");
    await context.restart(); // new Provider instance, same PostgreSQL and cookie key
    const sessionAuth = new URL(auth);
    sessionAuth.searchParams.set("scope", "openid email");
    sessionAuth.searchParams.delete("resource");
    sessionAuth.searchParams.delete("prompt");
    sessionAuth.searchParams.set("state", "m3-restart-state");
    sessionAuth.searchParams.set("nonce", randomBytes(16).toString("base64url"));
    sessionAuth.searchParams.set("code_challenge", createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"));
    const resumed = await request(sessionAuth);
    assert.equal(resumed.status, 303);
    const resumedLocation = new URL(resumed.headers.get("location")!, issuer);
    if (resumedLocation.pathname.startsWith("/interaction/")) {
      const resumedForm = await (await request(resumedLocation)).text();
      assert.ok(!resumedForm.includes('name="password"'), "Session should persist across Provider restart");
    } else {
      assert.equal(resumedLocation.origin + resumedLocation.pathname, "http://localhost:5173/callback");
      assert.ok(resumedLocation.searchParams.get("code"), "Restarted session must issue a code");
    }
    const refresh = (refreshToken: string) => token({ grant_type: "refresh_token", client_id: "app04-react-demo", refresh_token: refreshToken, resource });
    const second = await refresh(firstTokens.refresh_token);
    assert.equal(second.status, 200);
    const secondTokens = await second.json() as { refresh_token: string; access_token: string; id_token?: string };
    assert.ok(secondTokens.refresh_token && secondTokens.access_token && secondTokens.id_token);
    assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);
    assert.equal((await profile(secondTokens.access_token)).status, 200);
    const scopeGrant = await issueTokens("m3-scope-state");
    const expandedScope = await token({ grant_type: "refresh_token", client_id: "app04-react-demo",
      refresh_token: scopeGrant.refresh_token, resource, scope: "openid email api:read admin" });
    assert.equal(expandedScope.status, 400);
    assert.equal((await expandedScope.json() as { error: string }).error, "invalid_scope");
    // Revoke a live grant; RFC 7009 returns 200 even for an already dead token.
    const revoke = await fetch(`${issuer}/token/revocation`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "app04-react-demo", token: secondTokens.refresh_token, token_type_hint: "refresh_token" }) });
    assert.equal(revoke.status, 200);
    const revoked = await refresh(secondTokens.refresh_token);
    assert.equal(revoked.status, 400);
    assert.equal((await revoked.json() as { error: string }).error, "invalid_grant");
    assert.equal(await context.getProvider().AccessToken.find(secondTokens.access_token), undefined);
    assert.equal((await profile(secondTokens.access_token)).status, 401);
    await context.drainAudit();
    const revocationAudit = await getPrisma().auditEvent.findFirst({ where: {
      actorId: registeredUser.user.id, eventType: "token.revoked", outcome: "success",
    } });
    assert.ok(revocationAudit, "A live Grant revocation must produce an audit event");
    const accessOnly = await issueTokens("m3-access-revoke-state", false);
    const directRevocations = async () => (await getPrisma().auditEvent.findMany({ where: {
      actorId: registeredUser.user.id, eventType: "token.revoked", outcome: "success",
    } })).filter(row => (row.metadata as { tokenType?: string }).tokenType === "access_token");
    const beforeDirect = (await directRevocations()).length;
    const revokedAccess = await tokenRevoke(accessOnly.access_token, "access_token");
    assert.equal(revokedAccess.status, 200);
    assert.equal(await context.getProvider().AccessToken.find(accessOnly.access_token), undefined);
    await context.drainAudit();
    assert.equal((await directRevocations()).length, beforeDirect + 1,
      "A confirmed direct Access Token revoke must create one audit event");
    assert.equal((await tokenRevoke(accessOnly.access_token, "access_token")).status, 200);
    await context.drainAudit();
    assert.equal((await directRevocations()).length, beforeDirect + 1,
      "RFC 7009's idempotent 200 for an already dead token must not duplicate audit");
    const afterAccessRevoke = await issueTokens("m3-after-access-revoke", false);
    assert.ok(afterAccessRevoke.access_token, "Re-authorize after Access Token revocation must issue a new code and token");
    const replayGrant = await issueTokens("m3-replay-state");
    const rotated = await refresh(replayGrant.refresh_token);
    assert.equal(rotated.status, 200);
    const rotatedTokens = await rotated.json() as TokenSet;
    const replay = await refresh(replayGrant.refresh_token);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, "invalid_grant");
    const replayKilledSuccessor = await refresh(rotatedTokens.refresh_token);
    assert.equal(replayKilledSuccessor.status, 400);
    assert.equal((await replayKilledSuccessor.json() as { error: string }).error, "invalid_grant");
    const raceGrant = await issueTokens("m3-race-state");
    const raced = await Promise.all([refresh(raceGrant.refresh_token), refresh(raceGrant.refresh_token)]);
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 400]);
    const loser = raced.find(result => result.status === 400)!;
    assert.equal((await loser.json() as { error: string }).error, "invalid_grant");
    const winner = await raced.find(result => result.status === 200)!.json() as TokenSet;
    assert.ok(winner.refresh_token);
    const winnerContinues = await refresh(winner.refresh_token);
    assert.equal(winnerContinues.status, 200, "Losing concurrent request must not revoke the winner's grant");
    const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json() as { end_session_endpoint: string };
    assert.ok(discovery.end_session_endpoint);
    const logout = new URL(discovery.end_session_endpoint);
    logout.searchParams.set("id_token_hint", raceGrant.id_token);
    logout.searchParams.set("post_logout_redirect_uri", "http://localhost:5173/");
    const unregistered = new URL(logout);
    unregistered.searchParams.set("post_logout_redirect_uri", "http://localhost:5173/unregistered");
    const rejectedLogout = await request(unregistered);
    assert.equal(rejectedLogout.status, 400);
    assert.match(await rejectedLogout.text(), /post_logout_redirect_uri not registered/);
    const confirmation = await request(logout);
    assert.equal(confirmation.status, 200);
    const logoutHtml = await confirmation.text();
    const action = logoutHtml.match(/<form id="op.logoutForm" method="post" action="([^"]+)"/)?.[1];
    const xsrf = logoutHtml.match(/name="xsrf" value="([^"]+)"/)?.[1];
    assert.ok(action && xsrf);
    const ended = await formPost(action, { xsrf, logout: "yes" });
    assert.equal(ended.status, 303);
    assert.equal(ended.headers.get("location"), "http://localhost:5173/");
    await context.drainAudit();
    const logoutAudit = await getPrisma().auditEvent.findFirst({ where: {
      eventType: "logout.completed", outcome: "success",
    } });
    assert.ok(logoutAudit, "Completed Provider logout must produce an audit event");
    const afterLogout = await request(sessionAuth);
    assert.equal(afterLogout.status, 303);
    const login = new URL(afterLogout.headers.get("location")!, issuer);
    assert.ok(login.pathname.startsWith("/interaction/"));
    assert.match(await (await request(login)).text(), /name="password"/);
  } finally { await context.close(); }
});
