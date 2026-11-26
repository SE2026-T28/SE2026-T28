import { randomUUID } from "node:crypto";
import type { KoaContextWithOIDC, Provider } from "oidc-provider";
import { recordAuditEvent, type AuditEventInput, type AuditRecorder } from "./service.js";

/**
 * Provider event listeners cannot delay an OAuth response. Audit is therefore
 * best effort here: a failed write raises only a fixed operational signal.
 * The integration PR must not claim durable or exactly-once audit delivery.
 */
export function registerOidcAudit(
  provider: Provider,
  clientId: string,
  recorder: AuditRecorder = recordAuditEvent,
  onWriteFailure: () => void = () => { console.error("OIDC audit write failed"); },
): { drain(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  function submit(event: AuditEventInput): void {
    const task = Promise.resolve()
      .then(() => recorder(event))
      .then(result => { if (!result.ok) onWriteFailure(); })
      .catch(() => { onWriteFailure(); })
      .finally(() => { pending.delete(task); });
    pending.add(task);
  }
  const client = clientId === "app04-react-demo" ? clientId : null;
  provider.on("grant.success", (ctx: KoaContextWithOIDC) => {
    const token = ctx.oidc.entities.AccessToken;
    if (!token || !client) return;
    const grantType = ctx.oidc.params?.grant_type;
    const scopes = token.scope?.split(" ").filter((scope): scope is "openid" | "profile" | "email" | "api:read" | "offline_access" =>
      scope === "openid" || scope === "profile" || scope === "email" || scope === "api:read" || scope === "offline_access");
    submit({
      eventType: "token.issued", outcome: "success",
      actorId: token.accountId ?? null, clientId: client, correlationId: randomUUID(),
      metadata: { tokenType: "access_token",
        ...(grantType === "authorization_code" || grantType === "refresh_token" ? { grantType } : {}),
        ...(scopes?.length ? { scopes } : {}),
      },
    });
  });
  provider.on("grant.revoked", (ctx: KoaContextWithOIDC) => {
    if (!client) return;
    const token = ctx.oidc.entities.RefreshToken ?? ctx.oidc.entities.AccessToken;
    const actorId = token?.accountId ?? ctx.oidc.entities.Session?.accountId ?? null;
    const tokenType = ctx.oidc.entities.RefreshToken ? "refresh_token" as const
      : ctx.oidc.entities.AccessToken ? "access_token" as const : undefined;
    submit({
      eventType: "token.revoked", outcome: "success", actorId,
      clientId: client, correlationId: randomUUID(),
      metadata: { ...(tokenType ? { tokenType } : {}), revocationConfirmed: true },
    });
  });
  provider.on("end_session.success", (ctx: KoaContextWithOIDC) => {
    if (!client) return;
    const sessionEnded = Boolean(ctx.oidc.params?.logout);
    submit({
      eventType: "logout.completed", outcome: "success",
      actorId: ctx.oidc.entities.Session?.accountId ?? null,
      clientId: client, correlationId: randomUUID(),
      metadata: sessionEnded ? { sessionEnded: true } : {},
    });
  });
  return { async drain() { await Promise.allSettled([...pending]); } };
}
