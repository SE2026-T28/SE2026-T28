# M3 integration snapshot — Quang

This review branch starts at PR #27 `3871b0d` and merges PR #31 `e490e44`,
PR #29 `8a8ccd5` and PR #30 `05725c5`. It is an integration candidate, not an
M3 acceptance claim.

## Reconciliation and behavior

- The combined Prisma schema retains `OidcArtifact`, `OidcRevokedGrant`, and
  `AuditEvent`. Both independent migrations are present. Prisma Client was
  regenerated from the combined schema. The MFA tables remain SQL-managed as
  specified in PR #31; a future schema migration must account for them.
- When `MFA_MOCK_ENABLED=true` in local/test and Authentication is configured,
  password success creates a bound challenge and renders a new CSRF-protected
  MFA form. It does not call `interactionFinished`. Successful one-time MFA
  verification is the only path to Provider completion. A failed Provider
  handoff consumes the challenge and requires a fresh authorization flow.
  `MFA_CODE_PEPPER` must be configured; demo-code exposure requires the separate
  local/test switch. The prior M2 flow remains available when MFA is disabled.
- The same HTTP flow now proves resource Access Token → Protected Profile 200,
  ID Token and UserInfo token → 401, and live Refresh Token revocation → the
  same API Access Token returns 401. This is stronger than model-only tests.
- Provider `grant.success`, `grant.revoked`, and `end_session.success` feed
  Phuong's audit recorder using only allowlisted IDs and metadata. Event
  correlation IDs are new server UUIDs; no token, code, password or cookie is
  copied. Tests exercise safe mapping and write failure.
- Interaction password failures and completed Provider login feed the same
  audit recorder. MFA verification success/failure is mapped from Nam's safe
  event channel; an internal interaction UID selects one correlation UUID but
  is never persisted. Background expiry without an interaction UID gets a
  separate correlation UUID. `login.success` is submitted only after
  `interactionFinished` resolves. A failed handoff cannot produce that event.
- The opt-in Chrome scenario drives the actual React client through password,
  MFA, consent, OIDC callback, Protected Profile, revocation and RP logout. It
  captures the browser Access Token internally without printing it, then checks
  that the same token receives 401 from the API after logout.

## Audit policy proposed for team review

Provider events are synchronous EventEmitter notifications, not awaited hooks.
The draft uses **best-effort, fail-open** writes: token issuance/revocation and
logout proceed if audit storage fails; a fixed operational message signals the
failure without secret data. The event handler can still lose events on process
crash and has no durable retry, deduplication or retention. `grant.revoked`
covers Grant revocation, including a live Refresh Token revocation; direct
Access Token revocation under Provider's default policy does not emit that
event, so it is not yet claimed as a complete `token.revoked` audit producer.
Login/MFA events now persist for the exercised password and MFA paths. The
bridge still uses asynchronous best-effort writes. Correlation is per
interaction for login/MFA and per event for Provider token/logout hooks; it is
not yet an end-to-end trace. The team must approve failure policy,
delivery/retry, correlation ownership, retention/access and the
direct-Access-Token case before claiming full M3 audit acceptance.

## Verification

From `identity-server/` on Node 24.22.0 with owned Docker PostgreSQL 17.11:

```sh
npm ci
npm run test:isolated -- --driver=docker
# After `cd ../client-demo && npm ci && npm test && npm run build`, return here:
M3_BROWSER_E2E=1 npm run test:isolated -- --driver=docker
```

The harness verifies server identity and database isolation before migration,
deploys migrations twice, runs backend and safety suites, parallel fixtures,
headers, then checks remaining users=0 and stops its owned container. The
integration test file is `test/m3-mfa-provider-flow.test.ts`; the API/revoke
assertions are in `test/m3-token-lifecycle.test.ts`; audit mapping/failure
tests are in `test/oidc-audit-hooks.test.ts`.

Review follow-up for Phuong's F-01: `test/m3-mfa-provider-flow.test.ts`
asserts persisted `login.failure`, `mfa.failure`, `mfa.success`, and
`login.success` on one correlation, correct actor/client, and no password or
MFA code in metadata. `test/interaction-audit.test.ts` checks that MFA success
alone does not imply login success, rejected Provider completion cannot create
login success, and audit write failure cannot alter a completed interaction.
The existing MFA handoff regression checks that a
failed Provider callback consumes the challenge and requires a new flow.

Final local run after the F-01 bridge: 237/237 backend
tests PASS, 7/7 database safety PASS, parallel fixture suites 11/11 each PASS,
headers 2/2 PASS and Chrome browser E2E PASS on the F-01 tree. The owned
database had zero user residue and its container stopped. React `npm test` was
187/187 PASS on the earlier integration snapshot and its
build passed. `npm ci` on both applications reported zero npm audit
vulnerabilities. The local logs are under `/tmp` and are not part of the PR.

This snapshot does not yet include direct Access Token revocation audit, a
durable audit queue or browser cross-browser coverage. Do not merge or close M3
on these results alone; the team must decide
the audit policy and review the final CI/PR before integration.
