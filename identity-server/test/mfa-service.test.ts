import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getPrisma } from "../src/db/prisma.js";
import { createMfaChallengeService, type MfaAuditEvent } from "../src/mfa/service.js";
import { MfaRateLimitedError } from "../src/mfa/repository.js";
import { renderMfaPage } from "../src/mfa/login-page.js";
import { verifyMfaAndFinishInteraction } from "../src/mfa/interaction-handoff.js";
import { createIntegrationTestContext } from "./helpers.js";

const TEST_PEPPER = "m3-service-test-pepper-32-bytes-minimum-000000000000";
const TEST_PASSWORD = "M3-MFA-Test-Password-123!";
const savedNodeEnv = process.env.NODE_ENV;
const savedMfaEnabled = process.env.MFA_MOCK_ENABLED;
let context: Awaited<ReturnType<typeof createIntegrationTestContext>> | undefined;
const users: string[] = [];

async function createUser(): Promise<string> {
  assert.ok(context);
  const email = context.fixtures.email();
  const response = await context.fixtures.track(() => fetch(`${context!.baseUrl}/api/users/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  }));
  assert.equal(response.status, 201);
  const body = await response.json() as { user: { id: string } };
  users.push(body.user.id);
  return body.user.id;
}

function makeService(options: {
  now?: () => Date;
  makeCode?: () => string;
  publishAudit?: (event: MfaAuditEvent) => void;
} = {}) {
  return createMfaChallengeService({
    codePepper: TEST_PEPPER,
    exposeDemoCode: true,
    ...options,
  });
}

function challengeInput(userId: string, interactionUid: string, browserBinding = `browser-${interactionUid}`) {
  return { userId, interactionUid, browserBinding, clientId: "app04-react-demo" };
}

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.MFA_MOCK_ENABLED = "true";
  context = await createIntegrationTestContext();
  for (let index = 0; index < 5; index++) await createUser();
});

after(async () => {
  await context?.close();
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedMfaEnabled === undefined) delete process.env.MFA_MOCK_ENABLED;
  else process.env.MFA_MOCK_ENABLED = savedMfaEnabled;
});

test("challenge stores HMAC hashes only and returns a safe public view", async () => {
  const userId = users[0]!;
  const code = "135790";
  const events: MfaAuditEvent[] = [];
  const service = makeService({ makeCode: () => code, publishAudit: event => events.push(event) });
  const binding = "browser-binding-hash-test";
  const created = await service.createChallenge(challengeInput(userId, "mfa-unit-created-0001", binding));

  assert.equal(created.demoCode, code);
  assert.equal(created.challenge.status, "PENDING");
  assert.equal(created.challenge.attempts, 0);
  assert.equal(created.challenge.maxAttempts, 5);
  assert.equal("codeHash" in created.challenge, false);
  assert.equal("userId" in created.challenge, false);
  const pending = await service.findPendingChallenge({
    interactionUid: "mfa-unit-created-0001",
    browserBinding: binding,
  });
  assert.ok(pending);
  assert.equal(pending.id, created.challenge.id);
  assert.equal(pending.demoCode, code);
  assert.equal("codeHash" in pending, false);

  const stored = await getPrisma().$queryRaw<Array<{ code_hash: string; browser_binding_hash: string; status: string }>>`
    SELECT "code_hash", "browser_binding_hash", "status"
    FROM "mfa_challenges" WHERE "id" = ${created.challenge.id}::uuid
  `;
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.code_hash.trim(), /^[a-f0-9]{64}$/);
  assert.notEqual(stored[0]!.code_hash.trim(), code);
  assert.notEqual(stored[0]!.browser_binding_hash.trim(), binding);
  assert.equal(stored[0]!.status, "PENDING");
  assert.deepEqual(Object.keys(events[0]!).sort(), ["actorUserId", "clientId", "eventType", "occurredAt", "outcome"].sort());
  assert.equal(JSON.stringify(events).includes(code), false);
});

test("challenge is bound to the interaction and browser context; user identity stays server-side", async () => {
  const userId = users[1]!;
  const service = makeService({ makeCode: () => "246802" });
  const created = await service.createChallenge(challengeInput(userId, "mfa-binding-check-0001", "browser-binding-check"));

  const wrongInteraction = await service.verifyPendingChallenge({
    interactionUid: "mfa-other-interaction-0001",
    browserBinding: "browser-binding-check",
    code: "246802",
  });
  const wrongBrowser = await service.verifyPendingChallenge({
    interactionUid: "mfa-binding-check-0001",
    browserBinding: "different-browser-binding",
    code: "246802",
  });
  assert.deepEqual(wrongInteraction, { ok: false, reason: "invalid" });
  assert.deepEqual(wrongBrowser, { ok: false, reason: "invalid" });

  const stored = await getPrisma().$queryRaw<Array<{ attempts: number }>>`
    SELECT "attempts" FROM "mfa_challenges" WHERE "id" = ${created.challenge.id}::uuid
  `;
  assert.equal(Number(stored[0]!.attempts), 0);
  const valid = await service.verifyPendingChallenge({
    interactionUid: "mfa-binding-check-0001",
    browserBinding: "browser-binding-check",
    code: "246802",
  });
  assert.deepEqual(valid, { ok: true, userId });
});

test("successful verification consumes the challenge atomically and rejects replay", async () => {
  const userId = users[2]!;
  const code = "112233";
  const service = makeService({ makeCode: () => code });
  const created = await service.createChallenge(challengeInput(userId, "mfa-concurrent-verify-0001"));

  const input = {
    interactionUid: "mfa-concurrent-verify-0001",
    browserBinding: "browser-mfa-concurrent-verify-0001",
    code,
  };
  const results = await Promise.all([
    service.verifyPendingChallenge(input),
    service.verifyPendingChallenge(input),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok).length, 1);

  const replay = await service.verifyPendingChallenge(input);
  assert.deepEqual(replay, { ok: false, reason: "invalid" });
  const stored = await getPrisma().$queryRaw<Array<{ status: string; consumed_at: Date | null }>>`
    SELECT "status", "consumed_at" FROM "mfa_challenges" WHERE "id" = ${created.challenge.id}::uuid
  `;
  assert.equal(stored[0]!.status, "CONSUMED");
  assert.ok(stored[0]!.consumed_at);
});

test("wrong-code limit survives a new interaction and blocks challenge creation", async () => {
  const userId = users[3]!;
  const service = makeService({ makeCode: () => "654321" });
  const first = await service.createChallenge(challengeInput(userId, "mfa-attempt-window-a-0001"));

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await service.verifyPendingChallenge({
      interactionUid: "mfa-attempt-window-a-0001",
      browserBinding: "browser-mfa-attempt-window-a-0001",
      code: "000000",
    });
    assert.deepEqual(result, { ok: false, reason: "invalid" });
  }

  // A reloaded MFA page reads the same persisted challenge and attempt count.
  const afterReload = await service.findPendingChallenge({
    interactionUid: "mfa-attempt-window-a-0001",
    browserBinding: "browser-mfa-attempt-window-a-0001",
  });
  assert.equal(afterReload?.id, first.challenge.id);
  assert.equal(afterReload?.attempts, 4);
  assert.equal(afterReload?.demoCode, "654321");

  const second = await service.createChallenge(challengeInput(userId, "mfa-attempt-window-b-0001"));
  const superseded = await getPrisma().$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "mfa_challenges" WHERE "id" = ${first.challenge.id}::uuid
  `;
  assert.equal(superseded[0]!.status, "SUPERSEDED");
  const fifthFailure = await service.verifyPendingChallenge({
    interactionUid: "mfa-attempt-window-b-0001",
    browserBinding: "browser-mfa-attempt-window-b-0001",
    code: "000000",
  });
  assert.deepEqual(fifthFailure, { ok: false, reason: "locked" });
  await assert.rejects(
    () => service.createChallenge(challengeInput(userId, "mfa-attempt-window-c-0001")),
    MfaRateLimitedError,
  );
});



test("interaction handoff never finishes Provider before valid MFA", async () => {
  const userId = users[1]!;
  const service = makeService({ makeCode: () => "314159" });
  const interactionUid = "mfa-handoff-verify-0001";
  const browserBinding = "browser-mfa-handoff-verify-0001";
  await service.createChallenge(challengeInput(userId, interactionUid, browserBinding));
  let finishCalls = 0;
  let finishedAccountId: string | undefined;
  const finish = async (accountId: string) => {
    finishCalls++;
    finishedAccountId = accountId;
  };

  const rejected = await verifyMfaAndFinishInteraction(service, {
    interactionUid, browserBinding, code: "000000", clientId: "app04-react-demo",
  }, finish);
  assert.deepEqual(rejected, { ok: false, reason: "invalid" });
  assert.equal(finishCalls, 0);

  const accepted = await verifyMfaAndFinishInteraction(service, {
    interactionUid, browserBinding, code: "314159", clientId: "app04-react-demo",
  }, finish);
  assert.deepEqual(accepted, { ok: true, userId });
  assert.equal(finishCalls, 1);
  assert.equal(finishedAccountId, userId);

  const replay = await verifyMfaAndFinishInteraction(service, {
    interactionUid, browserBinding, code: "314159", clientId: "app04-react-demo",
  }, finish);
  assert.deepEqual(replay, { ok: false, reason: "invalid" });
  assert.equal(finishCalls, 1);
});

test("expired challenge is persisted as EXPIRED and cannot verify", async () => {
  const userId = users[4]!;
  let now = new Date();
  const service = makeService({ now: () => now, makeCode: () => "987654" });
  const created = await service.createChallenge(challengeInput(userId, "mfa-expiry-check-0001"));
  now = new Date(created.challenge.expiresAt.getTime() + 1);

  const result = await service.verifyPendingChallenge({
    interactionUid: "mfa-expiry-check-0001",
    browserBinding: "browser-mfa-expiry-check-0001",
    code: "987654",
  });
  assert.deepEqual(result, { ok: false, reason: "expired" });

  const stored = await getPrisma().$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "mfa_challenges" WHERE "id" = ${created.challenge.id}::uuid
  `;
  assert.equal(stored[0]!.status, "EXPIRED");
});

test("cleanup expires pending rows and the safe MFA page never exposes hashes", async () => {
  const userId = users[0]!;
  let now = new Date();
  const service = makeService({ now: () => now, makeCode: () => "445566" });
  const created = await service.createChallenge(challengeInput(userId, "mfa-cleanup-check-0001"));
  now = new Date(created.challenge.expiresAt.getTime() + 1);
  const cleanup = await service.cleanupExpired();
  assert.ok(cleanup.expired >= 1);

  const stored = await getPrisma().$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "mfa_challenges" WHERE "id" = ${created.challenge.id}::uuid
  `;
  assert.equal(stored[0]!.status, "EXPIRED");

  const html = renderMfaPage({
    uid: "interaction-<unsafe>",
    csrfToken: "a".repeat(64),
    expiresAt: created.challenge.expiresAt,
    demoCode: "445566",
  });
  assert.match(html, /MOCK — LOCAL\/TEST ONLY/);
  assert.match(html, /không phải MFA production/);
  assert.match(html, /Cache-Control/);
  assert.match(html, /interaction-%3Cunsafe%3E/);
  assert.equal(html.includes("code_hash"), false);
  assert.equal(html.includes("passwordHash"), false);
  assert.equal(html.includes("<unsafe>"), false);
});

test("MFA mock and demo-code exposure are restricted to explicitly enabled local/test", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEnabled = process.env.MFA_MOCK_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    process.env.MFA_MOCK_ENABLED = "true";
    assert.throws(() => createMfaChallengeService({ codePepper: TEST_PEPPER, exposeDemoCode: true }), /restricted to explicitly enabled development\/test/);

    process.env.NODE_ENV = "test";
    delete process.env.MFA_MOCK_ENABLED;
    assert.throws(() => createMfaChallengeService({ codePepper: TEST_PEPPER, exposeDemoCode: true }), /restricted to explicitly enabled development\/test/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousEnabled === undefined) delete process.env.MFA_MOCK_ENABLED;
    else process.env.MFA_MOCK_ENABLED = previousEnabled;
  }
});

test("MFA browser binding cookie is opaque, HttpOnly and rejects duplicates", async () => {
  const {
    MFA_BROWSER_COOKIE_NAME,
    createMfaBrowserBinding,
    readMfaBrowserBinding,
    setMfaBrowserBindingCookie,
    clearMfaBrowserBindingCookie,
    isSameMfaBrowserBinding,
  } = await import("../src/mfa/browser-binding.js");
  const binding = createMfaBrowserBinding();
  assert.match(binding, /^[A-Za-z0-9_-]{43}$/);

  const request = (cookie: string) => ({ headers: { cookie } }) as import("express").Request;
  assert.equal(readMfaBrowserBinding(request(`other=1; ${MFA_BROWSER_COOKIE_NAME}=${binding}`)), binding);
  assert.equal(isSameMfaBrowserBinding(binding, binding), true);
  assert.equal(isSameMfaBrowserBinding(null, binding), false);
  assert.equal(isSameMfaBrowserBinding(`${binding}x`, binding), false);
  assert.equal(readMfaBrowserBinding(request(`${MFA_BROWSER_COOKIE_NAME}=bad`)), null);
  assert.equal(readMfaBrowserBinding(request(`${MFA_BROWSER_COOKIE_NAME}=${binding}; ${MFA_BROWSER_COOKIE_NAME}=${binding}`)), null);

  const setCookies: string[] = [];
  const response = { append: (name: string, value: string) => { assert.equal(name, "Set-Cookie"); setCookies.push(value); } } as unknown as import("express").Response;
  setMfaBrowserBindingCookie(response, binding, true);
  clearMfaBrowserBindingCookie(response, true);
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[0]!, /HttpOnly/);
  assert.match(setCookies[0]!, /SameSite=Lax/);
  assert.match(setCookies[0]!, /Secure/);
  assert.match(setCookies[0]!, /Path=\/interaction/);
  assert.match(setCookies[1]!, /Max-Age=0/);
});
