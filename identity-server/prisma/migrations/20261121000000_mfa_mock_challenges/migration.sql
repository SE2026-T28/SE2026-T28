-- M3-AUTH: mock MFA challenges and account-wide failure windows.
-- This migration is intentionally additive and uses raw SQL access so it does
-- not modify the shared Prisma schema.prisma / generated client owned by the
-- Provider adapter work.

CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "interaction_uid" VARCHAR(512) NOT NULL,
    "browser_binding_hash" CHAR(64) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mfa_challenges_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mfa_challenges_status_check"
      CHECK ("status" IN ('PENDING', 'CONSUMED', 'EXPIRED', 'LOCKED', 'SUPERSEDED')),
    CONSTRAINT "mfa_challenges_attempts_check"
      CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts"),
    CONSTRAINT "mfa_challenges_expiry_check"
      CHECK ("expires_at" > "created_at")
);

-- At most one pending challenge for an interaction. A replacement first marks
-- the prior pending row SUPERSEDED inside the same transaction.
CREATE UNIQUE INDEX "mfa_challenges_one_pending_interaction_idx"
  ON "mfa_challenges"("interaction_uid") WHERE "status" = 'PENDING';
-- A user can have only one active challenge at a time. A new authenticated
-- interaction supersedes the previous pending challenge for that same user.
CREATE UNIQUE INDEX "mfa_challenges_one_pending_user_idx"
  ON "mfa_challenges"("user_id") WHERE "status" = 'PENDING';
CREATE INDEX "mfa_challenges_user_created_idx"
  ON "mfa_challenges"("user_id", "created_at" DESC);
CREATE INDEX "mfa_challenges_expiry_idx"
  ON "mfa_challenges"("status", "expires_at");

-- Failed attempts are keyed by account, not by interaction or browser. Creating
-- a fresh interaction/browser therefore cannot reset the MFA guessing budget.
CREATE TABLE "mfa_attempt_limits" (
    "user_id" UUID NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mfa_attempt_limits_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "mfa_attempt_limits_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mfa_attempt_limits_failed_check" CHECK ("failed_attempts" >= 0)
);

CREATE INDEX "mfa_attempt_limits_window_idx"
  ON "mfa_attempt_limits"("window_started_at");
