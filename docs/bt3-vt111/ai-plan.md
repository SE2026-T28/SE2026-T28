## Prompt (verbatim)

```
You are a coding agent working on repository SE2026-T28 (APP-04 OIDC Identity Server + sample app), folder identity-server (TypeScript, Express 5, oidc-provider, Prisma). Change request: add a `reviewer` role that can read and approve data but must not modify original data. Main risk: race condition when two concurrent requests change the same resource. Before writing any code, produce an implementation plan: (1) assumptions you make about the repo, (2) the resource being reviewed and its state machine, (3) API endpoints with methods, status codes and auth rules, (4) concurrency/idempotency strategy, (5) exact files you will create or modify, (6) tests you will write first. Keep the slice small enough to finish in one PR and runnable without external services if possible.
```

## Assumptions

Skimmed app.ts, db/prisma.ts, users/user.routes.ts, prisma/schema.prisma, package.json, test/helpers.ts. Everything below is assumed unless noted.

1. Verified by skim: Express 5, ESM, Prisma 7 with the pg adapter, one `User` model (id, email, passwordHash, timestamps), one migration, `node --test` on compiled `dist/test/*.test.js`. `getPrisma()` is lazy and tests need a managed Postgres (`assertManagedDatabase`).
2. Not verified: no role or permission concept exists today. I assume no `role` column and no RBAC middleware.
3. Not verified: the API (non-OIDC) has no bearer-token or session authentication. Only `/api/users/register` exists. I assume I must add auth for new routes.
4. Assumption: "data" has no existing entity to review, so I introduce a small one (`Submission`). The change request is silent on this, so it is a guess.
5. Assumption: the reviewer identity comes from a verified access token (oidc-provider issues JWT or opaque tokens). I will not touch the OIDC flow. For this slice I add a `requireAuth` middleware behind an injectable `authenticate(req)` function, as `createApp` already does with `authenticateUser`, so tests can inject principals without a full OIDC round trip.
6. Assumption: roles are `user` and `reviewer`, stored on `User.role` (default `user`). A user has exactly one role, and role assignment is out of scope (seeded or set via SQL).
7. Assumption: Postgres is acceptable as a test dependency, since existing tests already require it. An in-memory repository interface lets the concurrency logic also be unit tested with no DB.
8. Assumption: the existing `/api/users` CORS and `express.json` ordering stays unchanged.

## Resource and state machine

Resource: `Submission` (id uuid, ownerId -> User, title, body, status, version int, reviewedById?, reviewedAt?, createdAt, updatedAt).

"Original data" = `title` and `body`. The reviewer may never change them. The reviewer only transitions `status`.

States: `DRAFT -> SUBMITTED -> APPROVED | REJECTED`.
- Owner: create (DRAFT), edit title/body only in DRAFT, submit (DRAFT -> SUBMITTED).
- Reviewer: approve or reject (SUBMITTED -> APPROVED/REJECTED). APPROVED and REJECTED are terminal.
- Any other transition returns 409.

## API

All routes are under `/api/submissions`, JSON, and require a bearer token (401 if missing or invalid).

| Method and path | Who | Success | Errors |
|---|---|---|---|
| POST `/` | user | 201 | 400 validation, 403 reviewer |
| GET `/` | user (own), reviewer (all) | 200 | 401 |
| GET `/:id` | owner or reviewer | 200 | 403, 404 |
| PATCH `/:id` (title, body, requires `If-Match: <version>`) | owner only | 200 | 403 (reviewer or non-owner), 409 not DRAFT, 412 stale version, 428 missing If-Match |
| POST `/:id/submit` | owner | 200 | 409 invalid state |
| POST `/:id/approve` | reviewer | 200 | 403, 404, 409 already decided |
| POST `/:id/reject` | reviewer | 200 | same |

The reviewer gets 403 on POST and PATCH of content. A non-owner gets 404 on `GET /:id` to avoid leaking existence (assumption, to confirm).

## Concurrency and idempotency

- Optimistic locking: `version` column. Every write is a single conditional statement, `UPDATE ... WHERE id=? AND status=<expected> AND version=<n> SET status=?, version=version+1`, via `updateMany` and a check of `count`. count=0 means re-read and answer 404, 409 or 412. There is no read-then-write in app code.
- Approve and reject race: the first writer wins through the `status='SUBMITTED'` predicate. The loser gets 409 with the current state.
- Owner PATCH against reviewer approve: the PATCH predicate requires `status='DRAFT'`, and approve requires `SUBMITTED`, so they cannot both succeed. Content is also frozen after submit, so a reviewer never approves content that later changes.
- Idempotency: repeating approve by the same reviewer on an APPROVED submission returns 200 with the same body (no-op), while a different decision returns 409. An optional `Idempotency-Key` header is out of scope for this PR.
- No DB-level locks needed beyond the single-row UPDATE atomicity of Postgres.

## Files to create or modify

Modify:
- `identity-server/prisma/schema.prisma` (add `Role` enum, `User.role`, `Submission` model, `SubmissionStatus` enum)
- `identity-server/src/app.ts` (mount `/api/submissions`, thread `authenticate` option)
- `identity-server/src/users/authentication.ts` (expose role in the principal lookup)
- `identity-server/package.json` (add `test:s5` script only if needed)
- `identity-server/README.md` (document endpoints)

Create:
- `identity-server/prisma/migrations/<ts>_add_roles_submissions/migration.sql`
- `identity-server/src/auth/require-auth.ts` (bearer auth middleware)
- `identity-server/src/auth/require-role.ts`
- `identity-server/src/submissions/submission.repository.ts` (interface plus Prisma and in-memory implementations)
- `identity-server/src/submissions/submission.service.ts` (state machine, guards)
- `identity-server/src/submissions/submission.routes.ts`
- `identity-server/test/submission-state.test.ts` (in-memory, no DB)
- `identity-server/test/submission-concurrency.test.ts`
- `identity-server/test/submission-authz.test.ts`

## Tests first

Written red before code:
1. State machine unit tests: valid and invalid transitions table.
2. Reviewer cannot PATCH, POST, or DELETE content (403), and the row is unchanged afterwards.
3. User cannot approve (403). Unauthenticated gets 401.
4. Concurrency: `Promise.all` of approve and reject on the same SUBMITTED row yields exactly one 200 and one 409, and the final status equals the winner's.
5. Concurrency: stale `If-Match` PATCH returns 412. Parallel PATCHes with the same version give one success and one 412.
6. PATCH racing approve: the final content is never changed after approval.
7. Idempotent repeat approve returns 200 with no version bump.

Tests 1, 4 and 7 run against the in-memory repository (no external service). The rest use the existing managed-Postgres harness.

## Open questions

- What is the actual thing the reviewer reviews? I invented `Submission`.
- How are API calls authenticated today: access token, session, or none?
- Can a reviewer also own submissions? Can an owner self-approve (I assume no)?
- Should 404 or 403 hide non-owned resources?
- Who assigns the reviewer role, and is an admin endpoint wanted?
- Does an audit log of decisions belong in this PR?
