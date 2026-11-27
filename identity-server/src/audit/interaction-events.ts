import { randomUUID } from "node:crypto";
import type { MfaAuditEvent } from "../mfa/service.js";
import { recordAuditEvent, type AuditEventInput, type AuditRecorder } from "./service.js";

/** Best-effort bridge from completed interaction/MFA actions to the audit store. */
export function createInteractionAudit(
  clientId: string,
  recorder: AuditRecorder = recordAuditEvent,
  onWriteFailure: () => void = () => { console.error("Interaction audit write failed"); },
) {
  const pending = new Set<Promise<void>>();
  const correlations = new Map<string, { id: string; expires: number }>();
  const client = clientId === "app04-react-demo" ? clientId : null;
  const correlation = (uid: string): string => {
    const now = Date.now();
    if (correlations.size > 1000) {
      for (const [key, entry] of correlations) if (entry.expires <= now) correlations.delete(key);
    }
    const existing = correlations.get(uid);
    if (existing && existing.expires > now) return existing.id;
    const id = randomUUID();
    correlations.set(uid, { id, expires: now + 15 * 60_000 });
    return id;
  };
  const submit = (event: AuditEventInput): void => {
    const task = Promise.resolve().then(() => recorder(event))
      .then(result => { if (!result.ok) onWriteFailure(); })
      .catch(() => { onWriteFailure(); })
      .finally(() => { pending.delete(task); });
    pending.add(task);
  };
  return {
    loginFailure(uid: string): void {
      if (!client) return;
      submit({ eventType: "login.failure", outcome: "failure", clientId: client,
        correlationId: correlation(uid), reasonCode: "invalid_credentials" });
    },
    loginSuccess(uid: string, actorId: string): void {
      if (!client) return;
      submit({ eventType: "login.success", outcome: "success", actorId,
        clientId: client, correlationId: correlation(uid) });
      correlations.delete(uid);
    },
    mfa(event: Readonly<MfaAuditEvent>, interactionUid?: string): void {
      if (!client) return;
      const correlationId = interactionUid ? correlation(interactionUid) : randomUUID();
      const reason = event.eventType === "MFA_VERIFICATION_FAILED" ? "invalid_challenge"
        : event.eventType === "MFA_CHALLENGE_LOCKED" ? "rate_limited"
          : event.eventType === "MFA_CHALLENGE_EXPIRED" ? "expired" : null;
      if (event.eventType === "MFA_VERIFICATION_SUCCESS") {
        submit({ eventType: "mfa.success", outcome: "success", actorId: event.actorUserId,
          clientId: client, correlationId, metadata: { mfaMethod: "mock" } });
      } else if (reason) {
        submit({ eventType: "mfa.failure", outcome: "failure", actorId: event.actorUserId,
          clientId: client, correlationId, reasonCode: reason,
          metadata: { mfaMethod: "mock" } });
      }
    },
    async drain(): Promise<void> { await Promise.allSettled([...pending]); },
  };
}

export type InteractionAudit = ReturnType<typeof createInteractionAudit>;

/** Never mark login successful if Provider completion rejects. */
export async function completeLoginWithAudit<T>(
  complete: () => Promise<T>, audit: InteractionAudit | undefined, uid: string, actorId: string,
): Promise<T> {
  const result = await complete();
  audit?.loginSuccess(uid, actorId);
  return result;
}
