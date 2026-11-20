import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import type { Prisma } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";

function value(payload: AdapterPayload, key: "grantId" | "uid" | "userCode"): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

function indexedValue(payload: AdapterPayload, key: "grantId" | "uid" | "userCode"): string | null {
  const raw = value(payload, key);
  return raw === null ? null : storageId(raw);
}

function storageId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function lockGrant(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
  // A transaction-scoped lock serializes refresh writes with grant revocation
  // across Provider processes, including when no artifact row exists yet.
  const lockId = createHash("sha256").update(grantId).digest().readBigInt64BE();
  await tx.$queryRaw`SELECT 1 AS acquired FROM (SELECT pg_advisory_xact_lock(${lockId})) AS grant_lock`;
}

const developmentKey = randomBytes(32);

type EncryptedPayload = { v: 1; iv: string; tag: string; data: string };

function encrypt(payload: AdapterPayload, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}

function decrypt(envelope: unknown, key: Buffer): AdapterPayload {
  if (!envelope || typeof envelope !== "object" || !Object.hasOwn(envelope, "v")) throw new Error("OIDC artifact payload format is invalid");
  const stored = envelope as EncryptedPayload;
  if (stored.v !== 1 || typeof stored.iv !== "string" || typeof stored.tag !== "string" || typeof stored.data !== "string") {
    throw new Error("OIDC artifact payload format is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, "base64url")), decipher.final()]).toString("utf8")) as AdapterPayload;
}

/** PostgreSQL-backed implementation of the oidc-provider 9.12.2 adapter API. */
export class PostgresOidcAdapter implements Adapter {
  private readonly key: Buffer;

  constructor(private readonly model: string, keyHex?: string) {
    this.key = keyHex ? Buffer.from(keyHex, "hex") : developmentKey;
    if (this.key.length !== 32) throw new Error("OIDC adapter key must be 32 bytes");
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const key = storageId(id);
    const expiry = typeof expiresIn === "number" ? Date.now() + expiresIn * 1000
      : typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
    const data = {
      payload: encrypt(payload, this.key) as unknown as Prisma.InputJsonValue,
      grantId: indexedValue(payload, "grantId"),
      uid: indexedValue(payload, "uid"),
      userCode: indexedValue(payload, "userCode"),
      expiresAt: expiry === undefined ? null : new Date(expiry),
      consumedAt: typeof payload.consumed === "number" ? new Date(payload.consumed * 1000) : null,
    };
    const grantId = value(payload, "grantId") ?? (this.model === "Grant" ? id : null);
    await getPrisma().$transaction(async tx => {
      if (grantId) {
        await lockGrant(tx, grantId);
        if (await tx.oidcRevokedGrant.findUnique({ where: { id: storageId(grantId) } })) {
          throw new errors.InvalidGrant("grant has been revoked");
        }
      }
      await tx.oidcArtifact.upsert({
        where: { model_id: { model: this.model, id: key } },
        create: { model: this.model, id: key, ...data },
        update: data,
      });
    });
  }

  private async lookup(where: { id?: string; uid?: string; userCode?: string }): Promise<AdapterPayload | undefined> {
    const row = await getPrisma().oidcArtifact.findFirst({
      where: {
        model: this.model,
        id: where.id === undefined ? undefined : storageId(where.id),
        uid: where.uid === undefined ? undefined : storageId(where.uid),
        userCode: where.userCode === undefined ? undefined : storageId(where.userCode),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row) return undefined;
    const payload = decrypt(row.payload, this.key);
    if (row.consumedAt) payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  find(id: string): Promise<AdapterPayload | undefined> { return this.lookup({ id }); }
  findByUid(uid: string): Promise<AdapterPayload | undefined> { return this.lookup({ uid }); }
  findByUserCode(userCode: string): Promise<AdapterPayload | undefined> { return this.lookup({ userCode }); }

  async consume(id: string): Promise<void> {
    // One SQL statement is the claim. Two concurrent refresh/code exchanges
    // cannot both consume the same artifact even across Provider processes.
    const now = new Date();
    const count = await getPrisma().$executeRaw`
      UPDATE "oidc_artifacts"
         SET "consumed_at" = ${now}
       WHERE "model" = ${this.model} AND "id" = ${storageId(id)}
         AND "consumed_at" IS NULL
         AND ("expires_at" IS NULL OR "expires_at" > ${now})`;
    if (count !== 1) throw new errors.InvalidGrant("artifact unavailable or already consumed");
  }

  async destroy(id: string): Promise<void> {
    await getPrisma().oidcArtifact.deleteMany({ where: { model: this.model, id: storageId(id) } });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await getPrisma().$transaction(async tx => {
      await lockGrant(tx, grantId);
      const id = storageId(grantId);
      await tx.oidcRevokedGrant.upsert({ where: { id }, create: { id }, update: {} });
      // Delete across models while holding the fence. Provider invokes this
      // method on one adapter model, but the grant spans several token types.
      await tx.oidcArtifact.deleteMany({ where: { grantId: id } });
    });
  }
}

export async function cleanupExpiredOidcArtifacts(): Promise<number> {
  const result = await getPrisma().oidcArtifact.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
