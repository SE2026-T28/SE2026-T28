# VT-113 OIDC issuance verification

Baseline: 4c8e96e4c8eadb934be30a8efc220fa93919b60a.
Branch: feat/vt113-user-search-test-first. No merge/cherry-pick was performed.

## BTCN-only policy

- VT113_SEARCH_ACCOUNT_IDS: comma-separated server-configured account UUIDs; empty by default.
- Only config.clientId may request the exact resource `${issuer}/api/users`.
- users:read is a resource scope, not a default OIDC scope.
- Consent never creates account entitlement. Eligibility is checked before resource consent, at access-token issuance (including old grants), and on each Search API call.
- Tokens are opaque, resource-bound, with 300-second TTL. Bearer API rejects sender-constrained tokens.
- Existing no-resource openid/email requests retain UserInfo behavior.
- Production remains disabled by existing readConfig policy; this is a development/test implementation, not production readiness.

## Reused team source

Selected files from origin/feat/oidc-interactions at 43ccc619f14542468e642eb88f5231c9c764f655:
users/authentication.ts, users/email.ts, users/login-page.ts, interactions/routes.ts.
Authentication uses Prisma account lookup and Argon2 verification. Interaction routes retain CSRF, login rate controls and explicit consent. VT-113 adds the consent eligibility guard.

## Actual RED

`node --import tsx --test test/user-search-issuance.test.ts`
1 failed: expected successful token response, received error=invalid_target.
This was a resource/provider functionality failure, not a missing dependency.

## Actual GREEN

On 127.0.0.1:55432/vt113_user_search_test as non-superuser vt113_test:

- npm.cmd run db:deploy: no pending migrations; schema/migration files unchanged.
- npm.cmd run build: exit 0.
- node --test dist/test/*.test.js: 50 pass, 0 fail, 0 skip.
- npm.cmd run test:headers: 2 pass, 0 fail; running-server checks passed.

Issuance test exercises real registration, credential verification, CSRF forms, consent, authorization code+S256 PKCE exchange, opaque token and PostgreSQL-backed search. Negative assertions cover consent refusal, missing scope, invalid client/resource, eligibility removal with an existing grant/token, fresh ineligible login and expiry using controlled Date advancement. No hardcoded access token or fake verifier is used.

## Limits

The flow test uses fixed localhost port 15539, requiring that port to be free.
Development provider storage/signing keys are ephemeral. Browser Search CORS preflight and performance SLA remain outside this verification. Other unapproved clients are not registered; wrong-client issuance is tested as an unknown client, with model-level wrong-client rejection separately.
