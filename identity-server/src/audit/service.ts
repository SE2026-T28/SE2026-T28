import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";

export const AUDIT_EVENT_TYPES = Object.freeze([
  "login.success", "login.failure", "mfa.success", "mfa.failure",
  "token.issued", "token.revoked", "logout.completed",
] as const);
export const AUDIT_REASON_CODES = Object.freeze([
  "invalid_credentials", "rate_limited", "csrf_rejected", "expired",
  "invalid_challenge", "invalid_token", "invalid_grant", "denied", "internal_error",
] as const);
const SCOPES = ["openid", "profile", "email", "api:read", "offline_access"] as const;
type Scope = typeof SCOPES[number];
export type AuditEventType = typeof AUDIT_EVENT_TYPES[number];
export type AuditOutcome = "success" | "failure";
export type AuditReasonCode = typeof AUDIT_REASON_CODES[number];

type AttemptMetadata = { attemptCount?: number };
type MetadataByEvent = {
  "login.success": AttemptMetadata;
  "login.failure": AttemptMetadata;
  "mfa.success": AttemptMetadata & { mfaMethod?: "mock" };
  "mfa.failure": AttemptMetadata & { mfaMethod?: "mock" };
  "token.issued": {
    tokenType?: "access_token" | "id_token" | "refresh_token";
    grantType?: "authorization_code" | "refresh_token";
    scopes?: readonly Scope[];
  };
  "token.revoked": { tokenType?: "access_token" | "refresh_token"; revocationConfirmed?: boolean };
  "logout.completed": { sessionEnded?: boolean };
};
export type AuditEventInput = {
  [T in AuditEventType]: {
    eventType: T;
    outcome: AuditOutcome;
    actorId?: string | null;
    clientId?: "app04-react-demo" | null;
    correlationId?: string | null;
    reasonCode?: AuditReasonCode | null;
    metadata?: MetadataByEvent[T];
  }
}[AuditEventType];

export type AuditWriteResult = { ok: true; eventId: string }
  | { ok: false; error: "invalid_event" | "write_failed" };
export type AuditRecorder = (event: AuditEventInput) => Promise<AuditWriteResult>;
export interface AuditRow {
  id: string;
  eventType: AuditEventType;
  outcome: AuditOutcome;
  actorId: string | null;
  clientId: string | null;
  correlationId: string | null;
  reasonCode: AuditReasonCode | null;
  occurredAt: Date;
  metadata: Prisma.InputJsonObject;
}
export type AuditWriter = (row: AuditRow) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEYS = ["eventType", "outcome", "actorId", "clientId", "correlationId", "reasonCode", "metadata"];
const METADATA_KEYS: Record<AuditEventType, readonly string[]> = {
  "login.success": ["attemptCount"], "login.failure": ["attemptCount"],
  "mfa.success": ["attemptCount", "mfaMethod"], "mfa.failure": ["attemptCount", "mfaMethod"],
  "token.issued": ["tokenType", "grantType", "scopes"],
  "token.revoked": ["tokenType", "revocationConfirmed"],
  "logout.completed": ["sessionEnded"],
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === "string")
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor);
}

function member<T extends string>(value: unknown, values: readonly T[], max: number): value is T {
  return typeof value === "string" && value.length <= max && values.includes(value as T);
}

function nullableUuid(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length === 36 && UUID.test(value));
}

function metadataFor(eventType: AuditEventType, outcome: AuditOutcome, input: unknown): Prisma.InputJsonObject | undefined {
  if (!plainRecord(input) || Object.getOwnPropertyNames(input).some(key => !METADATA_KEYS[eventType].includes(key))) return undefined;
  const output: Record<string, Prisma.InputJsonValue> = {};
  for (const key of Object.getOwnPropertyNames(input)) {
    const value = input[key];
    switch (key) {
      case "attemptCount":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) return undefined;
        output[key] = value;
        break;
      case "mfaMethod":
        if (value !== "mock") return undefined;
        output[key] = value;
        break;
      case "tokenType":
        if (!member(value, eventType === "token.revoked"
          ? ["access_token", "refresh_token"] : ["access_token", "id_token", "refresh_token"], 16)) return undefined;
        output[key] = value;
        break;
      case "grantType":
        if (!member(value, ["authorization_code", "refresh_token"], 32)) return undefined;
        output[key] = value;
        break;
      case "scopes": {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
        const length = value.length;
        if (!Number.isInteger(length) || length < 0 || length > SCOPES.length) return undefined;
        const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
        if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowedKeys.has(key))) return undefined;
        const scopes: Scope[] = [];
        for (let index = 0; index < length; index++) {
          const item = Object.getOwnPropertyDescriptor(value, String(index));
          if (!item || !("value" in item) || !member(item.value, SCOPES, 32) || scopes.includes(item.value)) return undefined;
          scopes.push(item.value);
        }
        output[key] = scopes;
        break;
      }
      case "revocationConfirmed":
      case "sessionEnded":
        if (typeof value !== "boolean" || value !== (outcome === "success")) return undefined;
        output[key] = value;
        break;
    }
  }
  return Buffer.byteLength(JSON.stringify(output), "utf8") <= 1024 ? output : undefined;
}

function validatedRow(input: unknown): AuditRow | undefined {
  if (!plainRecord(input) || Object.getOwnPropertyNames(input).some(key => !INPUT_KEYS.includes(key))) return undefined;
  const { eventType, outcome, actorId, clientId, correlationId, reasonCode } = input;
  if (!member(eventType, AUDIT_EVENT_TYPES, 64) || !member(outcome, ["success", "failure"], 7)
    || !nullableUuid(actorId) || !nullableUuid(correlationId)
    || (clientId !== undefined && clientId !== null && !member(clientId, ["app04-react-demo"], 64))
    || (reasonCode !== undefined && reasonCode !== null && !member(reasonCode, AUDIT_REASON_CODES, 64))) return undefined;
  if ((eventType.endsWith(".success") || eventType === "logout.completed") && outcome !== "success") return undefined;
  if (eventType.endsWith(".failure") && outcome !== "failure") return undefined;
  const metadata = metadataFor(eventType, outcome, input.metadata === undefined ? {} : input.metadata);
  if (!metadata) return undefined;
  return {
    id: randomUUID(), eventType, outcome, actorId: actorId ?? null,
    clientId: clientId ?? null, correlationId: correlationId ?? null,
    reasonCode: reasonCode ?? null, occurredAt: new Date(), metadata,
  };
}

async function persistAudit(row: AuditRow): Promise<void> {
  await getPrisma().auditEvent.create({ data: row });
}

/** Callers must inspect the result and choose their operation's failure policy. */
export function createAuditService(write: AuditWriter = persistAudit): AuditRecorder {
  return async input => {
    let row: AuditRow | undefined;
    try { row = validatedRow(input); }
    catch { return { ok: false, error: "invalid_event" }; }
    if (!row) return { ok: false, error: "invalid_event" };
    try {
      await write(row);
      return { ok: true, eventId: row.id };
    } catch {
      return { ok: false, error: "write_failed" };
    }
  };
}

export const recordAuditEvent: AuditRecorder = createAuditService();
