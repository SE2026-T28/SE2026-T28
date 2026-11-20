# S1 implementation evidence

Baseline `b8f400d25e65168383142bc31a585cde9299822e`. Branch `codex/s1-protected-profile`, local uncommitted changes. Issue #26 scope is S1. Implementation follows [the spec](s1-protected-profile-spec.md).

Environment is Windows, Node 24.22.0, PostgreSQL 17.11 native, oidc-provider 9.12.2, Prisma 7.10.1. Each harness run creates a fresh app04_test instance, verifies control-file/live server identity, data directory and startup time before migration, then revokes its capability and stops its instance. Docker is unavailable and was NOT RUN. GitHub CI for this change is NOT RUN.

Run `npm ci` followed by `npm run test:isolated -- --driver=native` in identity-server. The harness runs build, safety checks, guarded migration twice, the full backend suite, parallel fixture suites and security headers. Logs below are private Git-ignored local artifacts.

| Stage | Expected | Actual | Result |
| --- | --- | --- | --- |
| RED before implementation | S1 fails because endpoint/module are absent, existing suite passes | 65 PASS, 2 FAIL. Normal app returned 404 where 401 was required; module import reported ERR_MODULE_NOT_FOUND. Build and safety 7/7 passed. Owned instance stopped. | Expected RED |
| Initial test compilation | Test helpers typecheck | Initial helper returned Response instead of void; fixed in test code before valid RED. A later mock restore call also needed the Node mock context API. | Resolved test authoring errors |
| Final build and backend | Existing 65 tests plus 26 S1 tests including parent tests pass | 91 PASS, 0 FAIL, 0 SKIP; includes signed and validated Provider ID Token rejected as API bearer. | PASS |
| Database safety | Guard and datasource/isolation refusals remain intact | 7/7 | PASS |
| Fixtures and headers | Ownership cleanup and parallel runs remain isolated; header checker and server smoke pass | 11/11 in each of two concurrent processes; headers 2/2 and smoke PASS | PASS |
| Final native cleanup | No user residue; revoke capability and stop owned instance | remaining users=0; session revoked; owned instance stopped | PASS |
| S1 + PR #27 isolated snapshot | HTTP authorization/code exchange issues API token, profile 200, ID Token 401, Refresh Token revoke 200, same Access Token subsequently 401 | Code exchange returned 400 instead of 200, before protected API assertions. Full suite 88 PASS / 4 FAIL / 0 SKIP. | FAIL; HTTP Grant/revocation acceptance BLOCKED |
| Pristine PR #27 control | Upstream suite passes without S1 | 62 PASS / 3 FAIL / 0 SKIP. The same adapter consume test and two existing OIDC tests fail. | FAIL; upstream/environment dependency reproduced |

The model tests use actual Provider AccessToken/Grant storage with isolated PostgreSQL user fixtures. Valid API token yields 200 and only sub. Missing/unknown/expired token, wrong audience/client, UserInfo token, signed ID Token, missing/expired/mismatched Grant and deleted account yield 401. Missing exact api:read scope or withdrawn Grant permission yields 403. Tests cover AccessToken.destroy and Grant.destroy, CORS/preflight and response redaction. Only the dependency-exception test mocks a lookup failure. Successful authorization tests use real model lookup.

The standalone ID Token fixture initially omitted sub from its filtered payload; validation caught that error. The final fixture explicitly supplies sub, retains Provider signature validation, then asserts API rejection. Assertions were preserved.

## Dependency evidence

[PR #27](https://github.com/SE2026-T28/SE2026-T28/pull/27) was OPEN/draft at `eec5fffa044c840703fa452f4c890477e81816a9`. Its token contract is read from `docs/m3-token-logout-contract.md`. Temporary snapshots were exported from this exact commit into node_modules; no branch merge was used. The integration overlay adds only the S1 module, route mount and test code. A separate pristine export retains the original PR code and tests.

In both snapshots, `identity-server/test/oidc-adapter.test.ts` expected one successful concurrent consume but observed zero. Existing `m3-token-lifecycle.test.ts` and `oidc-flow.test.ts` expected the first code exchange to return 200 but observed 400. The additional S1 HTTP probe also stopped at that exchange. Root cause is not established. Quang should reproduce these failures on Windows/native and compare with the PR's reported Docker run. No Provider/adapter code was changed to mask the failures.

HTTP Refresh Token revocation invalidating API access is NOT VERIFIED. Model destruction tests do not substitute for this acceptance criterion. Snapshot harnesses stopped their owned instances after failure. Since their suites failed before the final residue stage, remaining-user assertions were NOT RUN for those snapshots.

Private artifacts relative to the S1 worktree are `s1-red.private.log`, `s1-green.private.log`, `node_modules/s1-pr27-green.private.log`, `node_modules/s1-pr27-pristine.private.log` and the two exported snapshot directories. Do not publish raw runtime directories or database manifests. Expected/actual output above excludes token, code, verifier, password and fixture identities.

## Review disposition

READY WITH REMAINING BLOCKERS. S1 standalone behavior and baseline regression are GREEN. Provider-issued API token and HTTP revocation integration remain blocked on PR #27 in this environment. Response intentionally contains only sub; React C3 integration and browser acceptance remain outstanding. No GitHub mutation, commit or push was performed.
