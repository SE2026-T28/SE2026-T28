# BT3 – APP-04 – VT-113 – Part 5: Engineering Evidence & Reflection

Student 24002069 – SE2026-T28. Audit date: 2026-11-09 (Asia/Saigon).
Branch: `feat/vt113-user-search-test-first`; baseline HEAD `4c8e96e4c8eadb934be30a8efc220fa93919b60a`.
Implementation remains uncommitted. All implementation Commit/PR entries below are **pending**; baseline is not an implementation commit. No PR link is invented.

## A. Traceability matrix

Paths below are repository-relative. TC numbers identify acceptance assertions, not necessarily independent node:test cases: many security/issuance assertions are grouped into one scenario. Evidence is historical execution output, not a rerun during this audit.

Evidence keys:
- E52: `docs/vt113-performance-investigation/coalescing-green-suite.txt` (52 pass/0 fail/0 skip).
- E50: `docs/vt113-part4/final-coverage-suite.txt` (50 pass plus native coverage before count optimization).
- EM: `docs/vt113-part4/mutation-{baseline,red,restoration,green}.txt`.
- EP: `docs/vt113-performance-investigation/final-five-runs{.json,-log.txt,-cleanup.txt}`.
- EH: `docs/vt113-performance-investigation/headers.txt`.

| AC / Risk | Test ID | Test file : exact test name / assertion group | Implementation | Commit/PR | Execution evidence | Result and limit |
|---|---|---|---|---|---|---|
| Decimal validation, min/max, defaults, invalid syntax, duplicate/unknown, overflow | TC-03–07,17,19,21 | `identity-server/test/user-search-unit.test.ts`: `defaults, trimming and literal email`; generated `reject ${key}=${value}`, `reject duplicate ${key}`, `valid limit ${limit}`, `valid page ${page}`; `unknown key rejected`; `offset boundary and unsafe integers` | `src/users/search.ts`: parseSearchQuery | pending | E52 lists expanded test names | PASS for enumerated partitions; not all raw HTTP encodings |
| Literal substring, case-insensitive trim, no-match | TC-01,02,19,25 | `identity-server/test/user-search-postgres.test.ts`: `PostgreSQL literal filter, stable ordering, pagination and projection`; unit `no filter, backslash literal and direct service validation` | `src/users/search.ts`: escaped contains + insensitive | pending | E52; actual PostgreSQL fixtures | PASS; Unicode collation not exhaustive |
| Stable createdAt DESC / id ASC, ties across pages | TC-09 | same PostgreSQL test: exact expected ID slices | `src/users/search.ts`: orderBy | pending | E52 | PASS on unchanged fixture; not snapshot stability under writes |
| Defaults, total/totalPages, 10/1/0 page sizes, beyond last | TC-02,03,08,20 | PostgreSQL test above; `empty and beyond-last pages`; `service query contract, pagination and projection` | `src/users/search.ts` | pending | E52 | PASS; concurrent count/data consistency not promised |
| Public fields, passwordHash omission | TC-13,20 | PostgreSQL test above; `identity-server/test/user-search-http.test.ts`: `search HTTP uses real provider tokens and fails closed` | `src/users/search.ts`: select and explicit projection | pending | E52 | PASS; HTTP scenario uses repository double, PostgreSQL scenario uses real DB |
| 401/403, exact scope, client/audience, expiry, ID-token confusion, no search DB before auth | TC-10–13,18,22 | HTTP test above; `TC-12: insufficient scope must not access search` assertion | `src/users/search.routes.ts`; `src/app.ts`: extraTokenClaims | pending | E52, EM | PASS for tested cases. Wrong client/audience model issuance is rejected; those assertions do not independently prove every forged-storage route case |
| Real OAuth code+S256, credential login, CSRF form, explicit consent, resource token, eligibility revocation, old grant | TC-12,13,22; issuance extension | `identity-server/test/user-search-issuance.test.ts`: `real PKCE issuance and old-grant eligibility` | `src/app.ts`, `src/config.ts`, `src/interactions/routes.ts`, `src/users/authentication.ts`, `email.ts`, `login-page.ts` | pending | E52; original RED only reconstructed from conversation and issuance narrative | PASS with PostgreSQL and real token endpoint. Unregistered-client negative is not a registered-but-disallowed-client flow |
| Registration API and OIDC backward compatibility | TC-15,16 | `identity-server/test/registration.test.ts`: `đăng ký thành công, lưu Argon2id và không trả password hash`, `từ chối email trùng, không phân biệt chữ hoa/thường`, invalid input/password, concurrent-email and CORS cases; issuance test legacy openid/email and /me | Existing registration/user routes preserved; `src/app.ts` wiring | pending | E52; EH | PASS tested status/response/CORS/legacy flow; not every historical client contract |
| Discovery, health, headers | TC-16,26 partial | `identity-server/test/discovery.test.ts`: `Discovery publishes the agreed issuer and public-client endpoints`; `security-headers.test.ts`: `Integrated registration and health routes keep S4 headers and A1 CORS` | `src/app.ts`, existing `src/security/headers.ts` | pending | E52, EH | PASS. Browser Search preflight remains a gap |
| count/findMany failure; safe HTTP500 | TC-14 | `database failures propagate for future HTTP boundary` in unit file; HTTP scenario injected count error + no SECRET in response | `src/users/search.ts`, `src/users/search.routes.ts` | pending | E52 | PASS for injection. Real driver/storage outage and separate HTTP findMany-failure branch not proven |
| Scope-check mutation | TC-12 / mutation | HTTP scenario assertion expects 403 with valid query and insufficient scope | `src/users/search.routes.ts`: only scope predicate temporarily removed | pending | EM: mutant actual200 vs expected403; byte-identical restoration | MUTANT KILLED; restored targeted + full suite PASS; not a broad mutation score |
| Repeated-count optimization correctness | Optimization extension | unit: `concurrent identical counts are coalesced only while in flight`; `count coalescing isolates repositories, filters and rejected promises` | `src/users/search.ts`: pendingCounts WeakMap | pending | `coalescing-red.txt`: 8 vs1; E52 | RED→GREEN; no completed-result cache; overlapping requests share count snapshot |
| 80 workers, p95<=2.5s | TC-24 | `identity-server/test/user-search.optimized-run.mjs` executable harness, not node:test name; final confirmation used temporary five-run variant | Entire HTTP/provider/search/Prisma path | pending | original Part4 performance.json (FAIL); optimized-benchmark.json (3 PASS); EP (5 PASS) | Final 5 runs p95 2245.901/2142.292/2164.694/2273.527/1972.095ms, errors0/10000; local repeated-filter workload only |

Implementation paths abbreviated `src/...` above are under `identity-server/`.

## B. AI usage log (actual provenance)

Only one Codex coding agent is evidenced; no subagents were used. Model identity/version is not recorded, so none is claimed. Prompts below are user-provided task titles or summarized objectives, not invented verbatim transcripts. Tool-call history is in this chat; no separate complete prompt transcript has been exported to the repository.

| Tool / agent | Actual prompt / objective | Output used | Review / correction / rejection | Verification and provenance |
|---|---|---|---|---|
| Codex + PowerShell/Git | Part1 read-only plan | Source-based plan and risk assumptions | Initial workspace was wrong/bare; stopped rather than invent files; user supplied correct checkout | Conversation only for initial plan; current Git/source corroborates baseline |
| Codex + source/browser inspection | Authorization feasibility/integration readiness | Opaque token lookup and resource/eligibility design | Did not treat Discovery or ID-token verification as access-token authorization; no fake verifier added | Conversation tool output + dependency/source; current app/routes |
| Codex + node:test | Part3A RED→GREEN | Parser/service and unit tests | Initial @ts-ignore/.ts import was removed; .js convention restored; compiled build validated | Original 33 RED is conversation only; later saved E52 and source verify current implementation |
| Codex + winget/npm | Node/PostgreSQL environment setup | Official installers, lockfile install, isolated DB | UAC handled by user; broader PUBLIC CONNECT revocation rejected by auto-review and never executed; safer DB/role-only setup used | Conversation tool outputs; persisted cleanup/isolation outputs corroborate actual DB; no installer prompt transcript in repo |
| Codex + provider models / HTTP tests | Part3B route + real verifier | HTTP tests with provider-created tokens | 42 tests were explicitly an incomplete milestone, not proof of OAuth issuance. Model fixture using clientId override was corrected to a real Client model | Conversation for early RED404→401 and fixture correction; current test + E52 |
| Codex + selected team source | Complete OIDC issuance verification | Four source files reused from team snapshot 43ccc619f14542468e642eb88f5231c9c764f655, plus BTCN guards | Default-deny account eligibility, consent and issuance enforcement added; no schema/PR merge | `vt113-issuance-evidence.md`, E52; source attribution required. Do not claim reused code as solely student-authored |
| Codex + deliberate mutation | Part4 Who Tests the Tests | TC-12 valid-query assertion and scope-only mutation experiment | Original invalid-page combination could mask authorization defect; added direct assertion before baseline; restored exact bytes | Saved EM, SHA restoration record and current route hash |
| Codex + native coverage | Part4 coverage | Application JS line/branch report | Rejected percentage-only security conclusions; uncovered auth/interaction/error branches recorded | E50; historical 50-test snapshot, not recomputed after optimization |
| Codex + port/clock experiments | Flaky-test review | Dynamic bound socket, finally clock reset | Fixed port15539 reproduced EADDRINUSE before changing test | `flaky-port-red.txt`, `flaky-green.txt`, current issuance test |
| Codex + performance/profiling harnesses | Performance investigation/optimization | Pool-wait measurements, plans, in-flight count coalescing | Initial driver timing had broken async attribution and was rejected; no blind pool increase/index/dependency change | profile JSONs, red/green coalescing logs, original and optimized benchmarks |
| Codex + unchanged harness temporary variant | Final Performance Confirmation | Five-run results and cleanup | Same workload retained, no build/tests/profiling concurrently; no source edits | EP; script was temporary outside repo, so exact invocation provenance also relies on chat |
| Codex + read-only audit/document authoring | Part5 | This document, audit JSON and exact file inventory | Separates recorded evidence from reconstructed history; identifies stale metadata rather than rewriting historical results | Part5 audit artifacts; no tests rerun in this stage |

## C. AI output that was not immediately trustworthy

### 1. Token-model HTTP tests were not issuance evidence

The earlier milestone reported 42 passing tests using `new provider.AccessToken(...).save()` and a real verifier. This establishes storage/lookup/route behavior, but does not exercise authorization code, PKCE, credential authentication or consent. The report itself marked issuance incomplete; it would be incorrect to upgrade that result into an end-to-end security claim. Verification later used a database account, real login forms/CSRF, explicit consent and token endpoint exchange. Initial issuance returned invalid_target (conversation RED); current issuance integration passes in E52 and checks old-grant revocation. No evidence shows that a fake verifier was implemented, so this log does not claim one was rejected from actual code.

### 2. AI-generated import workaround bypassed compiler feedback

The initial unit test used `@ts-ignore` and imported `.ts` so native Node strip-types could run without dependencies. Passing those tests did not prove compatibility with the repository's NodeNext emit/run convention. Verification found that the suppression could leave an emitted .ts import pointing outside dist. The import was changed to `.js`, suppression removed, and the suite was executed through compiled JavaScript after installing the approved environment. Original workaround/correction are recoverable from conversation, not an immutable intermediate commit. Current source and build/test records support the corrected state.

### 3. Performance hypotheses and first profiler output were insufficient

Original run1 p95=2327.653ms passed, but runs2/3 were 2524.334/2771.041ms. The overall baseline was correctly marked false; a single-run conclusion would have been wrong. Pool10 contention was initially only a hypothesis. First instrumentation then showed impossible-looking driver p95=0 for most requests because callback context was lost. That capture is retained as incomplete, not used as authoritative. Corrected profiling measured mean pool wait1726.436ms of mean HTTP1980.807ms; plans exposed scans. COUNT coalescing was regression-tested before implementation, then three optimized and five confirmation runs were retained. Improvement is measured, not a universal production SLA claim.

## D. Reflection (student-review draft; English, 250–350 words)

My confidence in this API increased when evidence crossed boundaries that mocks could not cover. Parser tests established decimal syntax and pagination limits, but PostgreSQL fixtures were needed to verify literal substring filtering, timestamp ties, and public projection. The decisive authorization evidence came from a real authorization-code exchange with S256 PKCE, credential login, explicit consent, and a resource-bound token calling Search.

RED and GREEN mattered because failure causes were inspected. A missing resource configuration produced invalid_target, while the count optimization regression observed eight database calls instead of one. Neither failure was dismissed as an environment problem. The mutation experiment was stronger evidence than coverage alone: removing only the scope check changed the response from the expected 403 to 200. Restoring identical source bytes and rerunning the suite demonstrated that the submitted path retained authorization.

Performance required a different kind of skepticism. At 80 concurrent workers, the original three runs did not consistently satisfy p95 below 2.5 seconds. Profiling identified substantial pool acquisition wait, but an initial instrumentation bug also showed that measurement code needs review. Sharing only unfinished identical count queries reduced duplicated work without caching completed results. Five subsequent confirmation runs met the target with no errors, although the earlier optimized run barely passed.

Several claims remain unproven. The benchmark uses repeated filters, warm caches, and one machine for client, server, and database. It does not establish behavior with mostly unique filters or larger datasets. Consent and token storage remain development infrastructure; browser preflight and several authentication failure paths lack complete coverage. Shared counts also do not create a transaction-consistent snapshot across pagination.

The next highest-value test would revoke account eligibility after an authorization code is issued but before token exchange, then assert that no privileged token is returned. That directly probes a security boundary not isolated by the existing old-grant scenario.

## E. Evidence audit and residual risks

Audit is document/source inspection, not a new test run. Full JSONs were parsed; summary/log equality was checked separately in `vt113-part5-audit.json`.

| Required evidence | Audit outcome |
|---|---|
| `docs/vt113-issuance-evidence.md` | Read. 50-test result is historical; fixed-port15539 limitation is stale after Part4 dynamic-port fix. Original issuance RED has narrative/chat provenance, not a standalone preserved RED log |
| `docs/vt113-part4/notes.md` | Read. Historical failure and 50-test coverage snapshot match stage. Its “no production logic changed in Part4” applies to original mutation/coverage/flaky stage, not later performance optimization |
| `docs/vt113-part4/performance.json` | Read/parsed: three runs, false; original failures retained |
| `docs/vt113-performance-investigation/notes.md` | Read. Corrected profile distinction and overlapping build job disclosed; initial plan times differ from authoritative corrected capture. Not a clean standalone benchmark replacement |
| `.../profile-baseline.json` | Read/parsed. protocol.measuredRuns=3 is inaccurate metadata: actual runs array has ONE measured run. 2400 samples include warmup400 + measured2000. Use actual array length; corrected plans count2.556/deep9.229/filter162.567ms |
| `.../optimized-benchmark.json` | Read/parsed: three runs pass; run2 margin only0.189ms; run1 tail worsened versus original |
| `.../final-five-runs.json` | Read/parsed: five runs x2000, 80 workers,10000 rows,400 warmup; all p95<=2500ms, zero errors |
| `.../final-five-runs-log.txt` | Read; per-run numerical fields match JSON exactly |
| `.../final-five-runs-cleanup.txt` | Read; correct isolated DB/user/address/port, zero rows/fixtures, expected PostgreSQL settings |

Additional limitations: latest saved functional suite has52 tests; coverage percentages remain the earlier50-test compiled-JS snapshot. Benchmark tokens are provider-model issued (not hardcoded); OAuth issuance is verified separately, not load-tested. Default-deny is BTCN policy, not team-approved production entitlement design. Unknown-client flow is not proof for a second registered client. CSRF/rate-limit negatives, provider outage, raw duplicate headers, Unicode collation, Search browser preflight and count/data concurrent-write consistency remain incomplete. The claim “tests passed” covers named assertions, not every designed TC subcase.

No source/test was changed in Part5. Historical evidence is preserved, including failed and invalidated measurements. No commit/PR exists for these changes. Current source is not cryptographically mapped to an implementation commit; saved execution results and source inspection are the available linkage.

## F. Git inventory and proposed commit boundary

See `vt113-part5-file-inventory.md` for the exact path-by-path inventory, and `vt113-part5-audit.json` for automated checks. Propose including the two modified tracked files and explicitly listed VT-113 implementation/tests/harness/evidence/docs; do not stage broad directories blindly. Reused team source must retain attribution. Do not include node_modules, dist, .env, installer files, temporary runners, PostgreSQL data or `%LOCALAPPDATA%/VT113` secrets.

The sensitive-pattern scan checks changed/untracked text files for credential-bearing PostgreSQL URLs, private-key blocks and common token formats, reporting only path/line identifiers. A clean scan is bounded evidence, not a guarantee of absence of secrets. Local usernames/paths and machine metadata remain in logs and should be considered before public sharing.

No staging, commit, push, PR, main edit, schema/migration/dependency change or group PR merge is performed in Part5. Reflection is a draft for the student's review and ownership, not evidence that the student personally performed every AI-assisted operation.
## Post-audit provenance update: raw-log whitespace normalization

After explicit repository-owner approval, exactly eight raw evidence logs were normalized: only trailing spaces/tabs and surplus EOF blank lines were removed, retaining one final newline. Total removed: **82 whitespace bytes**. Non-whitespace content, line order, test/error messages and numerical results were preserved; encoding and **CRLF** were retained. Files are no longer byte-identical to their pre-normalization originals.

`vt113-part5-audit.json` now records current and historical SHA-256, byte counts and per-file changes under `rawEvidenceWhitespaceNormalization` for all eight files. Its existing nine-file required-evidence manifest remains nine entries; the cleanup-log entry has its current hash/size plus historical hash/size. Historical references to raw byte preservation describe the earlier audit stage, not an assertion that normalized logs still have the old hashes. Hashes refer to CRLF working-tree bytes, not Git's potentially LF-normalized blobs.

No tests or benchmarks were rerun for this formatting/provenance update. Test, coverage, mutation and performance numbers and the reflection remain unchanged. No evidence log was edited during this provenance update. This update is not staged, committed or pushed.
