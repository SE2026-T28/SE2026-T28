# AI patch prompt (C2, verbatim)

IMPLEMENTATION PROMPT
Implement the reviewer-role slice so the existing failing tests pass, with the smallest understandable patch.
Read: `docs/bt3-vt111/spec.md` (contract, check order, decision table), `docs/bt3-vt111/evidence/01-red.log`, tests `identity-server/test/review-*.ts` (source of truth — DO NOT modify tests), skeleton `identity-server/src/review/review-store.ts` and `review.routes.ts` (keep exported signatures).
Rules:
- Only edit files in `identity-server/src/review/` (you may add `review-service.ts` if it keeps routes thin). Do not mount the router in `src/app.ts`.
- Concurrency guard: `compareAndSet` checks `expectedVersion === current.version` and writes in one synchronous block (no await inside). Idempotency `reserve` is synchronous and must happen before the first await in a request. No locks/timers/sleeps.
- Deny by default: unknown role -> 403; null actor -> 401. Reviewer never changes `data`; decision only sets status/decidedBy/decidedAt and version+1.
- Errors: unexpected throw in `beforeCommit` -> release idempotency key, no write, respond 500 `{error:'INTERNAL'}` without leaking the message. Never log tokens/headers.
- Keep it small (target < 250 lines total in src/review), comment the non-obvious parts (why CAS is synchronous, why key reserved before await).
END PROMPT
