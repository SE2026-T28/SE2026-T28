import { timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { MFA_ACCOUNT_FAILURE_LIMIT, MFA_ACCOUNT_FAILURE_WINDOW_MS, MFA_CHALLENGE_RETENTION_MS } from "./policy.js";

export type MfaChallengeStatus = "PENDING" | "CONSUMED" | "EXPIRED" | "LOCKED" | "SUPERSEDED";

export interface MfaChallengeRecord {
  id: string;
  userId: string;
  interactionUid: string;
  browserBindingHash: string;
  codeHash: string;
  status: MfaChallengeStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface CreateMfaChallengeRecord {
  id: string;
  userId: string;
  interactionUid: string;
  browserBindingHash: string;
  codeHash: string;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
}

export type VerifyMfaRecordResult =
  | { kind: "verified"; userId: string }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "locked" };

export class MfaRateLimitedError extends Error {
  constructor() {
    super("MFA verification temporarily unavailable");
    this.name = "MfaRateLimitedError";
  }
}

interface RawChallengeRow {
  id: string;
  user_id: string;
  interaction_uid: string;
  browser_binding_hash: string;
  code_hash: string;
  status: MfaChallengeStatus;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

interface RawRateLimitRow {
  window_started_at: Date;
  failed_attempts: number;
  locked_until: Date | null;
}

function mapChallenge(row: RawChallengeRow): MfaChallengeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    interactionUid: row.interaction_uid,
    browserBindingHash: row.browser_binding_hash.trim(),
    codeHash: row.code_hash.trim(),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export class PrismaMfaChallengeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private async lockRateLimit(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<RawRateLimitRow> {
    await tx.$executeRaw`
      INSERT INTO "mfa_attempt_limits" ("user_id", "window_started_at")
      VALUES (${userId}::uuid, ${now})
      ON CONFLICT ("user_id") DO NOTHING
    `;

    const rows = await tx.$queryRaw<RawRateLimitRow[]>`
      SELECT "window_started_at", "failed_attempts", "locked_until"
      FROM "mfa_attempt_limits"
      WHERE "user_id" = ${userId}::uuid
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new Error("MFA rate-limit row could not be locked");

    if (current.window_started_at.getTime() + MFA_ACCOUNT_FAILURE_WINDOW_MS <= now.getTime()) {
      await tx.$executeRaw`
        UPDATE "mfa_attempt_limits"
        SET "window_started_at" = ${now},
            "failed_attempts" = 0,
            "locked_until" = NULL,
            "updated_at" = ${now}
        WHERE "user_id" = ${userId}::uuid
      `;
      return { window_started_at: now, failed_attempts: 0, locked_until: null };
    }
    return current;
  }

  async create(input: CreateMfaChallengeRecord): Promise<MfaChallengeRecord> {
    return this.prisma.$transaction(async tx => {
      const rate = await this.lockRateLimit(tx, input.userId, input.createdAt);
      if (rate.locked_until && rate.locked_until.getTime() > input.createdAt.getTime()) {
        throw new MfaRateLimitedError();
      }

      await tx.$executeRaw`
        UPDATE "mfa_challenges"
        SET "status" = 'SUPERSEDED', "updated_at" = ${input.createdAt}
        WHERE "user_id" = ${input.userId}::uuid
          AND "status" IN ('PENDING', 'LOCKED')
      `;

      const rows = await tx.$queryRaw<RawChallengeRow[]>`
        INSERT INTO "mfa_challenges" (
          "id", "user_id", "interaction_uid", "browser_binding_hash", "code_hash",
          "status", "attempts", "max_attempts", "created_at", "expires_at", "updated_at"
        ) VALUES (
          ${input.id}::uuid, ${input.userId}::uuid, ${input.interactionUid}, ${input.browserBindingHash},
          ${input.codeHash}, 'PENDING', 0, ${input.maxAttempts}, ${input.createdAt}, ${input.expiresAt}, ${input.createdAt}
        )
        RETURNING "id", "user_id", "interaction_uid", "browser_binding_hash", "code_hash",
          "status", "attempts", "max_attempts", "created_at", "expires_at", "consumed_at"
      `;
      return mapChallenge(rows[0]!);
    });
  }

  async findPending(input: { interactionUid: string; browserBindingHash: string; now: Date }): Promise<MfaChallengeRecord | null> {
    const rows = await this.prisma.$queryRaw<RawChallengeRow[]>`
      SELECT "id", "user_id", "interaction_uid", "browser_binding_hash", "code_hash",
        "status", "attempts", "max_attempts", "created_at", "expires_at", "consumed_at"
      FROM "mfa_challenges"
      WHERE "interaction_uid" = ${input.interactionUid}
        AND "browser_binding_hash" = ${input.browserBindingHash}
        AND "status" IN ('PENDING', 'LOCKED')
      ORDER BY "created_at" DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at.getTime() <= input.now.getTime()) {
      await this.prisma.$executeRaw`
        UPDATE "mfa_challenges"
        SET "status" = 'EXPIRED', "updated_at" = ${input.now}
        WHERE "id" = ${row.id}::uuid AND "status" IN ('PENDING', 'LOCKED')
      `;
      row.status = "EXPIRED";
      return mapChallenge(row);
    }
    return mapChallenge(row);
  }

  async verify(input: {
    challengeId: string;
    userId: string;
    interactionUid: string;
    browserBindingHash: string;
    submittedCodeHash: string;
    now: Date;
  }): Promise<VerifyMfaRecordResult> {
    return this.prisma.$transaction(async tx => {
      const rate = await this.lockRateLimit(tx, input.userId, input.now);
      if (rate.locked_until && rate.locked_until.getTime() > input.now.getTime()) return { kind: "locked" };

      const rows = await tx.$queryRaw<RawChallengeRow[]>`
        SELECT "id", "user_id", "interaction_uid", "browser_binding_hash", "code_hash",
          "status", "attempts", "max_attempts", "created_at", "expires_at", "consumed_at"
        FROM "mfa_challenges"
        WHERE "id" = ${input.challengeId}::uuid
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row
        || row.user_id !== input.userId
        || row.interaction_uid !== input.interactionUid
        || row.browser_binding_hash.trim() !== input.browserBindingHash) {
        return { kind: "invalid" };
      }

      if (row.status !== "PENDING") return { kind: row.status === "EXPIRED" ? "expired" : row.status === "LOCKED" ? "locked" : "invalid" };
      if (row.expires_at.getTime() <= input.now.getTime()) {
        await tx.$executeRaw`
          UPDATE "mfa_challenges" SET "status" = 'EXPIRED', "updated_at" = ${input.now}
          WHERE "id" = ${input.challengeId}::uuid AND "status" = 'PENDING'
        `;
        return { kind: "expired" };
      }

      const submitted = Buffer.from(input.submittedCodeHash, "hex");
      const stored = Buffer.from(row.code_hash.trim(), "hex");
      const matches = submitted.length === stored.length && submitted.length > 0 &&
        timingSafeEqual(submitted, stored);

      if (matches) {
        const updated = await tx.$executeRaw`
          UPDATE "mfa_challenges"
          SET "status" = 'CONSUMED', "consumed_at" = ${input.now}, "updated_at" = ${input.now}
          WHERE "id" = ${input.challengeId}::uuid
            AND "status" = 'PENDING'
            AND "expires_at" > ${input.now}
        `;
        if (updated !== 1) return { kind: "invalid" };
        await tx.$executeRaw`
          UPDATE "mfa_attempt_limits"
          SET "failed_attempts" = 0, "locked_until" = NULL,
              "window_started_at" = ${input.now}, "updated_at" = ${input.now}
          WHERE "user_id" = ${input.userId}::uuid
        `;
        return { kind: "verified", userId: input.userId };
      }

      const nextChallengeAttempts = Number(row.attempts) + 1;
      const lockedUntil = new Date(rate.window_started_at.getTime() + MFA_ACCOUNT_FAILURE_WINDOW_MS);
      const updatedLimits = await tx.$queryRaw<Array<{ failed_attempts: number; locked_until: Date | null }>>`
        UPDATE "mfa_attempt_limits"
        SET "failed_attempts" = "failed_attempts" + 1,
            "locked_until" = CASE
              WHEN "failed_attempts" + 1 >= ${MFA_ACCOUNT_FAILURE_LIMIT} THEN ${lockedUntil}::timestamptz
              ELSE NULL
            END,
            "updated_at" = ${input.now}
        WHERE "user_id" = ${input.userId}::uuid
        RETURNING "failed_attempts", "locked_until"
      `;
      const accountLocked = (updatedLimits[0]?.failed_attempts ?? 0) >= MFA_ACCOUNT_FAILURE_LIMIT;
      const challengeLocked = nextChallengeAttempts >= Number(row.max_attempts);
      await tx.$executeRaw`
        UPDATE "mfa_challenges"
        SET "attempts" = ${nextChallengeAttempts},
            "status" = ${accountLocked || challengeLocked ? "LOCKED" : "PENDING"},
            "updated_at" = ${input.now}
        WHERE "id" = ${input.challengeId}::uuid AND "status" = 'PENDING'
      `;
      if (accountLocked || challengeLocked) return { kind: "locked" };
      return { kind: "invalid" };
    });
  }

  async cleanup(now: Date, retentionMs = MFA_CHALLENGE_RETENTION_MS): Promise<{ expired: number; deleted: number; expiredUserIds: string[] }> {
    const expiredRows = await this.prisma.$queryRaw<Array<{ user_id: string }>>`
      UPDATE "mfa_challenges"
      SET "status" = 'EXPIRED', "updated_at" = ${now}
      WHERE "status" = 'PENDING' AND "expires_at" <= ${now}
      RETURNING "user_id"
    `;
    const expired = expiredRows.length;
    const cutoff = new Date(now.getTime() - retentionMs);
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "mfa_challenges"
      WHERE "status" <> 'PENDING' AND "updated_at" < ${cutoff}
    `;
    await this.prisma.$executeRaw`
      DELETE FROM "mfa_attempt_limits"
      WHERE ("locked_until" IS NULL OR "locked_until" <= ${now})
        AND "window_started_at" < ${new Date(now.getTime() - 24 * 60 * 60 * 1000)}
    `;
    return { expired, deleted, expiredUserIds: expiredRows.map(row => row.user_id) };
  }
}
