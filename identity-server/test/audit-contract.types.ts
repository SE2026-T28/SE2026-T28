import { recordAuditEvent } from "../src/audit/service.js";

// Included in the normal tsc build. Keep this function uncalled so no event is written.
function checkAuditContract() {
  void recordAuditEvent({ eventType: "login.success", outcome: "success", metadata: { attemptCount: 1 } });
  // @ts-expect-error Event types must come from the audit allowlist.
  void recordAuditEvent({ eventType: "unknown.event", outcome: "success" });
  // @ts-expect-error Attempt count must be a number.
  void recordAuditEvent({ eventType: "login.failure", outcome: "failure", metadata: { attemptCount: "1" } });
  // @ts-expect-error Only the registered client is accepted.
  void recordAuditEvent({ eventType: "login.success", outcome: "success", clientId: "other-client" });
}

void checkAuditContract;
