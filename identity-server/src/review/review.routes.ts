import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Actor, ReviewItem, ReviewStore, Role } from "./review-store.js";

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

/** Thrown from a compareAndSet mutate to abort the write when the item was decided meanwhile. */
class AlreadyDecided extends Error {}

/**
 * Mounted by tests at /review-items:
 *   GET    /:id            admin|reviewer -> 200 {item} + ETag "v<n>"
 *   PATCH  /:id            admin, If-Match required, pending items only (decided -> 409) -> 200 {item} + ETag
 *   POST   /:id/decision   reviewer, Idempotency-Key + If-Match required,
 *                          body {decision:"approve"|"reject"} -> 200 {item}
 * Check order for POST: see docs/bt3-vt111/spec.md section 4.
 */
export function createReviewRouter(options: ReviewRouterOptions): Router {
  const { store, resolveActor, beforeCommit } = options;
  const now = options.now ?? (() => new Date());
  const router = Router();

  const send = (res: Response, status: number, body: unknown, item?: ReviewItem) => {
    if (item) res.set("ETag", `"v${item.version}"`);
    res.status(status).json(body);
  };
  /** If-Match `"v<n>"` -> n; anything unparsable becomes NaN and never matches (-> 412). */
  const parseVersion = (h: string) => Number(/^"v(\d+)"$/.exec(h)?.[1] ?? NaN);
  const idOf = (req: Request) => String(req.params.id);
  const asString = (v: unknown) => (typeof v === "string" ? v : undefined);

  // Deny by default: only roles listed for the route pass. Role comes only from resolveActor.
  const guard = (...allowed: Role[]) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) return send(res, 401, { error: "UNAUTHENTICATED" });
      if (!allowed.includes(actor.role)) return send(res, 403, { error: "FORBIDDEN" });
      res.locals.actor = actor;
      next();
    } catch {
      send(res, 500, { error: "INTERNAL" });
    }
  };

  router.get("/:id", guard("admin", "reviewer"), (req, res) => {
    const item = store.get(idOf(req));
    if (!item) return send(res, 404, { error: "NOT_FOUND" });
    send(res, 200, { item }, item);
  });

  router.patch("/:id", guard("admin"), async (req, res) => {
    try {
      if (!store.get(idOf(req))) return send(res, 404, { error: "NOT_FOUND" });
      const ifMatch = req.get("if-match");
      if (ifMatch === undefined) return send(res, 428, { error: "PRECONDITION_REQUIRED" });
      const title = asString(req.body?.title);
      const body = asString(req.body?.body);
      if (title === undefined && body === undefined) return send(res, 400, { error: "INVALID_BODY" });
      // Same order as the decision route: stale version -> 412, then decided -> 409 (decided data is frozen).
      const current = store.get(idOf(req));
      if (!current) return send(res, 404, { error: "NOT_FOUND" });
      if (current.version !== parseVersion(ifMatch)) return send(res, 412, { error: "VERSION_CONFLICT" });
      if (current.status !== "pending") return send(res, 409, { error: "ALREADY_DECIDED" });
      await beforeCommit?.({ itemId: idOf(req), kind: "patch", actorId: res.locals.actor.id });
      // Version and status cannot be trusted above: the await lets others commit (e.g. a decision).
      // Both are re-checked synchronously inside compareAndSet; throwing from mutate aborts the write.
      const r = store.compareAndSet(idOf(req), parseVersion(ifMatch), (d) => {
        if (d.status !== "pending") throw new AlreadyDecided();
        if (title !== undefined) d.data.title = title;
        if (body !== undefined) d.data.body = body;
      });
      if (!r.ok) return r.reason === "conflict" ? send(res, 412, { error: "VERSION_CONFLICT" }) : send(res, 404, { error: "NOT_FOUND" });
      send(res, 200, { item: r.item }, r.item);
    } catch (e) {
      if (e instanceof AlreadyDecided) return send(res, 409, { error: "ALREADY_DECIDED" });
      send(res, 500, { error: "INTERNAL" });
    }
  });

  router.post("/:id/decision", guard("reviewer"), async (req, res) => {
    const id = idOf(req);
    const actorId: string = res.locals.actor.id;
    const key = req.get("idempotency-key");
    let reserved = false;
    try {
      if (!store.get(id)) return send(res, 404, { error: "NOT_FOUND" });
      if (!key) return send(res, 400, { error: "IDEMPOTENCY_KEY_REQUIRED" });
      const ifMatch = req.get("if-match");
      if (ifMatch === undefined) return send(res, 428, { error: "PRECONDITION_REQUIRED" });
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") return send(res, 400, { error: "INVALID_DECISION" });

      // Reserve synchronously, before the first await in this handler (beforeCommit):
      // two requests with the same key cannot both see "new", so a retry arriving
      // while the first is still in flight gets 409 instead of applying twice.
      const rsv = store.reserve(actorId, key, JSON.stringify([id, decision, ifMatch]));
      if (rsv.kind === "replay") {
        if (rsv.response.etag) res.set("ETag", rsv.response.etag);
        return send(res, rsv.response.status, rsv.response.body);
      }
      if (rsv.kind === "mismatch") return send(res, 422, { error: "IDEMPOTENCY_KEY_REUSED" });
      if (rsv.kind === "in-flight") return send(res, 409, { error: "REQUEST_IN_FLIGHT" });
      reserved = true;

      const fail = (status: number, error: string) => {
        store.release(actorId, key); // rejected before commit: key stays usable
        reserved = false;
        return send(res, status, { error });
      };
      const current = store.get(id);
      if (!current) return fail(404, "NOT_FOUND");
      if (current.version !== parseVersion(ifMatch)) return fail(412, "VERSION_CONFLICT");
      if (current.status !== "pending") return fail(409, "ALREADY_DECIDED");

      await beforeCommit?.({ itemId: id, kind: "decision", actorId });
      // Re-checked atomically here; only status/decidedBy/decidedAt change, never data.
      const r = store.compareAndSet(id, parseVersion(ifMatch), (d) => {
        d.status = decision === "approve" ? "approved" : "rejected";
        d.decidedBy = actorId;
        d.decidedAt = now().toISOString();
      });
      if (!r.ok) return r.reason === "conflict" ? fail(412, "VERSION_CONFLICT") : fail(404, "NOT_FOUND");
      const body = { item: r.item };
      store.complete(actorId, key, { status: 200, body, etag: `"v${r.item.version}"` });
      reserved = false;
      send(res, 200, body, r.item);
    } catch {
      if (reserved && key) store.release(actorId, key);
      send(res, 500, { error: "INTERNAL" });
    }
  });

  return router;
}
