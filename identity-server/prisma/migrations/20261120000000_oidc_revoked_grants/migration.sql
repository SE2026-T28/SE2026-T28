CREATE TABLE "oidc_revoked_grants" (
    "id" VARCHAR(64) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oidc_revoked_grants_pkey" PRIMARY KEY ("id")
);
