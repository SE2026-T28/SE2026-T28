// In-memory store for ReviewItem (BT3 VT-111). Signatures are the
// contract used by tests.
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

interface IdemRecord {
  fingerprint: string;
  response?: StoredResponse; // undefined while in flight
}

export class ReviewStore {
  private readonly items = new Map<string, ReviewItem>();
  private readonly idem = new Map<string, IdemRecord>();

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
  compareAndSet(id: string, expectedVersion: number, mutate: (draft: ReviewItem) => void): CasResult {
    // No await anywhere in this method: check and write form one synchronous
    // section, so JS's single thread guarantees only one caller per version wins.
    const current = this.items.get(id);
    if (current === undefined) return { ok: false, reason: "not-found" };
    if (expectedVersion !== current.version) return { ok: false, reason: "conflict" };
    const draft = structuredClone(current);
    mutate(draft);
    draft.version = expectedVersion + 1;
    this.items.set(id, draft);
    return { ok: true, item: structuredClone(draft) };
  }

  /** Synchronously reserve (actorId, key) for `fingerprint`. */
  reserve(actorId: string, key: string, fingerprint: string): ReserveResult {
    const k = JSON.stringify([actorId, key]);
    const rec = this.idem.get(k);
    if (rec === undefined) {
      this.idem.set(k, { fingerprint });
      return { kind: "new" };
    }
    if (rec.fingerprint !== fingerprint) return { kind: "mismatch" };
    return rec.response === undefined ? { kind: "in-flight" } : { kind: "replay", response: structuredClone(rec.response) };
  }

  /** Mark (actorId, key) completed and store the response for replay. */
  complete(actorId: string, key: string, response: StoredResponse): void {
    const rec = this.idem.get(JSON.stringify([actorId, key]));
    if (rec !== undefined) rec.response = structuredClone(response);
  }

  /** Drop an in-flight reservation (failure path); a later reserve returns `new`. */
  release(actorId: string, key: string): void {
    this.idem.delete(JSON.stringify([actorId, key]));
  }
}
