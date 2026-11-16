import { createHash } from "node:crypto";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import type { Prisma } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";

function value(payload: AdapterPayload, key: "grantId" | "uid" | "userCode"): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

function storageId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** PostgreSQL-backed implementation of the oidc-provider 9.12.2 adapter API. */
export class PostgresOidcAdapter implements Adapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const key = storageId(id);
    const expiry = typeof expiresIn === "number" ? Date.now() + expiresIn * 1000
      : typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
    const data = {
      payload: payload as unknown as Prisma.InputJsonValue,
      grantId: value(payload, "grantId"),
      uid: value(payload, "uid"),
      userCode: value(payload, "userCode"),
      expiresAt: expiry === undefined ? null : new Date(expiry),
      consumedAt: typeof payload.consumed === "number" ? new Date(payload.consumed * 1000) : null,
    };
    await getPrisma().oidcArtifact.upsert({
      where: { model_id: { model: this.model, id: key } },
      create: { model: this.model, id: key, ...data },
      update: data,
    });
  }

  private async lookup(where: { id?: string; uid?: string; userCode?: string }): Promise<AdapterPayload | undefined> {
    const row = await getPrisma().oidcArtifact.findFirst({
      where: {
        model: this.model, ...where, id: where.id === undefined ? undefined : storageId(where.id),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    return row?.payload as AdapterPayload | undefined;
  }

  find(id: string): Promise<AdapterPayload | undefined> { return this.lookup({ id }); }
  findByUid(uid: string): Promise<AdapterPayload | undefined> { return this.lookup({ uid }); }
  findByUserCode(userCode: string): Promise<AdapterPayload | undefined> { return this.lookup({ userCode }); }

  async consume(id: string): Promise<void> {
    // One SQL statement is the claim. Two concurrent refresh/code exchanges
    // cannot both consume the same artifact even across Provider processes.
    const count = await getPrisma().$executeRaw`
      UPDATE "oidc_artifacts"
         SET "payload" = jsonb_set("payload", '{consumed}',
               to_jsonb(floor(extract(epoch FROM clock_timestamp()))::bigint), true),
             "consumed_at" = clock_timestamp()
       WHERE "model" = ${this.model} AND "id" = ${storageId(id)}
         AND "consumed_at" IS NULL
         AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())`;
    if (count !== 1) throw new errors.InvalidGrant("artifact unavailable or already consumed");
  }

  async destroy(id: string): Promise<void> {
    await getPrisma().oidcArtifact.deleteMany({ where: { model: this.model, id: storageId(id) } });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await getPrisma().oidcArtifact.deleteMany({ where: { model: this.model, grantId } });
  }
}
