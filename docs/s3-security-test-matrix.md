# S3 Security and Integration Test Matrix

Owner Phuong, Issue #26. Baseline `e82690228e2c6a1713f486dcb4f3dd82bcc43544` on `codex/s1-protected-profile`, after local S1 commit `c650ed3` and S2 commit `e826902`. This stage adds tests and evidence on existing code. Production, schema, shared helpers and harness behavior remain unchanged.

## Spec and evidence rules

Use the S3-owned PostgreSQL 17.11 app04_test harness with live instance verification, owned migration and cleanup. Protocol tests use actual Express/Provider HTTP endpoints discovered from metadata, a registered database account, real login/consent and S256. No success response is mocked. New cases use fresh codes except deliberate replay and same-code positive controls. Error assertions require exact status/OAuth code and absence of access_token/id_token/refresh_token. Diagnostics contain only case ID, status, allowlisted error and tokenPresent.

Existing S1 tests use real Provider models to create opaque fixtures; they prove API validation, not HTTP resource-token issuance or persistent adapter behavior. Existing S2 tests call the service directly; they prove storage/redaction, not live event hooks. Browser evidence from M2 is historical and does not certify M3.

The query-credential regression uses one live, valid Access Token fixture for both transports. Its header request must return 200 before the same token, sent only as access_token in the query, must return 401. A separate test-only Express adapter deliberately converts a query credential into a Bearer header before the unchanged real profile router. The same verifier must raise an assertion with expected=401 and actual=200 on that adapter. Catching this exact assertion is controlled RED evidence, not a production failure. No raw credential or token-bearing URL is printed.

PR #27 was OPEN/draft at `70af038d4197dc7a1995e926a3ec3f67f307c122`, base `b8f400d`, when inspected for this stage. Its resource contract remains app04-react-demo, issuer/api, api:read, opaque Access Token 300 seconds and rotating Refresh Token 3600 seconds. The revised contract distinguishes sequential refresh replay (revokes chain) from a concurrent loser (does not necessarily revoke the winner). It requires stable adapter/cookie keys for restart and encrypts stored adapter payloads. The PR body still quotes older test evidence at eec5fff; that evidence is not a run on the current head. No PR snapshot is merged, cherry-picked or executed in this stage.

Quang confirmed the live Grant/account checks and refresh-revocation chain semantics in [Issue #26](https://github.com/SE2026-T28/SE2026-T28/issues/26#issuecomment-6976301196). The current head's [CI run 44288578875](https://github.com/SE2026-T28/SE2026-T28/actions/runs/44288578875) is completed with backend/applications/secrets PASS and frontend FAIL, so the overall run is FAIL. This is dependency CI evidence; it does not certify this local S1/S2/S3 branch or browser integration.

Statuses describe this stage only. NOT RUN means no current execution yet, BLOCKED names missing integration, PASS requires all assertions on the stated layer. The previous 202-test baseline and initial 214-test S3 run are historical; after the query-test review fix, this stage ran 215/215 backend tests. Current logs and limitations are recorded in [s3-security-test-evidence.md](s3-security-test-evidence.md). Tests of existing behavior may pass on first execution; do not manufacture RED or weaken assertions. New tests precede any fixture/harness change; none is planned. If an actual module defect appears, retain the failing test and report its owner.

Common preconditions are P1 (owned PostgreSQL and registered user), P2 (actual Provider-model token/Grant fixtures and P1), P3 (S2 table/service on owned PostgreSQL), and P4 (approved integration with PR #27 and owner modules). Every row fails if any expected assertion fails.

## Test cases

| ID | Preconditions | Steps | Expected result | Owner / dependency / code | Status |
| --- | --- | --- | --- | --- | --- |
| S3-01 | P1 | Real authorize S256, login, consent, exchange | 200, nonempty Access/ID Token, Bearer, positive expiry | Quang/Nam; oidc-flow.test.ts and s3-protocol-security.test.ts | PASS |
| S3-02 | P1, valid token request fields | Omit code entirely | 400 invalid_request; no tokens or redirect | Quang; new protocol test | PASS |
| S3-03 | P1 | Exchange random unissued code | 400 invalid_grant; no tokens | Quang; new protocol test | PASS |
| S3-04 | P1, fresh S256 code | Exchange successfully, repeat exact request | First 200 with tokens; replay 400 invalid_grant without tokens | Quang; new protocol test strengthens old non-200 replay assertion | PASS |
| S3-05 | P1, fresh unused code | Keep code unused for 77 seconds then exchange correct verifier; exchange a newly issued control code | Expired code 400 invalid_grant/no tokens; fresh control 200 | Quang; new protocol test. Pinned provider 9.12.2 default code TTL 60s and tolerance 15s; real wait includes 2s margin | PASS |
| S3-06 | Current Provider/client | Authorize with unregistered redirect URI | 400, no Location, invalid_redirect_uri HTML code | Quang; m2-authorization-boundary.test.ts | PASS |
| S3-07 | P1, fresh code | Exchange with different redirect; retry same code with registered redirect | 400 invalid_grant/no tokens then 200 with tokens | Quang; new protocol test, mismatch checked before consume in provider 9.12.2 | PASS |
| S3-08 | Current Provider/client | Authorize without challenge/method | Registered callback gets invalid_request, preserved state, no code | Quang; boundary test | PASS |
| S3-09 | Current Provider/client | Authorize with plain method | invalid_request, no code | Quang; boundary test | PASS |
| S3-10 | P1, fresh code | Wrong verifier, then original verifier on same code | 400 invalid_grant/no tokens then 200 with tokens | Quang; M2-04a in oidc-flow.test.ts | PASS |
| S3-11 | P1, separate fresh code | Omit verifier, then original verifier on same code | 400 invalid_grant/no tokens then 200 with tokens | Quang; M2-04b in oidc-flow.test.ts | PASS |
| S3-12 | P2 | Call protected profile without token | 401 invalid_token; no profile | Phuong; protected-profile.test.ts | PASS |
| S3-13 | P2, live valid AT/Grant/account | Call API with unknown token; then valid token in header and the same token only in query; run the verifier against a test-only query-accepting adapter | Unknown token 401; valid header 200; valid query-only 401 without reflection; deliberately unsafe adapter produces a caught 200-versus-401 assertion | Phuong; protected-profile.test.ts | PASS |
| S3-14 | P2 | Call API with expired Access Token fixture | 401, no profile | Phuong; protected-profile.test.ts | PASS |
| S3-15 | P2, signed valid ID Token | Validate ID Token signature, use it as API Bearer | 401 | Phuong; protected-profile.test.ts | PASS |
| S3-16 | P2 | Valid stored token with wrong client | 401 | Phuong; protected-profile.test.ts | PASS |
| S3-17 | P2 | Wrong/missing/multiple audience fixture | 401 for all | Phuong; protected-profile.test.ts | PASS |
| S3-18 | P2 | Missing api:read, substring scope, withdrawn Grant scope | 403 insufficient_scope | Phuong; protected-profile.test.ts | PASS |
| S3-19 | P2 | Destroy token or Grant after successful API call; delete account | Subsequent call 401 | Phuong; model storage tests in protected-profile.test.ts | PASS |
| S3-20 | P4 | Request resource/api:read through browser authorization/token exchange and call S1 | Actual resource Access Token gets 200 with correct sub | Quang PR #27, Phuong S1, Chau Anh C3 | BLOCKED — resource issuance absent on local baseline |
| S3-21 | P4, fresh Refresh Token | Refresh once with resource | 200, rotated Refresh Token, same audience and bounded scopes | Quang PR #27 | BLOCKED |
| S3-22 | P4 | Sequential replay and separate concurrent refresh race | Sequential replay invalid_grant and chain invalidation; race one winner/one invalid_grant, test actual winner validity separately | Quang PR #27; revised contract | BLOCKED |
| S3-23 | P4 | Request expanded scope or different resource during refresh | Reject escalation; never issue expanded rights | Quang PR #27 | BLOCKED |
| S3-24 | P4, fresh AT/RT chain | Call S1 successfully, revoke RT through Discovery endpoint, call same AT again | Revoke 200; same AT now 401, refresh fails; no prior replay confounder | Quang PR #27 and Phuong S1 | BLOCKED |
| S3-25 | P4, fresh RT and recorded expiry | Exchange after expiry | OAuth invalid_grant, no token | Quang PR #27; requires safe expiry strategy for 3600s TTL | BLOCKED |
| S3-26 | P4, real MFA challenge | Correct password, pause before MFA, then correct mock MFA | No code before verified MFA; success completes correct interaction | Nam MFA and Quang interaction | BLOCKED — MFA module not integrated |
| S3-27 | P4, real MFA challenge | Wrong, expired, reused and cross-interaction MFA | Reject each; no code/session escalation; safe audit failure | Nam MFA; event hooks | BLOCKED |
| S3-28 | P4, persistent adapter and stable private keys | Restart Provider process with owned DB, resume session/artifact | Contract-defined state survives; invalid/expired state stays rejected | Quang PR #27 | BLOCKED — current Provider is in-memory |
| S3-29 | P4, active Provider/browser session | Confirm RP logout; start fresh authorization | Provider session ended, login required; local clearing alone is insufficient; logout alone does not imply revocation | Quang PR #27 and Chau Anh C5 | BLOCKED |
| S3-30 | P3 | Record/read seven event types; send secret-bearing/invalid data; trigger controlled DB failure | Correct columns and JSON persisted; unsafe data rejected; fixed failure result | Phuong; audit.test.ts, audit-integration.test.ts, audit-contract.types.ts | PASS |
| S3-31 | P3, two correlation UUIDs | Concurrent audit inserts; cleanup first scope and inspect second | Unique IDs; exact per-scope counts; second scope untouched | Phuong; new s3-audit-isolation.test.ts | PASS |
| S3-32 | P3 | Disconnect/recreate Prisma client and read owned audit rows | Rows remain unchanged across client reconnection; this does not prove Provider restart | Phuong; new audit isolation test | PASS |
| S3-33 | P4, owner hooks connected | Trigger actual login/MFA/issuance/revoke/logout | Correct events exactly as agreed, no secrets, controlled write-failure policy | Nam/Quang hooks and Phuong | BLOCKED |
| S3-34 | P2, known valid AT | Send duplicate raw Authorization headers | 401 despite either credential being valid | Phuong; added S1 regression | PASS |
| S3-35 | P2, known valid AT | Use lowercase bearer scheme | 200 and same minimal profile | Phuong; added S1 regression | PASS |
| S3-36 | P1/P2/P3 | Inspect protocol/API/audit errors and dependency failure | Fixed or allowlisted error, no token/code/password/secret in tested outputs | Phuong; new protocol tests plus S1/S2 regressions | PASS |
| S3-37 | P4 and browser | React login, MFA, consent, verified callback, API, refresh/revoke, RP logout | Actual complete M3 flow, browser and snapshot versions recorded | Entire team; frontend/browser integration | BLOCKED |
| S3-38 | Owned harness | Run safety, migration twice, parallel fixtures, headers and final cleanup | Guard 7/7, fixtures 11/11 each, headers/smoke pass; no owned user/audit residue; capability revoked, owned instance stopped | Phuong; existing harness | PASS |

## Next integration stage

Review the current PR #27 code/CI independently; its updated head needs new evidence. After an approved integration baseline exists, rerun S3-20..29 with the actual persistent adapter and resource issuance. Nam/Quang agree MFA and awaited audit-hook boundaries; Chau Anh integrates resource, refresh and RP logout. Then run S3-33/37 with real browser evidence. Do not close Issue #26 while mandatory integrated cases are BLOCKED/NOT RUN. The old eec5fff Windows failures remain historical rather than current-head findings.
