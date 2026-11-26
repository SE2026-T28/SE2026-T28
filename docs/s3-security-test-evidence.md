# S3 Security Test Evidence

Local baseline `e82690228e2c6a1713f486dcb4f3dd82bcc43544`, branch codex/s1-protected-profile. The two original local commits remain c650ed3808237ab5934aea69348ec73d30ff3af6 (S1) and e82690228e2c6a1713f486dcb4f3dd82bcc43544 (S2). This stage is uncommitted test/documentation work for Phuong, Issue #26.

## Coverage result

The [matrix](s3-security-test-matrix.md) contains 38 groups: 26 PASS at their stated HTTP/model/service layer, 12 BLOCKED on integrated modules. BLOCKED rows are not implemented as fake passing tests or counted as runner skips. No mock replaces successful login, code exchange, token model lookup or audit persistence.

The initial ten new leaf tests and two parent containers increased the backend count from 202 to 214. Six leaf cases exercise actual Provider HTTP code handling, two test audit scope/reconnection and two extend S1 credential parsing. The query-credential review fix strengthens an existing assertion and adds one mutation-control leaf, giving 215 tests in the final run. All prior assertions remain.

## Query-credential review fix

The old query test used an unissued fixture and could pass even if an API began accepting valid query credentials. It now sends the existing valid Access Token through Authorization: Bearer and asserts 200, then sends exactly the same token only as access_token in the query and asserts 401, fixed error JSON, no redirect and no token reflection. Its real Provider fixture has valid expiry, app04-react-demo client, issuer/api audience, api:read scope, live Grant and registered account.

A separate loopback-only Express server supplies controlled RED. Test-only middleware accepts the query credential and maps it into one Bearer header before the unchanged real profile router; it uses the same Provider, Grant and account and never fabricates a successful response. The same verifier sees header=200/query=200 and raises its expected=401/actual=200 AssertionError. The control test must catch that exact error; an unrelated exception or a verifier that fails to reject the regression makes the test fail. The temporary server is closed in finally.

| Check | Observed | Status |
| --- | --- | --- |
| Controlled RED | headerStatus=200 queryStatus=200 expected=401 regressionDetected=true | Expected assertion caught; mutation detected |
| GREEN on current API | headerStatus=200 queryStatus=401 tokenReflected=false | PASS |
| Final query-fix isolated run | 215 PASS / 0 FAIL / 0 SKIP; native harness exit 0 | PASS |
| Guard, parallel fixtures, headers | 7/7; 11/11 each; 2/2 and smoke PASS | PASS |
| Cleanup | Audit scope cleanup asserted, remaining users=0, capability revoked, owned PostgreSQL stopped | PASS |

Command in identity-server is npm.cmd run test:isolated -- --driver=native, with explicit LASTEXITCODE capture. Build/typecheck also passes. Logs for this run are node_modules/s3-query-fix/build.private.log, isolated.private.log and final-build.private.log. Diagnostics contain only case ID and statuses/flags; fetch transport failures use fixed messages so token-bearing URLs are not printed. The controlled RED is a deliberately caught assertion on a test-only adapter, rather than a failing production implementation.

The following table retains the earlier 214-test run and its authoring history.

| Stage / command | Expected | Actual | Status |
| --- | --- | --- | --- |
| Initial build, npm.cmd --prefix identity-server run build | New test code compiles | New login/consent field union needed an explicit Record<string,string> annotation; corrected in test only | Initial test-authoring failure resolved |
| First isolated run, in identity-server: npm.cmd run test:isolated -- --driver=native | New and old assertions pass | 212 PASS / 2 FAIL including parent. Raw duplicate-header request omitted Host, so Node rejected it with 400 before the route; PostgreSQL stopped after failure | FAIL, test-authoring error |
| HTTP transport diagnosis | Confirm whether raw header construction reaches HTTP handler | In-memory transport-only probe returned 400 without Host, 401 with Host. This probe is not API acceptance evidence | Diagnosis confirmed |
| Prior isolated S3 run, same command with explicit native exit capture | Full suite and strict protocol assertions pass | 214 PASS / 0 FAIL / 0 SKIP; native harness exit 0 | PASS |
| Build/typecheck | Current TypeScript and compile-only audit contract pass | Harness build succeeds; final standalone build succeeds | PASS |
| Database safety | Existing guard/override/isolation tests pass | 7/7 | PASS |
| Fixture concurrency | Existing two fixture/registration processes pass | 11/11 in each process | PASS |
| Headers | Checker and server smoke pass | 2/2 and smoke PASS | PASS |
| Cleanup | Exact audit-scope cleanup, no user residue; capability revoked and instance stopped | Audit assertions verify zero owned rows; remaining users=0; session revoked; owned instance stopped | PASS |
| Browser M3, frontend tests, Docker driver, CI for this local branch | Require respective integration/environment | Not executed in this stage | NOT RUN |

Environment is Windows, Node 24.22.0, PostgreSQL 17.11 native, Prisma 7.10.1, oidc-provider 9.12.2. No dependencies were changed or installed. The existing isolated harness creates app04_test on a fresh cluster, validates system identifier, data directory, startup time, capability and schema/config hashes before deploying the two existing migrations. It deploys a second time with no pending migrations. No shared/development database was used.

An intermediate corrected run had all 214 tests passing but PowerShell reported wrapper exit 1 after redirected native stderr. A transport-independent diagnostic reproduced shell exit 1 for a native process whose exit code was 0. The final harness run explicitly captured LASTEXITCODE and exited with it, confirming native exit 0 as well as the full assertions/cleanup. This was a command-capture correction, not a test assertion or harness-source change.

## Sanitized protocol observations

| ID | Expected and actual |
| --- | --- |
| S3-01 | Fresh S256 code from registered account/login/consent, token exchange 200; nonempty Access/ID Token, Bearer type, positive lifetime |
| S3-02 | Omit code entirely, 400 invalid_request, tokenPresent=false |
| S3-03 | Random unissued code, 400 invalid_grant, tokenPresent=false |
| S3-04 | Fresh code first exchange 200, exact replay 400 invalid_grant, tokenPresent=false |
| S3-07 | Fresh code with wrong redirect, 400 invalid_grant/no tokens; same code/verifier with original redirect 200 |
| S3-05 | Code from real authorization kept unused for at least 77 seconds, 400 invalid_grant/no tokens; a newly authorized control code exchanges with 200 |

The real expiry test uses pinned provider defaults AuthorizationCodeTTL=60s and clockTolerance=15s, plus 2s margin; source references are node_modules/oidc-provider/lib/helpers/defaults.js (AuthorizationCodeTTL and clockTolerance) and lib/actions/grants/authorization_code.js (expiry, PKCE and redirect checks before consume). Current createApp overrides neither default. No fake clock or shortened TTL was used. Elapsed time uses performance.now. Future TTL changes require updating this precondition.

Error assertions also reject token fields, redirects and reflection of the supplied code/verifier/password. Diagnostics emit only case ID, status, allowlisted OAuth error and tokenPresent. New API assertions avoid printing response contents on failure. The duplicate-header case confirms that the same token works first, sends both valid credentials with a real Host header, then requires 401. Lowercase bearer requires 200 and exactly the expected sub profile.

S3-31 writes 16 real audit rows concurrently in two correlation scopes with the same actor; cleanup of the first scope leaves all eight IDs in the second untouched. S3-32 recreates the Prisma client and verifies the second scope's eight IDs/metadata before exact cleanup. This proves audit storage survives client reconnection; Provider-process restart remains BLOCKED. S1 fixtures and S2 direct-service tests do not prove actual resource issuance, MFA or audit hook execution.

## Dependencies and next stage

As verified on 2026-11-25, PR #27 is OPEN and no longer Draft at HEAD `3871b0d8678e900e6532fc1056e68c4fd721f820`. Its [CI run 45542936164](https://github.com/SE2026-T28/SE2026-T28/actions/runs/45542936164) completed with SUCCESS on that HEAD. This dependency run does not certify this local branch or an integrated PR #27 + #29 snapshot; no integration tests were rerun for this documentation update.

Historical evidence: PR #27 was OPEN/draft at `70af038d4197dc7a1995e926a3ec3f67f307c122`; [run 44288578875](https://github.com/SE2026-T28/SE2026-T28/actions/runs/44288578875) had backend/applications/secrets PASS and frontend FAIL, with overall FAIL. These are historical results, not the current PR status or HEAD. The older eec5fff native failures in S1 history were not rerun or attributed to the current HEAD. Quang's [Issue #26 clarification](https://github.com/SE2026-T28/SE2026-T28/issues/26#issuecomment-6976301196) distinguishes sequential replay from concurrent refresh behavior and confirms live Grant/account checks.

Refresh, HTTP revocation, persistent Provider restart, RP logout, MFA and real event-hook/browser acceptance remain BLOCKED on approved integration. The matrix remains 38 groups: 26 PASS / 12 BLOCKED; successful dependency CI does not change these results. Next, review the current PR #27 HEAD and successful CI above, obtain an approved integrated baseline, test fresh token-chain revocation without a prior replay confounder, then test actual MFA/audit hooks and the complete React flow. Retention/write-failure policies remain the owners' integration decisions. S3-13 now includes valid-query-credential rejection and controlled mutation detection as recorded above.

## Workspace integrity and private artifacts

Only protected-profile.test.ts was extended among tracked test files, plus the two new S3 test files and these two new documents. Shared fixtures/harness and all production/schema/migration files match the pre-run hashes. Prisma generation temporarily recreated formatting; its generated output was returned to the exact pre-run bytes. No business logic or owner module was modified. No commit, push, merge, cherry-pick, PR or Issue mutation occurred.

Private Git-ignored logs are under node_modules/s3-security-evidence: build.private.log, isolated.private.log (initial failure), final-isolated.private.log (intermediate run), verified-isolated.private.log (final run with native exit capture), final-build.private.log and source-before.json. Publish only sanitized aggregates. The first test failure is retained in evidence rather than presented as a Provider defect or a manufactured implementation RED.

READY FOR REVIEW for independent S3 coverage. Full M3 acceptance remains BLOCKED by the matrix integration dependencies.
