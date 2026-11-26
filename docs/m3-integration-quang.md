# M3 integration snapshot — Quang

This review branch starts at PR #27 `3871b0d` and merges PR #31 `e490e44`
and PR #29 `8a8ccd5`. It is an integration candidate, not an M3 acceptance claim.
PR #30 remains separate; its React code has been reviewed but browser E2E has
not run on this snapshot.

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

## Audit policy proposed for team review

Provider events are synchronous EventEmitter notifications, not awaited hooks.
The draft uses **best-effort, fail-open** writes: token issuance/revocation and
logout proceed if audit storage fails; a fixed operational message signals the
failure without secret data. The event handler can still lose events on process
crash and has no durable retry, deduplication or retention. `grant.revoked`
covers Grant revocation, including a live Refresh Token revocation; direct
Access Token revocation under Provider's default policy does not emit that
event, so it is not yet claimed as a complete `token.revoked` audit producer.
Nam's login/MFA events are not persisted by this branch. The team must approve
failure policy, delivery/retry, correlation ownership, retention/access and
the direct-Access-Token case before claiming full M3 audit acceptance.

## Verification

From `identity-server/` on Node 24.22.0 with owned Docker PostgreSQL 17.11:

```sh
npm ci
npm run test:isolated -- --driver=docker
```

The harness verifies server identity and database isolation before migration,
deploys migrations twice, runs backend and safety suites, parallel fixtures,
headers, then checks remaining users=0 and stops its owned container. The
integration test file is `test/m3-mfa-provider-flow.test.ts`; the API/revoke
assertions are in `test/m3-token-lifecycle.test.ts`; audit mapping/failure
tests are in `test/oidc-audit-hooks.test.ts`.

Local Docker run after the Provider audit hook and HTTP API/revocation assertions:
231/231 backend tests PASS, 7/7 database safety PASS, parallel fixture suites
11/11 each PASS, headers 2/2 PASS, zero user residue and owned container
stopped. The two additional audit-hook unit cases were added immediately
after that full run and passed separately (2/2); the PR CI should rerun the
combined final tree. `npm ci` and build on the final tree also passed with
zero npm audit vulnerabilities. The local logs are under `/tmp` and are not
part of the PR.

This snapshot does not yet include browser E2E with PR #30, actual login/MFA
audit persistence or a durable audit queue. Do not merge or close M3 on these
results alone.
