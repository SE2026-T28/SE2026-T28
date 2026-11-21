import { randomBytes, timingSafeEqual } from "node:crypto";

const CSRF_TOKEN_BYTES = 32;
const CSRF_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

interface MfaFormEntry {
  token: string;
  expiresAt: Date;
}

/**
 * Process-local CSRF state for MFA forms. Keep one instance per interaction
 * router. The durable account/challenge attempt counters remain in PostgreSQL;
 * clearing or recreating this store must never reset those counters.
 */
export class MfaFormSecurity {
  private readonly forms = new Map<string, MfaFormEntry>();

  issue(interactionUid: string, challengeExpiresAt: Date, now = new Date()): string {
    const existing = this.forms.get(interactionUid);
    if (existing && existing.expiresAt.getTime() > now.getTime()) return existing.token;
    return this.rotate(interactionUid, challengeExpiresAt, now);
  }

  /** Create a fresh token after password authentication; do not reuse login CSRF. */
  rotate(interactionUid: string, challengeExpiresAt: Date, now = new Date()): string {
    if (!interactionUid || interactionUid.length > 512 || /[\r\n\0]/.test(interactionUid)) {
      throw new TypeError("MFA interaction UID is invalid");
    }
    if (!(challengeExpiresAt instanceof Date) || !Number.isFinite(challengeExpiresAt.getTime()) || challengeExpiresAt.getTime() <= now.getTime()) {
      throw new TypeError("MFA form expiry is invalid");
    }
    const token = randomBytes(CSRF_TOKEN_BYTES).toString("hex");
    this.forms.set(interactionUid, { token, expiresAt: challengeExpiresAt });
    this.cleanup(now);
    return token;
  }

  validate(interactionUid: string, actual: unknown, now = new Date()): boolean {
    const entry = this.forms.get(interactionUid);
    if (!entry) return false;
    if (entry.expiresAt.getTime() <= now.getTime()) {
      this.forms.delete(interactionUid);
      return false;
    }
    if (typeof actual !== "string" || !CSRF_TOKEN_PATTERN.test(actual)) return false;
    const expectedBytes = Buffer.from(entry.token, "hex");
    const actualBytes = Buffer.from(actual, "hex");
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  /** Consume the MFA form token after successful challenge verification. */
  consume(interactionUid: string, actual: unknown, now = new Date()): boolean {
    if (!this.validate(interactionUid, actual, now)) return false;
    this.forms.delete(interactionUid);
    return true;
  }

  invalidate(interactionUid: string): void {
    this.forms.delete(interactionUid);
  }

  cleanup(now = new Date()): number {
    let removed = 0;
    for (const [uid, entry] of this.forms) {
      if (entry.expiresAt.getTime() <= now.getTime()) {
        this.forms.delete(uid);
        removed++;
      }
    }
    return removed;
  }
}
