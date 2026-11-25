CREATE TABLE "oidc_artifacts" (
    "model" VARCHAR(64) NOT NULL,
    "id" VARCHAR(512) NOT NULL,
    "payload" JSONB NOT NULL,
    "grant_id" VARCHAR(512),
    "uid" VARCHAR(512),
    "user_code" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    CONSTRAINT "oidc_artifacts_pkey" PRIMARY KEY ("model", "id")
);

CREATE INDEX "oidc_artifacts_model_uid_idx" ON "oidc_artifacts"("model", "uid");
CREATE INDEX "oidc_artifacts_model_user_code_idx" ON "oidc_artifacts"("model", "user_code");
CREATE INDEX "oidc_artifacts_model_grant_id_idx" ON "oidc_artifacts"("model", "grant_id");
CREATE INDEX "oidc_artifacts_expires_at_idx" ON "oidc_artifacts"("expires_at");
