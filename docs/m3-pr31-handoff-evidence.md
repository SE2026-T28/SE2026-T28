# M3-AUTH PR #31 — Provider Handoff Failure Regression Evidence

## 1. Change under review

- **Base snapshot:** `874f52a03dcab18feb6597d87e5833343d80ab20`
- **Patch state:** Applied to the working tree; no new Git commit existed at the time of test execution.
- **Scope:**
  - `identity-server/src/mfa/interaction-handoff.ts`
  - `identity-server/test/mfa-service.test.ts`
  - `identity-server/README-M3-MFA.md`
  - `docs/m3-pr31-handoff-evidence.md`

## 2. Expected behavior

| Scenario | Expected result |
|---|---|
| MFA code is invalid | Provider completion callback is not called; verification returns `invalid`. |
| MFA is valid and Provider callback resolves | Verification returns success with the persisted user ID. |
| MFA is valid and Provider callback throws/rejects | Challenge remains `CONSUMED`; helper returns `interaction_failed` with `recovery: start_new_interaction`; Provider exception is not returned. |
| Consumed challenge is submitted again | Verification returns `invalid`; Provider callback is not called again. |
| User starts a new authorization interaction | A new challenge is created and can complete after fresh MFA verification. |

## 3. Regression tests added

`identity-server/test/mfa-service.test.ts` includes regression coverage for:

1. **Asynchronous Provider callback rejection**
   - Verifies that the challenge remains `CONSUMED`.
   - Verifies that `consumed_at` is persisted.
   - Verifies that the helper returns a safe `interaction_failed` result.
   - Verifies that the consumed challenge cannot be replayed.
   - Verifies that a new interaction with a new challenge can complete after fresh MFA verification.

2. **Synchronous Provider callback throw**
   - Verifies that the helper returns a safe restart result.
   - Verifies that the Provider callback is invoked only once.
   - Verifies that the challenge remains `CONSUMED`.

## 4. Verification performed

**Execution date:** 2026-11-22

**Command:**

```powershell
npm run test:isolated -- --driver=docker
```

**Results:**

| Check | Result | Evidence |
|---|---|---|
| TypeScript project build | PASS | `tsc -p tsconfig.json` completed successfully. |
| Database safety tests | PASS | 7 passed, 0 failed. |
| Prisma Client generation | PASS | Prisma Client 7.10.1 generated successfully. |
| Prisma migrations | PASS | Both migrations applied successfully. |
| Backend test suite | PASS | 76 passed, 0 failed, 0 skipped. |
| MFA regression tests | PASS | Handoff, callback failure, replay and challenge tests passed. |
| Concurrent fixture/registration suites | PASS | Both concurrent runs completed successfully. |
| Security header tests | PASS | 2 passed, 0 failed. |
| Docker isolation | PASS | Managed PostgreSQL identity verified. |
| Database cleanup | PASS | No remaining managed users; session revoked and owned instance stopped. |

### MFA regression test results

The following tests passed:

- `interaction handoff never finishes Provider before valid MFA`
- `rejected Provider handoff keeps MFA consumed and requires a new interaction`
- `synchronous Provider handoff throw is converted to a safe restart result`

Other MFA service tests also passed, including challenge hashing, interaction/browser binding, atomic consumption, replay prevention, expiry, cleanup and local/test-only demo-code restrictions.

### Final harness output

```text
tests 76
pass 76
fail 0
cancelled 0
skipped 0
todo 0
```

```text
S3 harness: remaining users=0; all managed stages PASS.
S3 harness: session revoked; owned instance stopped; runtime files remain Git-ignored.
```

**Verification status:** The isolated test harness completed successfully. No failed or skipped tests were reported.

## 5. Remaining integration boundary

The regression tests establish safe behavior of the MFA handoff helper. They do not independently establish complete MFA integration with the OIDC Provider.

The reviewed source snapshot still has the pre-MFA password-success path in `src/interactions/routes.ts`; the MFA handoff helper is not yet wired into the Provider interaction router.

The interaction-router owner must handle `interaction_failed` as a terminal interaction failure. The client must start a **new authorization interaction**, including password authentication and fresh MFA verification. A consumed challenge must never be reset or reused.

The following items remain incomplete or require separate evidence:

- Wiring MFA into the actual Provider interaction router.
- Proving that password success alone cannot complete an OIDC interaction or issue an OIDC authorization code.
- Provider HTTP-level failure and recovery behavior.
- End-to-end browser verification of the complete password → MFA → Provider flow.
- Complete MFA route cookie/CSRF integration.
- GitHub CI verification on the new commit.

Existing login, CSRF and security-header tests passing does not by itself prove the complete MFA browser integration.

## 6. Current status

| Area | Status |
|---|---|
| MFA handoff failure handling | PASS |
| Challenge consumption and replay protection | PASS |
| Regression tests | PASS |
| Isolated PostgreSQL test harness | PASS |
| TypeScript project build | PASS |
| Provider router integration | INCOMPLETE |
| Full MFA HTTP/E2E flow | NOT RUN |
| GitHub CI for updated commit | NOT RUN |
| Full M3 acceptance | PENDING |

**Conclusion:** The PR #31 handoff regression has been implemented and verified by the isolated test suite. The changes are ready for review. Full M3 acceptance remains pending Provider router integration, end-to-end verification and CI.

**Base commit:** `874f52a03dcab18feb6597d87e5833343d80ab20`

**New commit:** Pending.

**CI run:** Pending.