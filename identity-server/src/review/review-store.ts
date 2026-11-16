// In-memory store for ReviewItem (BT3 VT-111). SKELETON: signatures are the
// contract used by tests; every body throws until the implementation step.
// Invariant: compareAndSet checks version and writes in ONE synchronous
// section (no await between check and write). With a real DB this becomes
// `UPDATE ... WHERE version = $1`.

/** Known roles are "admin" and "reviewer"; any other string is denied by the router. */
export type Role = "admin" | "reviewer" | (string & {});

export interface Actor {
  id: string;
  role: Role;
}

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ReviewItem {
  id: string;
  /** Original data. Only an admin PATCH may change it. */
  data: { title: string; body: string };
  status: ReviewStatus;
  /** Starts at 1; +1 on every successful compareAndSet. Exposed as ETag "v<version>". */
  version: number;
  /** Set by an approve/reject decision. */
  decidedBy?: string;
  /** ISO string from the injectable clock. */
  decidedAt?: string;
}

/** `conflict` = expectedVersion != current version (mutate NOT called). */
export type CasResult =
  | { ok: true; item: ReviewItem }
  | { ok: false; reason: "conflict" | "not-found" };

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * reserve() outcomes, keyed by (actorId, key):
 *  - new: key reserved (now in-flight) for this fingerprint
 *  - replay: key completed with the same fingerprint; response = stored one
 *  - mismatch: key known (in-flight or completed) with a DIFFERENT fingerprint
 *  - in-flight: same fingerprint, first request not completed yet
 */
export type ReserveResult =
  | { kind: "new" }
  | { kind: "in-flight" }
  | { kind: "mismatch" }
  | { kind: "replay"; response: StoredResponse };

export class ReviewStore {
  private readonly items = new Map<string, ReviewItem>();

  /** Insert a deep copy of `item` (test fixture / bootstrap). */
  seed(item: ReviewItem): void {
    this.items.set(item.id, structuredClone(item));
  }

  /** Deep copy of the item, or undefined. Mutating the copy never changes the store. */
  get(id: string): ReviewItem | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  /**
   * Atomic compare-and-set. If the item is missing -> not-found. If
   * expectedVersion != current version -> conflict and `mutate` is NOT called.
   * Otherwise `mutate` receives a deep-copy draft; the store commits the draft
   * with version = expectedVersion + 1 and returns a copy of the new item.
   */
  compareAndSet(_id: string, _expectedVersion: number, _mutate: (draft: ReviewItem) => void): CasResult {
    throw new Error("not implemented");
  }

  /** Synchronously reserve (actorId, key) for `fingerprint`. */
  reserve(_actorId: string, _key: string, _fingerprint: string): ReserveResult {
    throw new Error("not implemented");
  }

  /** Mark (actorId, key) completed and store the response for replay. */
  complete(_actorId: string, _key: string, _response: StoredResponse): void {
    throw new Error("not implemented");
  }

  /** Drop an in-flight reservation (failure path); a later reserve returns `new`. */
  release(_actorId: string, _key: string): void {
    throw new Error("not implemented");
  }
}
