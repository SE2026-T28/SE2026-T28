# AI review of patch (D5) — raw output, verbatim

- Tool: Claude Code subagent `caveman:cavecrew-reviewer` (model: Sonnet), read-only.
- When: after tests ran green (`evidence/02-green.log`, 20/20 x3).
- Patch reviewed: `git diff 18d8929 e9b8afd` (`identity-server/src/review/review-store.ts`, `review.routes.ts`).
- Prompt (verbatim, abridged context paths): "Review a patch ... Read-only ... Patch = `git diff 18d8929 e9b8afd` ... Context: tests already ran and pass — see `docs/bt3-vt111/evidence/02-green.log`; tests in `identity-server/test/review-*.ts`; intended contract in `docs/bt3-vt111/spec.md`. Feature: reviewer role reads and approves/rejects items but must not modify data; optimistic concurrency via If-Match/version CAS; Idempotency-Key for decisions. Review for correctness, security, concurrency (races across await), idempotency semantics, error handling, test gaps. Give 6-12 findings, each: `path:line: severity: problem. suggested fix.` plus for each a one-line "evidence:" ... Do not soften; flag also things you suspect but cannot confirm."

Classification of each comment (correct / not enough evidence / rejected) is in `ai-review-verdicts.md`, based on executed checks — not on the AI's own confidence.

---

**R1** identity-server/src/review/review-store.ts:60: 🟡 risk: `idem` Map never evicted. Every successful decision keeps a full cloned response forever; no TTL, no size cap, no pruning. Add TTL/LRU bound on completed records (and key length cap).
evidence: line 60 `private readonly idem = new Map<string, IdemRecord>()`; only deletes are in `release()` (line ~111); `complete()` (105) never expires anything. No test covers growth or expiry.

**R2** identity-server/src/review/review.routes.ts:56: 🟡 risk: `guard` wraps `next()` inside its `try`. A synchronous throw from the downstream handler is caught here and turned into 500 for the wrong layer. If the downstream already sent a response, `send(res,500)` in the catch throws ERR_HTTP_HEADERS_SENT inside an async fn, causing an unhandled rejection. Call `next()` outside the try and let Express error middleware handle downstream errors.
evidence: lines 50-58, `try { const actor = await resolveActor(req); ... next(); } catch { send(res, 500, ...) }`. GET handler (62-66) is synchronous and has no try, so its throws land here. Confidence medium; no test covers guard-caught downstream throws.

**R3** identity-server/src/review/review.routes.ts:73: 🟡 bug/risk: `asString` silently drops non-string `title`/`body`. `PATCH {title: 123, body: "x"}` returns 200 and changes only body. No empty-string or length check either, so `title: ""` and multi-MB strings are accepted. Return 400 when a field is present but not a string, and add min/max length.
evidence: lines 73-74 `asString(req.body?.title)` returns undefined for non-strings; line 75 only 400s when BOTH are undefined. No PATCH test in review-concurrency/authz/store covers invalid types.

**R4** identity-server/src/review/review.routes.ts:76: 🟡 risk: PATCH calls `beforeCommit` before the version check, so stale-If-Match requests still run the hook's side effects, then get 412. Spec §4 calls the hook "simulating I/O latency", but in production this slot is where a real write would go. Move any side-effecting work after CAS, or make the hook explicitly side-effect-free and document it. Suspicion: cannot confirm what a real hook does (see docs/bt3-vt111/spec.md §4).
evidence: line 76 `await beforeCommit?.(...)` precedes `store.compareAndSet` at 78. TC-10 (concurrency test, line 46) asserts item state only, not hook invocation count.

**R5** identity-server/src/review/review.routes.ts:89: ❓ question: any reviewer can decide any pending item. Authz is role-only (`guard("reviewer")`), with no item assignment or ownership check. Confirm intent. If assignment is required, the check belongs before `reserve` (line 105) so it doesn't burn an idempotency key.
evidence: line 89 `guard("reviewer")`; no item-level check in the handler (lines 89-136). Authz tests (review-authz.test.ts TC-05) use one reviewer with no assignment concept.

**R6** identity-server/src/review/review.routes.ts:105: 🟡 bug (semantics): fingerprint `JSON.stringify([id, decision, ifMatch])` includes If-Match. A legit retry with the same Idempotency-Key after the client refetched the ETag (v2, because the first request already committed) gets 422 IDEMPOTENCY_KEY_REUSED instead of the stored 200. Remove `ifMatch` from the fingerprint, since If-Match is a precondition and not request identity. Confirm against spec §4 retry wording ("retry cùng Idempotency-Key ... nhận lại response đã lưu").
evidence: line 105 fingerprint construction; TC-13 (store test, line 95) only tests different decision and different item for 422. No test for same key + different If-Match.

**R7** identity-server/src/review/review.routes.ts:106: 🟡 bug (contract): replay path sends the stored response without ETag. The original 200 (line 131) sets `ETag: "v<n>"` via `send(..., r.item)`, but line 106 calls `send(res, status, body)` with no item, so the header is dropped. A client that uses ETag for the next PATCH/decision after a retry gets none. Store the item version and re-set ETag on replay.
evidence: line 106 `return send(res, rsv.response.status, rsv.response.body);`. `send` (line ~40) sets ETag only when `item` is passed. TC-12 (concurrency test, line 81) checks body equality only, not headers.

**R8** identity-server/src/review/review.routes.ts:112: 🟡 test gap: `fail()` releases the reservation on 412/409/404, and the claim "key stays usable" is untested. A same-key retry after a 412 or 409 should reserve as `new` and re-check state. If the release is wrong, retries return stale 412/409 forever. Add tests: 412 then same key with fresh If-Match -> 200; 409 ALREADY_DECIDED then same key -> does not reserve as in-flight.
evidence: line 112 `store.release(actorId, key)`. Concurrency test list (review-concurrency.test.ts TC-08..TC-15) and store test TC-18 cover release only for the beforeCommit-throws path (TC-15, line 146). No test for release on the 412/409 paths.

**R9** identity-server/src/review/review.routes.ts:121: 🟡 risk: in-flight reservation has no lease or timeout. If `beforeCommit` never resolves, the reservation stays `in-flight` (store `response === undefined`) and every retry with that key gets 409 REQUEST_IN_FLIGHT forever. The process has no way to unstick the key without restart. Add a timeout around `beforeCommit` that releases the reservation, or an expiry on in-flight records.
evidence: line 121 `await beforeCommit?.(...)` with no timeout; store `reserve()` returns `in-flight` while `rec.response === undefined` (store line ~101). TC-14 (concurrency test, line 113) only covers completed-then-replayed.

**R10** identity-server/src/review/review.routes.ts:135: 🟡 risk: error handling is silent. Every `catch` (lines 58, 85, 135) returns 500 `INTERNAL` with no log, so a failing `beforeCommit`, store exception, or serialization error cannot be diagnosed. Log the error server-side (not in response) before `send`.
evidence: line 135 `catch { if (reserved && key) store.release(...); send(res, 500, { error: "INTERNAL" }); }` has no logging. Same pattern at lines 58 and 85. TC-15 (line 146) asserts 500 body shape only.

totals: 0🔴 9🟡 1❓

Test-suite note (AI): the green log (docs/bt3-vt111/evidence/02-green.log) shows 20/20 pass x3, which confirms the listed tests, not the gaps above. Gaps are untested paths, not failing ones.
