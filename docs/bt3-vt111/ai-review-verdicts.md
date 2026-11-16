# AI review verdicts (R1..R10) — classified by executed probes

Probes: scratch file `identity-server/test/review-probe.test.ts` (deleted after run) against HEAD 13a11e9 on Node v24.22.0. Raw probe output in the session scratchpad; the R7 fix has its own red/green log `evidence/08-ai-review-fix.log`.

| R# | AI claim (short) | Probe / command | Observed result | Verdict | Action |
|---|---|---|---|---|---|
| R1 | `idem` Map never evicted | 50 successful decisions on 50 items, count `store.idem.size` | size = 50, no eviction exists | CORRECT (unbounded growth reproduced; impact is by design for an in-memory test slice, spec §1 out of scope: persistence) | Backlog: TTL/LRU when moved to real storage |
| R2 | `next()` inside `try` -> downstream throw caught, 500 for wrong layer; ERR_HTTP_HEADERS_SENT -> unhandled rejection | (a) `store.get` throws in sync GET; (b) wrap `res.json` to throw after send; listen for `unhandledRejection` | (a) Express default HTML 500, NOT guard's JSON `INTERNAL` (guard catch not hit); (b) client got 200; unhandledRejections = [] | REJECTED (Express 5 Layer catches handler errors; `next()` does not throw into guard) | None |
| R3 | PATCH `{title:123, body:"x"}` -> 200, no length/empty check | PATCH that body; `title:""`; 50 KB body | 200 with data `{title:"T", body:"x"}`; `title:""` 200; 50 KB 200 | CORRECT | Backlog: 400 on non-string present field, length limits (spec has no validation AC) |
| R4 | `beforeCommit` runs before version check on stale PATCH | count hook calls on stale-If-Match PATCH | status 412, hook calls = 1 | CORRECT as observation; DESIGN TRADE-OFF (spec §4: hook simulates I/O latency, guard must live in CAS not in read) | Backlog: document hook must be side-effect-free; real write slot belongs after CAS |
| R5 | any reviewer decides any item | reviewer-2 decides item with no assignment | 200 | DESIGN TRADE-OFF (spec §1/§2: role-based only, no assignment concept) | Question for product owner |
| R6 | fingerprint includes If-Match -> same key + refreshed ETag gets 422 | approve k/v1 -> 200, then k/"v2" | 200 then 422 `IDEMPOTENCY_KEY_REUSED` | REJECTED as bug: reproduced behavior is exactly spec AC5 ("fingerprint = itemId + decision + If-Match", different fingerprint -> 422) | None; trade-off noted, changing it needs a spec change |
| R7 | replay drops ETag | decide twice with same key; compare `ETag` | original `"v2"`; replay `W/"98-39ePR..."` (Express auto weak ETag of body, not the item version) | CORRECT (claim slightly off: header present but wrong/weak, not missing) | Fixed: TC-19 red then green |
| R8 | release on 412/409 untested | 412 then same key + fresh If-Match; 409 then same key again | 412 -> 200 (`ETag "v3"`); 409 -> 409 again (item really decided, fresh state re-checked, key not stuck in-flight) | NOT A DEFECT; test gap real | Added TC-20 (passed immediately, characterization) |
| R9 | hung `beforeCommit` -> 409 forever | hook never resolves; client aborts; 3 retries same key | 409, 409, 409 | CORRECT (no lease/timeout) | Backlog: timeout/lease on in-flight; spec §4 only promises release on throw |
| R10 | 500 paths silent, no logging | hook throws; spy console.error/warn | 500 `INTERNAL`, 0 lines logged | CORRECT (observability gap; no secret leaked, matches TC-15 intent) | Backlog: server-side logging |

## Ít nhất một nhận xét đúng

- **R7** — clearest: reproduced with a header diff (`"v2"` vs `W/"98-39ePR..."`), has a red test and a minimal fix (store `etag` in `StoredResponse`, restore on replay). AI said "dropped"; real defect is a wrong weak ETag, so a client doing If-Match with it would always get 412.
- **R9** — reproduced: three retries all 409 after the client aborted a hung hook. Residual risk, not fixed (out of the asked scope).
- R3, R1, R10 also reproduced; kept as backlog.

## Nhận xét không đủ evidence / bị bác

- **R2** — REJECTED by reproduction: neither a sync downstream throw nor a throw after headers sent reaches the guard's catch, no unhandled rejection. The AI's own "confidence medium" was the honest part; the claim rested on not knowing Express 5 semantics.
- **R6** — REJECTED: contradicts spec AC5, which defines the fingerprint including If-Match.
- **R4 / R5** — true observations but spec-intended; what would turn them into defects is evidence of a production `beforeCommit` with side effects (R4) or an assignment requirement from the product owner (R5). Neither exists in the repo.

## Residual risks / backlog (not fixed here)

R1 unbounded idempotency store; R3 input validation; R4 hook side effects; R9 in-flight lease; R10 server-side logging; R5 assignment question.
