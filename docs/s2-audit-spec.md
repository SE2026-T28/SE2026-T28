# S2 Audit Logging

Issue #26, Phuong. Baseline `b8f400d25e65168383142bc31a585cde9299822e`, on the existing S1 worktree. S1 files remain byte-for-byte unchanged. The sequence is spec, RED tests, service/migration, GREEN verification, then review.

## Storage and contract

Add an independent `audit_events` table with UUID id, event_type, outcome, nullable actor_id UUID, client_id, correlation_id, reason_code, server-generated occurred_at timestamptz and controlled JSON metadata. Actor has no foreign key so account deletion does not erase history. No public audit read endpoint is exposed.

The allowlisted event types are login.success, login.failure, mfa.success, mfa.failure, token.issued, token.revoked and logout.completed. Outcomes are success/failure. Login/MFA suffix must match outcome; logout.completed requires success. Token events can record an operation outcome; failure never asserts issuance or revocation succeeded.

`AuditEventInput` uses camelCase fields. Optional nullable fields default to null. Actor and correlation IDs must be canonical UUID-shaped strings; correlation IDs are generated server-side and must not be interaction IDs, session IDs, codes or tokens. clientId accepts only app04-react-demo or null. reasonCode is a bounded enum, never an exception message. Reject unknown keys, arrays/class objects, wrong types, mismatched outcomes, oversized values and arbitrary caller timestamps/IDs. Use the service clock and random UUID for stored events.

Metadata is a flat object, maximum 1024 UTF-8 bytes. Validate every own property on both the event and metadata, including non-enumerable properties. Unknown fields and Symbol keys cause rejection of the entire event. Accessors and custom prototypes are rejected without invoking getters. Allowed non-enumerable data properties are validated and copied with the same rules as enumerable properties. All values have explicit types/ranges/enums. No request body/header, email, IP, callback URL, arbitrary string, nested JSON, password, OTP, authorization code, raw token, cookie or secret is accepted.

The scopes array must have the standard Array prototype and only its length and own numeric element keys. Extra properties, Symbol keys, sparse/accessor elements and custom array prototypes are rejected; elements still use the existing scope allowlist.

| Events | Metadata fields |
| --- | --- |
| login.success/failure | attemptCount (integer 0..20) |
| mfa.success/failure | attemptCount (integer 0..20), mfaMethod (mock) |
| token.issued | tokenType (access_token/id_token/refresh_token), grantType (authorization_code/refresh_token), scopes (unique subset of openid/profile/email/api:read/offline_access) |
| token.revoked | tokenType (access_token/refresh_token), revocationConfirmed (boolean) |
| logout.completed | sessionEnded (boolean) |

Success/failure confirmation booleans, if supplied, must match outcome. Successful logout does not set revocationConfirmed and must not emit token.revoked by inference. Omit unavailable metadata rather than manufacture a confirmation.

The exported `AuditRecorder` resolves to `{ ok: true, eventId }`, `{ ok: false, error: 'invalid_event' }` or `{ ok: false, error: 'write_failed' }`. Validation happens before persistence. Dependency errors, messages and input are never logged or returned. Valid metadata is copied before asynchronous persistence. A successful result confirms database insertion only. There is no automatic retry or deduplication; callers must check the result.

## Integration ownership

Nam calls `recordAuditEvent` after the final login or MFA outcome is known. Unknown-user login failures have actorId null. Do not emit login.success merely because password verification passed when an MFA requirement still applies. Use a newly generated correlation UUID for the attempt; pass neither form UID nor CSRF token.

Quang calls the same recorder after actual token issuance, revocation outcome and completed Provider logout. Pass only IDs and the metadata fields above. RP logout alone provides no token-revocation evidence. The token contract, Provider hooks and adapter remain owned by Quang.

Example caller contract (not wired into other owners' modules in this change)

```ts
import { randomUUID } from 'node:crypto';
import { recordAuditEvent, type AuditRecorder } from '../audit/service.js';

const audit: AuditRecorder = recordAuditEvent;
const result = await audit({
  eventType: 'login.failure', outcome: 'failure', actorId: null,
  clientId: 'app04-react-demo', correlationId: randomUUID(),
  reasonCode: 'invalid_credentials', metadata: { attemptCount: 1 },
});
// Handle result.ok === false using a fixed operational signal.
```

Before wiring, Nam/Quang/Phuong must decide whether audit write failure blocks each security operation, how to signal/recover lost events, exact hook ordering and correlation ownership, retention/access policy and retry/idempotency. This module returns a controlled failure and leaves business policy to the owner. No claim of complete M3 event coverage is made until hooks are integrated and tested.

## Verification

Unit tests cover all event types, allowlists, types/lengths, sensitive input rejection, immutable metadata snapshot, controlled writer failure and no diagnostic leakage. Integration tests verify insert/read, server UUID/timestamp, raw database constraints and exact run-owned cleanup on the S3 harness database. Run the full isolated backend suite to include S1 regression, safety, parallel fixtures and headers. Never connect to development/shared databases.

Audit tests use statically resolved imports. `test/audit-contract.types.ts` is included by the existing `test/**/*.ts` TypeScript build pipeline. Its negative cases use @ts-expect-error for invalid event, metadata type and client ID; widening the recorder to any must make the build fail with unused directives. This file is compile-only and never invokes database operations at runtime.
