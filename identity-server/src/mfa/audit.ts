
import { EventEmitter } from "node:events";
import type { MfaAuditEvent } from "./service.js";

/**
 * Metadata-only MFA audit event channel.
 *
 * The audit owner can subscribe through subscribeMfaAuditEvents().
 * Payload deliberately excludes passwords, MFA codes, hashes,
 * authorization codes, raw tokens, cookies and browser bindings.
 */

const auditEmitter = new EventEmitter();
const MFA_AUDIT_EVENT = "mfa:audit";

export type MfaAuditListener = (
  event: Readonly<MfaAuditEvent>
) => void;

export function subscribeMfaAuditEvents(
  listener: MfaAuditListener
): () => void {
  auditEmitter.on(MFA_AUDIT_EVENT, listener);

  return () => {
    auditEmitter.off(MFA_AUDIT_EVENT, listener);
  };
}

export function publishMfaAuditEvent(
  event: MfaAuditEvent
): void {
  const safeEvent = Object.freeze({ ...event });

  auditEmitter.emit(MFA_AUDIT_EVENT, safeEvent);
}
