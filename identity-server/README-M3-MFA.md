# M3-AUTH — Mock MFA module (Nam)

This is a **local/test-only mock MFA module**. It is not a production second factor. The module deliberately does not modify the shared OIDC Provider interaction router, `prisma/schema.prisma`, generated Prisma Client, `app.ts`, or Provider configuration. Those files overlap with Quang's Provider/token/logout ownership.

## Files owned by this change

- `src/mfa/repository.ts` — PostgreSQL repository with transactional, row-locked attempt accounting and one-time challenge consumption.
- `src/mfa/service.ts` — challenge creation, HMAC code verification, browser-context binding, TTL and safe audit events.
- `src/mfa/policy.ts` — mock TTL, attempt and retention defaults.
- `src/mfa/login-page.ts` — escaped HTML for the local/test mock MFA form.
- `src/mfa/browser-binding.ts` — opaque browser-binding generation, strict cookie parsing, and HttpOnly cookie set/clear helpers.
- `src/mfa/form-security.ts` — interaction-bound CSRF token state, constant-time validation, expiry and one-time consume.
- `src/mfa/interaction-handoff.ts` — verifies the persisted challenge and calls a supplied Provider-completion callback only after one-time MFA consumption.
- `src/mfa/audit.ts` — metadata-only process event bridge for Phuong's audit integration.
- `prisma/migrations/20261121000000_mfa_mock_challenges/migration.sql` — additive SQL migration; avoids editing the shared Prisma schema/generated files.
- `test/mfa-service.test.ts` — isolated PostgreSQL tests for persistence, binding, expiry, replay, concurrency and account-wide attempt limits.

## Local configuration

Add these values to `identity-server/.env` (do not commit `.env`):

```env
NODE_ENV=development
MFA_MOCK_ENABLED=true
MFA_DEMO_CODE_ENABLED=true
MFA_CODE_PEPPER=<64-hex-character-random-secret>
```

Generate a local pepper:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`MFA_DEMO_CODE_ENABLED=true` is honored only when `NODE_ENV` is `development` or `test`. The HTML labels the value `MOCK — LOCAL/TEST ONLY`. The code is returned only by the service's explicit local/test result for rendering and retained only in the service instance's short-lived in-memory cache so a local/test page reload can redisplay it; it is never stored in the database, placed in audit metadata or logged by this module. It is discarded on verification success, lock or expiry, and is lost on server restart; if a local/test process restarts, begin a fresh login interaction to generate a new demo challenge. Keep the dedicated `MFA_CODE_PEPPER` stable while challenges are outstanding; do not reuse OIDC cookie, adapter, signing or password secrets.

## Mock policy

- Challenge TTL: 5 minutes.
- Per-challenge failures: 5.
- Per-account failures: 5 within 15 minutes, keyed by `users.id`; a reload, new interaction or new browser binding does not reset the counter.
- At most one pending challenge per account; starting a new authenticated interaction supersedes the previous pending challenge for that user.
- Six-digit demo codes are generated with `crypto.randomInt`.
- `code_hash` and browser binding are HMAC-SHA-256 values with domain separation and the dedicated pepper.
- Verification locks the account attempt row and challenge row inside a PostgreSQL transaction. A challenge can transition to `CONSUMED` only once, including concurrent submissions.
- Cleanup marks pending expired challenges and removes terminal challenge rows after seven days. It is invoked during create/lookup and is also exposed as `cleanupExpired()`.

These are mock defaults, not production MFA policy.

## Interaction handoff for Quang

The Provider interaction router remains unchanged in this branch to avoid editing a file owned by Quang. Instantiate one `MfaChallengeService` for the lifetime of the router/server (not once per request); its local/test-only demo-code cache is intentionally in-memory. The module exposes the handoff that the router should call:

1. After `authenticateUser()` returns the real user, create a challenge with the actual `interaction.uid`, a random browser-binding cookie value, and the client ID.
2. Generate and set the browser-binding cookie using `createMfaBrowserBinding()` and `setMfaBrowserBindingCookie(res, binding, req.secure)`. Read it on subsequent requests using `readMfaBrowserBinding(req)`; reject missing/duplicate/malformed cookies. Clear it after a completed or abandoned MFA flow with `clearMfaBrowserBindingCookie()`. Do not pass the cookie value to HTML or logs.
3. Render `renderMfaPage({ uid, csrfToken, expiresAt, demoCode })`; the router must provide and validate its interaction-bound CSRF token on the MFA POST. Also send `Cache-Control: no-store` and `Pragma: no-cache` response headers.
4. Create one `MfaFormSecurity` instance for the router. Issue a **fresh MFA CSRF token** after password success with `mfaForms.rotate(interaction.uid, created.challenge.expiresAt)`; do not reuse the password form token. On page reload, call `mfaForms.issue(interaction.uid, pending.expiresAt)` to reuse the same unexpired token. On MFA POST, validate `mfaForms.validate(interaction.uid, req.body?.csrf)` before calling `verifyMfaAndFinishInteraction()`; the handoff helper resolves the pending challenge and user ID from PostgreSQL rather than trusting a challenge/user ID in the request. Consume the CSRF token on the successful POST. The PostgreSQL account attempt counter is independent of this process-local form state and must not be reset when rendering/reloading the page.
5. Only when the result is `{ ok: true, userId }` may the router call `provider.interactionFinished()` with `accountId: result.userId`. Never take `userId` from the POST body and never finish the interaction after password verification alone.
6. If verification is invalid, expired or locked, do not call `interactionFinished()` and do not issue any OIDC code/token.

Minimal handoff shape for Quang's router (adapt to the existing form/session helpers; this is not a replacement router):

```ts
// After authenticateUser() has returned a real user:
const browserBinding = createMfaBrowserBinding();
setMfaBrowserBindingCookie(res, browserBinding, req.secure);
const created = await mfaService.createChallenge({
  userId: user.id,
  interactionUid: interaction.uid,
  browserBinding,
  clientId: String(interaction.params.client_id ?? ""),
});
const csrfToken = mfaForms.rotate(interaction.uid, created.challenge.expiresAt);
return res.set("Cache-Control", "no-store").set("Pragma", "no-cache")
  .type("html").send(renderMfaPage({
    uid: interaction.uid,
    csrfToken,
    expiresAt: created.challenge.expiresAt,
    demoCode: created.demoCode,
  }));

// On GET reload, use mfaForms.issue(uid, pending.expiresAt) to keep the current form token.
// On POST /interaction/:uid/mfa, after checking Provider interaction UID:
if (!mfaForms.validate(interaction.uid, req.body?.csrf)) return res.sendStatus(403);
const browserBinding = readMfaBrowserBinding(req);
if (!browserBinding) return res.sendStatus(403);
const verified = await verifyMfaAndFinishInteraction(mfaService, {
  interactionUid: interaction.uid,
  browserBinding,
  code: String(req.body?.code ?? ""),
  clientId: String(interaction.params.client_id ?? ""),
}, async accountId => {
  if (!mfaForms.consume(interaction.uid, req.body?.csrf)) throw new Error("MFA form token expired after verification");
  clearMfaBrowserBindingCookie(res, req.secure);
  return provider.interactionFinished(
    req,
    res,
    { login: { accountId } },
    { mergeWithLastSubmission: false },
  );
});
if (!verified.ok) {
  // Render a generic error; the helper never finishes the OIDC interaction.
  return res.status(401).type("html").send(/* refreshed MFA page */);
}
```

`verifyMfaAndFinishInteraction()` performs the pending-challenge lookup, atomic verification and guarded Provider-completion callback. `createFreshMfaCsrfToken()` above represents the router's existing cryptographically random CSRF mechanism, stored server-side with the interaction UID and short expiry. Do not reuse the password form's consumed CSRF token. The router integration and its CSRF/session state are **not included in this patch** because they require changes to Quang's shared `src/interactions/routes.ts`. Full M3 acceptance remains pending until that integration and its Provider HTTP tests are completed.

## Audit handoff for Phuong

The service emits metadata-only events through `process` event name `mfa:audit` by default, or through an injected `publishAudit` callback in tests. The payload contains only event type, timestamp, actor user UUID, optional client ID and outcome. It contains no password, code, code hash, cookie/browser binding, authorization code or raw token. Phuong's audit module must subscribe and persist these events; this patch does not claim durable audit persistence.

## Tests

Run on the repository's required Node.js `24.22.0` and the isolated PostgreSQL Docker harness:

```powershell
npm run test:isolated -- --driver=docker
```

The new test file covers:

- challenge persistence and safe views (no raw code/hash exposed);
- binding to interaction UID and browser context, with user identity resolved from the persisted challenge;
- one-time consume, replay rejection and concurrent verification;
- wrong-code limits that persist across a new interaction;
- expiry persistence and cleanup;
- interaction-bound MFA CSRF creation, reload reuse, expiry and one-time consume;
- mock-code exposure guard outside local/test.

The tests in this patch do not claim the end-to-end Provider route, cookie or CSRF cases have passed. Those require Quang's interaction-router integration. Do not mark those acceptance cases PASS until the integrated Provider tests are run.

## Migration / schema coordination

The MFA tables are created by an additive SQL migration and accessed through Prisma raw SQL. This is a temporary non-overlapping choice while the Provider owner is changing `prisma/schema.prisma` and generated Prisma Client. The migration is ordered after the Provider migration by timestamp (`20261121000000` after `20261116000000`). Before generating future schema-driven migrations with `prisma migrate dev`, reconcile `mfa_challenges` and `mfa_attempt_limits` into the shared Prisma schema and regenerate the client; do not generate a migration that drops these SQL-managed tables.

## Current integration boundary

This patch provides the MFA service, persistence, page, cookie/form-security primitives and a guarded Provider-completion handoff. It deliberately does **not** mount the MFA GET/POST endpoints or change the password-success branch in `src/interactions/routes.ts`. Until Quang wires those endpoints into the existing interaction router and the Provider HTTP integration tests prove password-only cannot issue an OIDC code/token, the full M3-AUTH acceptance item remains **NOT RUN / incomplete**. The same applies to durable audit storage until Phuong subscribes to and persists the metadata-only events.
