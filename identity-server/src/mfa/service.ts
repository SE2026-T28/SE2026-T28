import { createHmac, randomInt, randomUUID } from "node:crypto";
import { getPrisma } from "../db/prisma.js";
import { publishMfaAuditEvent } from "./audit.js";
import {
  MfaRateLimitedError,
  PrismaMfaChallengeRepository,
  type MfaChallengeRecord,
  type VerifyMfaRecordResult,
} from "./repository.js";

import { MFA_CHALLENGE_TTL_MS, MFA_MAX_ATTEMPTS } from "./policy.js";
export { MFA_CHALLENGE_TTL_MS, MFA_MAX_ATTEMPTS, MFA_ACCOUNT_FAILURE_LIMIT, MFA_ACCOUNT_FAILURE_WINDOW_MS } from "./policy.js";

export type MfaAuditEventType =
  | "MFA_CHALLENGE_CREATED"
  | "MFA_VERIFICATION_SUCCESS"
  | "MFA_VERIFICATION_FAILED"
  | "MFA_CHALLENGE_EXPIRED"
  | "MFA_CHALLENGE_LOCKED";

/** Safe audit shape: intentionally excludes code, code hash, password and token. */
export interface MfaAuditEvent {
  eventType: MfaAuditEventType;
  occurredAt: string;
  actorUserId: string;
  clientId?: string;
  outcome: "SUCCESS" | "FAILURE" | "LOCKED" | "CREATED" | "EXPIRED";
}

export type MfaVerificationResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "locked" };

export interface MfaChallengeView {
  id: string;
  status: "PENDING" | "LOCKED" | "EXPIRED";
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  /** Ephemeral code is present only for an explicitly enabled local/test mock. */
  demoCode?: string;
}

export interface CreateMfaChallengeResult {
  challenge: MfaChallengeView;
  /** Present only when explicitly enabled for local/test and never in production. */
  demoCode?: string;
}

export interface MfaServiceOptions {
  codePepper: string;
  exposeDemoCode?: boolean;
  now?: () => Date;
  makeCode?: () => string;
  publishAudit?: (event: MfaAuditEvent, interactionUid?: string) => void;
  repository?: PrismaMfaChallengeRepository;
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

function assertOpaqueContext(value: string, name: string, maxLength: number): void {
  if (typeof value !== "string" || value.length < 8 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function makeNumericCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}


export class MfaChallengeService {
  private readonly repository: PrismaMfaChallengeRepository;
  private readonly now: () => Date;
  private readonly makeCode: () => string;
  private readonly demoCodes = new Map<string, { code: string; userId: string; expiresAt: Date }>();

  constructor(private readonly options: MfaServiceOptions) {
    if (process.env.MFA_MOCK_ENABLED !== "true" || (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test")) {
      throw new Error("MFA mock is restricted to explicitly enabled development/test environments");
    }
    if (Buffer.byteLength(options.codePepper, "utf8") < 32) {
      throw new Error("MFA_CODE_PEPPER must contain at least 32 bytes");
    }
    if (options.exposeDemoCode && process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("MFA demo codes are restricted to development/test environments");
    }
    this.repository = options.repository ?? new PrismaMfaChallengeRepository(getPrisma());
    this.now = options.now ?? (() => new Date());
    this.makeCode = options.makeCode ?? makeNumericCode;
  }

  private codeHash(code: string): string {
    return createHmac("sha256", this.options.codePepper)
      .update("app04:mfa-code:v1:", "utf8")
      .update(code, "utf8")
      .digest("hex");
  }

  private browserBindingHash(binding: string): string {
    return createHmac("sha256", this.options.codePepper)
      .update("app04:mfa-browser-binding:v1:", "utf8")
      .update(binding, "utf8")
      .digest("hex");
  }

  private audit(event: MfaAuditEvent, interactionUid?: string): void {
    // The event is metadata-only. The application/audit owner can subscribe to
    // this hook and persist it; the MFA module never logs secrets itself.
    const safeEvent = Object.freeze({ ...event });
    if (this.options.publishAudit) this.options.publishAudit(safeEvent, interactionUid);
    else publishMfaAuditEvent(safeEvent);
  }

  async createChallenge(input: {
    userId: string;
    interactionUid: string;
    browserBinding: string;
    clientId?: string;
  }): Promise<CreateMfaChallengeResult> {
    assertUuid(input.userId, "userId");
    assertOpaqueContext(input.interactionUid, "interactionUid", 512);
    assertOpaqueContext(input.browserBinding, "browserBinding", 256);
    if (input.clientId !== undefined) assertOpaqueContext(input.clientId, "clientId", 256);

    const now = this.now();
    const code = this.makeCode();
    if (!/^\d{6}$/.test(code)) throw new Error("MFA mock code generator returned an invalid code");
    const challenge = await this.repository.create({
      id: randomUUID(),
      userId: input.userId,
      interactionUid: input.interactionUid,
      browserBindingHash: this.browserBindingHash(input.browserBinding),
      codeHash: this.codeHash(code),
      maxAttempts: MFA_MAX_ATTEMPTS,
      createdAt: now,
      expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
    });

    await this.cleanupAt(now);
    if (this.options.exposeDemoCode) {
      // Keep the local/test display cache aligned with the DB's one-pending-
      // challenge-per-account rule; superseded codes are not redisplayed.
      for (const [challengeId, cached] of this.demoCodes) {
        if (cached.userId === input.userId) this.demoCodes.delete(challengeId);
      }
      this.demoCodes.set(challenge.id, { code, userId: input.userId, expiresAt: challenge.expiresAt });
    }
    this.audit({
      eventType: "MFA_CHALLENGE_CREATED",
      occurredAt: now.toISOString(),
      actorUserId: input.userId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      outcome: "CREATED",
    }, input.interactionUid);

    return {
      challenge: this.toView(challenge),
      ...(this.options.exposeDemoCode ? { demoCode: code } : {}),
    };
  }

  async findPendingChallenge(input: { interactionUid: string; browserBinding: string }): Promise<MfaChallengeView | null> {
    assertOpaqueContext(input.interactionUid, "interactionUid", 512);
    assertOpaqueContext(input.browserBinding, "browserBinding", 256);
    const now = this.now();
    await this.cleanupAt(now);
    const found = await this.repository.findPending({
      interactionUid: input.interactionUid,
      browserBindingHash: this.browserBindingHash(input.browserBinding),
      now,
    });
    if (found?.status === "EXPIRED") {
      this.demoCodes.delete(found.id);
      this.audit({
        eventType: "MFA_CHALLENGE_EXPIRED",
        occurredAt: this.now().toISOString(),
        actorUserId: found.userId,
        outcome: "EXPIRED",
      }, input.interactionUid);
      return null;
    }
    if (!found) return null;
    if (found.status === "LOCKED") this.demoCodes.delete(found.id);
    const view = this.toView(found);
    const demo = this.demoCodes.get(found.id);
    if (demo && demo.expiresAt.getTime() > now.getTime() && found.status === "PENDING") {
      view.demoCode = demo.code;
    }
    return view;
  }

  async verifyPendingChallenge(input: {
    interactionUid: string;
    browserBinding: string;
    code: string;
    clientId?: string;
  }): Promise<MfaVerificationResult> {
    assertOpaqueContext(input.interactionUid, "interactionUid", 512);
    assertOpaqueContext(input.browserBinding, "browserBinding", 256);
    if (input.clientId !== undefined) assertOpaqueContext(input.clientId, "clientId", 256);

    const now = this.now();
    const pending = await this.repository.findPending({
      interactionUid: input.interactionUid,
      browserBindingHash: this.browserBindingHash(input.browserBinding),
      now,
    });
    if (!pending) {
      await this.cleanupAt(now);
      return { ok: false, reason: "invalid" };
    }
    if (pending.status === "EXPIRED") {
      this.demoCodes.delete(pending.id);
      this.audit({ eventType: "MFA_CHALLENGE_EXPIRED", occurredAt: now.toISOString(), actorUserId: pending.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "EXPIRED" }, input.interactionUid);
      await this.cleanupAt(now);
      return { ok: false, reason: "expired" };
    }
    if (pending.status === "LOCKED") {
      this.demoCodes.delete(pending.id);
      this.audit({ eventType: "MFA_CHALLENGE_LOCKED", occurredAt: now.toISOString(), actorUserId: pending.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "LOCKED" }, input.interactionUid);
      await this.cleanupAt(now);
      return { ok: false, reason: "locked" };
    }

    const result = await this.verifyChallengeForUser({
      challengeId: pending.id,
      userId: pending.userId,
      interactionUid: input.interactionUid,
      browserBinding: input.browserBinding,
      code: input.code,
      ...(input.clientId ? { clientId: input.clientId } : {}),
    });
    await this.cleanupAt(now);
    return result;
  }

  private async verifyChallengeForUser(input: {
    challengeId: string;
    userId: string;
    interactionUid: string;
    browserBinding: string;
    code: string;
    clientId?: string;
  }): Promise<MfaVerificationResult> {
    assertUuid(input.userId, "userId");
    assertUuid(input.challengeId, "challengeId");
    assertOpaqueContext(input.interactionUid, "interactionUid", 512);
    assertOpaqueContext(input.browserBinding, "browserBinding", 256);
    if (input.clientId !== undefined) assertOpaqueContext(input.clientId, "clientId", 256);

    const now = this.now();
    // Malformed values still follow the failure path; never echo the submitted code.
    const submittedCode = typeof input.code === "string" && /^\d{6}$/.test(input.code) ? input.code : "invalid";
    const result: VerifyMfaRecordResult = await this.repository.verify({
      challengeId: input.challengeId,
      userId: input.userId,
      interactionUid: input.interactionUid,
      browserBindingHash: this.browserBindingHash(input.browserBinding),
      submittedCodeHash: this.codeHash(submittedCode),
      now,
    });

    const event: MfaAuditEvent = result.kind === "verified"
      ? { eventType: "MFA_VERIFICATION_SUCCESS", occurredAt: now.toISOString(), actorUserId: input.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "SUCCESS" }
      : result.kind === "expired"
        ? { eventType: "MFA_CHALLENGE_EXPIRED", occurredAt: now.toISOString(), actorUserId: input.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "EXPIRED" }
        : result.kind === "locked"
          ? { eventType: "MFA_CHALLENGE_LOCKED", occurredAt: now.toISOString(), actorUserId: input.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "LOCKED" }
          : { eventType: "MFA_VERIFICATION_FAILED", occurredAt: now.toISOString(), actorUserId: input.userId, ...(input.clientId ? { clientId: input.clientId } : {}), outcome: "FAILURE" };
    this.audit(event, input.interactionUid);
    if (result.kind === "verified" || result.kind === "expired" || result.kind === "locked") {
      this.demoCodes.delete(input.challengeId);
    }

    if (result.kind === "verified") return { ok: true, userId: result.userId };
    return { ok: false, reason: result.kind };
  }

  async cleanupExpired(): Promise<{ expired: number; deleted: number }> {
    return this.cleanupAt(this.now());
  }

  private async cleanupAt(now: Date): Promise<{ expired: number; deleted: number }> {
    const result = await this.repository.cleanup(now);
    for (const [challengeId, cached] of this.demoCodes) {
      if (cached.expiresAt.getTime() <= now.getTime()) this.demoCodes.delete(challengeId);
    }
    for (const userId of result.expiredUserIds) {
      this.audit({
        eventType: "MFA_CHALLENGE_EXPIRED",
        occurredAt: now.toISOString(),
        actorUserId: userId,
        outcome: "EXPIRED",
      });
    }
    return { expired: result.expired, deleted: result.deleted };
  }

  private toView(record: MfaChallengeRecord): MfaChallengeView {
    return {
      id: record.id,
      status: record.status === "LOCKED" ? "LOCKED" : record.status === "EXPIRED" ? "EXPIRED" : "PENDING",
      expiresAt: record.expiresAt,
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
    };
  }
}

export function createMfaChallengeService(options: Partial<MfaServiceOptions> = {}): MfaChallengeService {
  const localOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (!localOrTest || process.env.MFA_MOCK_ENABLED !== "true") {
    throw new Error("MFA mock is restricted to explicitly enabled development/test environments");
  }
  const exposeDemoCode = options.exposeDemoCode ?? process.env.MFA_DEMO_CODE_ENABLED === "true";
  const codePepper = options.codePepper ?? process.env.MFA_CODE_PEPPER;
  if (!codePepper) throw new Error("MFA_CODE_PEPPER is required when MFA mock is enabled");
  return new MfaChallengeService({ ...options, codePepper, exposeDemoCode });
}

export function isMfaRateLimitError(error: unknown): error is MfaRateLimitedError {
  return error instanceof MfaRateLimitedError;
}
