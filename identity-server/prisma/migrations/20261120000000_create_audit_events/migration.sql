CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(7) NOT NULL,
    "actor_id" UUID,
    "client_id" VARCHAR(64),
    "correlation_id" VARCHAR(36),
    "reason_code" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_type_check" CHECK ("event_type" IN (
        'login.success', 'login.failure', 'mfa.success', 'mfa.failure',
        'token.issued', 'token.revoked', 'logout.completed'
    )),
    CONSTRAINT "audit_events_outcome_check" CHECK ("outcome" IN ('success', 'failure')),
    CONSTRAINT "audit_events_outcome_matches_type" CHECK (
        ("event_type" IN ('login.success', 'mfa.success', 'logout.completed') AND "outcome" = 'success')
        OR ("event_type" IN ('login.failure', 'mfa.failure') AND "outcome" = 'failure')
        OR "event_type" IN ('token.issued', 'token.revoked')
    ),
    CONSTRAINT "audit_events_client_check" CHECK ("client_id" IS NULL OR "client_id" = 'app04-react-demo'),
    CONSTRAINT "audit_events_reason_check" CHECK ("reason_code" IS NULL OR "reason_code" IN (
        'invalid_credentials', 'rate_limited', 'csrf_rejected', 'expired',
        'invalid_challenge', 'invalid_token', 'invalid_grant', 'denied', 'internal_error'
    )),
    CONSTRAINT "audit_events_correlation_check" CHECK ("correlation_id" IS NULL OR
        "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT "audit_events_metadata_check" CHECK (
        jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 1024
        AND ("metadata" - CASE
            WHEN "event_type" IN ('login.success', 'login.failure') THEN ARRAY['attemptCount']
            WHEN "event_type" IN ('mfa.success', 'mfa.failure') THEN ARRAY['attemptCount', 'mfaMethod']
            WHEN "event_type" = 'token.issued' THEN ARRAY['tokenType', 'grantType', 'scopes']
            WHEN "event_type" = 'token.revoked' THEN ARRAY['tokenType', 'revocationConfirmed']
            ELSE ARRAY['sessionEnded'] END) = '{}'::jsonb
    )
);

CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");
CREATE INDEX "audit_events_correlation_id_idx" ON "audit_events"("correlation_id");
