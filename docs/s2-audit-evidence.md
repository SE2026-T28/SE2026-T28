# S2 Audit verification

## LOW-01 and LOW-02 review fixes

Same branch and HEAD, local uncommitted changes. Only the audit service, its two runtime test files, a compile-only contract test and S2 documentation were changed for these findings. Existing S1 files are verified against the original five-file hash snapshot.

LOW-01 now validates all own string properties with Object.getOwnPropertyNames after plainRecord rejects Symbol keys, accessors and custom prototypes. Validation and metadata copying include non-enumerable properties. Unknown keys including hidden sensitive/prototype-related keys are rejected before persistence; allowed hidden data properties follow the same value rules and are copied. Scope arrays also reject extra own string/Symbol keys and custom prototypes. The event/metadata allowlists are unchanged.

LOW-02 replaces both variable dynamic imports with static imports and removes any-typed fixture rows. Hostile runtime inputs use an explicit unknown-to-AuditEventInput boundary; valid cases call the typed recorder directly. audit-contract.types.ts imports the real recorder and asserts invalid event type, metadata type and client ID using @ts-expect-error. The function is never called at runtime and is included in the existing test/**/*.ts build pipeline.

| Verification | Actual | Status |
| --- | --- | --- |
| RED runtime before service fix | node --test identity-server/dist/test/audit.test.js: 78 PASS / 24 FAIL, including parent failure; 23 leaf failures expose hidden unknown keys and ignored allowed hidden metadata | Expected RED |
| RED type contract with the original dynamic import | npm.cmd --prefix identity-server run build: three TS2578 unused @ts-expect-error errors because recorder was any | Expected RED |
| GREEN build/type contract | Same build command succeeds with static imports; an in-memory compiler check removing only the directives reports exactly three TS2322 errors and confirms the file belongs to the normal pipeline | PASS |
| Scope-array RED during self-review | Three new leaf tests reject hidden password/Symbol properties and custom array prototypes; before the array fix, unit suite had 102 PASS / 4 FAIL including parent failure | Expected RED |
| Final unit suite | node --test identity-server/dist/test/audit.test.js; 106 PASS / 0 FAIL / 0 SKIP | PASS |
| Final isolated backend | In identity-server: npm.cmd run test:isolated -- --driver=native; 202 PASS / 0 FAIL / 0 SKIP, including S1 and PostgreSQL audit regression | PASS |
| Guard, fixtures, headers | Safety 7/7; parallel fixtures 11/11 each; headers 2/2 and smoke PASS | PASS |
| Cleanup | Exact audit correlation-scope cleanup asserted; remaining users=0; session revoked and owned instance stopped | PASS |

The runtime RED was run from TypeScript's emitted test output despite the intentional compile-only RED diagnostics. No service fix had been applied at that point. The subsequent full harness rebuilt the final sources successfully before running tests.

Private logs for this fix are under node_modules/s2-low-fixes: type-red.private.log, runtime-red.private.log, scope-red.private.log, final-build.private.log, final-unit.private.log and final-isolated-green.private.log. Earlier GREEN logs describe intermediate versions; the final isolated log includes the hidden-value and scope-array regressions. Schema/migration and cross-module hooks remain unchanged. Docker and GitHub CI remain NOT RUN.

## Original S2 implementation evidence

Verified locally on 2026-11-20, Asia/Saigon. Branch `codex/s1-protected-profile`, HEAD `b8f400d25e65168383142bc31a585cde9299822e` with uncommitted S1 and S2 changes. Existing S1 source, test and documentation hashes matched before and after S2 work. AGENTS.md is empty.

## Commands and observed results

Environment is Windows, Node 24.22.0, PostgreSQL 17.11 native, Prisma 7.10.1. Existing dependencies were reused. PowerShell blocked npm.ps1; commands used npm.cmd without changing machine execution policy.

| Stage | Command | Expected | Actual | Status |
| --- | --- | --- | --- | --- |
| RED | `npm.cmd --prefix identity-server run build`, then `node --test identity-server/dist/test/audit.test.js` | Build succeeds; audit test fails because implementation is absent | Build PASS; 0 PASS / 1 FAIL, ERR_MODULE_NOT_FOUND for audit/service.js | Expected RED |
| First isolated run | In identity-server, `npm.cmd run test:isolated -- --driver=native` | Additive migration, audit tests and existing suite pass | 168/168 PASS; includes 91 baseline/S1 tests. Additional roundtrip/failure/allowlist assertions were then added. | PASS for first version |
| Final isolated run | Same harness command | All final assertions, safety and regression pass | 170 PASS / 0 FAIL / 0 SKIP, including seven stored event types and S1 regression | PASS |
| Database guard | Harness test:safety | Reject unsafe datasource/override/isolation | 7/7 PASS | PASS |
| Migration | Harness db:deploy twice | Create audit_events on newly owned app04_test; second deploy is idempotent | Two migrations found, existing users migration and new audit migration applied; second deploy reports no pending migrations | PASS |
| Parallel fixtures | Harness fixture/registration suites | Exact fixture ownership, failure cleanup and concurrency remain intact | 11/11 in each of two concurrent suites | PASS |
| Security headers | Harness test:headers | Header checker and real-server smoke pass | 2/2 and smoke PASS | PASS |
| Cleanup | Audit test finally and harness finally | Delete only audit rows with this run's correlation UUID, no user residue; revoke capability and stop owned PostgreSQL | Audit scope count asserted zero; remaining users=0; session revoked; owned instance stopped | PASS |
| Build after generated formatting | `npm.cmd --prefix identity-server run build` | Final generated client and source compile | Exit 0 | PASS |
| Docker, GitHub CI, cross-module hooks/browser | Not executed | Require respective environment or integration approval | No Docker executable; no GitHub changes; owners' modules are not wired | NOT RUN |

Each isolated run verified PostgreSQL system identifier, data directory, startup time, manifest/capability, schema hash and exact app04_test target before migration. No development/shared database was contacted. Tests use a per-run correlation UUID and exact-scope SQL cleanup. Database-error coverage executes a controlled failing SQL expression on the owned instance and verifies the service returns only write_failed.

## Scope and review

The new audit service, tests, additive Prisma model/migration and regenerated Prisma client belong to S2. Generated comments introduced by Prisma had trailing whitespace removed for diff checks. User/authentication, interaction, Provider, MFA, React and S1 files were not edited. No hook, read API, dependency or OIDC contract change was introduced. No PR #27 merge or cherry-pick occurred.

The [spec and integration contract](s2-audit-spec.md) defines AuditRecorder, event-specific metadata and safe result handling for Nam and Quang. Unit tests reject unknown/sensitive fields, malformed/oversized values, invalid enum/outcome combinations, scope accessors and mutable runtime allowlists. Metadata is copied before awaiting storage. No raw input or dependency exception is returned or logged by the service. SQL constraints additionally restrict event/outcome/client/reason/correlation and metadata keys/shape/size; full value validation belongs to the service. Direct database writes require controlled access.

The service does not automatically connect login/MFA or Provider events. Successful insertion is not evidence that those event producers have run. Audit delivery policy on write failure, awaited hook ordering, retry/idempotency, retention and database access policy require owner/team review. Logout does not imply revocation. S1 integration against PR #27 was not rerun in this task; the old S1 report remains unchanged.

READY FOR REVIEW for the standalone S2 service. Full Issue #26 event coverage remains pending owner integration and its tests. No commit, push, PR, merge or Issue mutation was performed.

Private Git-ignored evidence is under `node_modules/s2-evidence/`: red.private.log, build-red.private.log, green.private.log, final-green.private.log and s1-before.json. Publish only sanitized aggregates, not runtime manifests or raw database logs.
