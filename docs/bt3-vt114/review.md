# AI-assisted change review and evidence notes

The coding agent proposed a small TaskStore, HTTP route, demo page and tests after the plan review. I inspected `git diff` before accepting the patch. The first implementation failed TypeScript's discriminated-union check in `routes.ts` because `SubmitResult` was not narrowed before reading `result.task`; I changed the handler to branch on `kind === "accepted"`, rebuilt, then ran tests. This is evidence that plausible generated code still needs compile and review.

Two code/test claims that looked plausible but are not fully trustworthy:

1. A map set before `queueMicrotask` prevents duplicate task creation during concurrent requests **in one Node process**. It does not survive restart or coordinate multiple instances. A production design needs a database unique key plus durable worker/outbox, and a user/tenant scope for the key.
2. `onComplete` is called once by this store and T03b detects duplicate invocation. If an external notification or transaction succeeds but its acknowledgment throws, the status may become `failed` even though the effect happened. Exactly-once external effects require an idempotent downstream contract or transactionally stored outbox; this test cannot establish that.

Risk coverage by AC: AC1 T01/load; AC2 T02/T09/T10/browser; AC3 T03/T03b and pairwise retries; AC4 T04–T08/T08b and pairwise failure. Negative cases include missing/short key, units 0/6, payload mismatch, unknown ID. Failure path injects `failAt=2`, checks terminal `failed`, same-key retry and zero completion callbacks.

Mutation: local branch `experiment/vt114-boundary-mutation`, commit `23e0080`, changes `workUnits > 5` to `workUnits >= 5` in `src/tasks/routes.ts`. T06 expects 202 at boundary 5; mutant returned 400 and failed. The submitted branch retains `>`, and T06 passes.

Coverage from Node 24's built-in tool on the slice: `tasks/routes.js` 98.67% lines / 85.71% branches; `tasks/store.js` 100% lines / 92.59% branches. Uncovered branches include capacity overflow and some malformed input paths. The callback-throw path is exercised by T08c. Overall coverage includes unrelated OIDC/Registration modules and is not a quality verdict.

Flaky risks checked: (1) time—tests poll terminal status with a 3-second deadline and assert monotonic progress instead of sleeping an exact interval; (2) order/shared state—test keys are unique per case and each test file process gets its own `createApp` store, while the stale `dist` incident showed that generated output must be cleaned across branches. Random task IDs are compared for equality/uniqueness, never to a fixed value. The 200-task p95 is environment-specific and should be rerun on CI or a target deployment.
