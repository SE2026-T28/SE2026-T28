import { Router } from "express";
import type { Request } from "express";
import type { Actor, ReviewStore } from "./review-store.js";

/** What beforeCommit is told, so a test hook can tell requests apart. */
export interface CommitContext {
  itemId: string;
  kind: "patch" | "decision";
  actorId: string;
}

export interface ReviewRouterOptions {
  store: ReviewStore;
  /** Role comes ONLY from here (never body/query). null/undefined -> 401. */
  resolveActor: (req: Request) => Actor | null | undefined | Promise<Actor | null | undefined>;
  /**
   * Test hook simulating I/O latency. Called (awaited) for both PATCH and
   * decision AFTER validation/idempotency reservation and BEFORE
   * store.compareAndSet. If it throws: 500 (no detail leaked), item
   * unchanged, idempotency reservation released.
   */
  beforeCommit?: (ctx: CommitContext) => void | Promise<void>;
  /** Injectable clock for decidedAt. Default: () => new Date(). */
  now?: () => Date;
}

/**
 * Mounted by tests at /review-items:
 *   GET    /:id            admin|reviewer -> 200 {item} + ETag "v<n>"
 *   PATCH  /:id            admin, If-Match required -> 200 {item} + ETag
 *   POST   /:id/decision   reviewer, Idempotency-Key + If-Match required,
 *                          body {decision:"approve"|"reject"} -> 200 {item}
 * SKELETON: answers 501 to everything.
 */
export function createReviewRouter(_options: ReviewRouterOptions): Router {
  const router = Router();
  router.use((_req, res) => {
    res.status(501).json({ error: "NOT_IMPLEMENTED" });
  });
  return router;
}
