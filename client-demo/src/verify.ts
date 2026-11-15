import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { UserManager } from "oidc-client-ts";

const SUPPORTED_ALGS = ["RS256", "PS256", "ES256"]; // asymmetric only, never none/HS*
const DEFAULT_ALGS = ["RS256"];
const CLOCK_TOLERANCE_SECONDS = 30;

export type VerifyCategory = "token_invalid" | "nonce_mismatch";

export class VerifyError extends Error {
  readonly category: VerifyCategory;
  constructor(category: VerifyCategory) {
    super(category); // never carries token text
    this.category = category;
  }
}

export interface VerifyOptions {
  keys: JWTVerifyGetKey;
  issuer: string;
  clientId: string;
  algorithms: string[];
  nonce?: string; // when set (even empty), the nonce claim must be a non-empty string equal to it
  now?: Date;
}

export async function verifyIdToken(
  idToken: string | undefined,
  opts: VerifyOptions,
): Promise<JWTPayload> {
  if (!idToken) throw new VerifyError("token_invalid");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keys, {
      issuer: opts.issuer,
      audience: opts.clientId,
      algorithms: opts.algorithms,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: opts.now,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch {
    throw new VerifyError("token_invalid");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new VerifyError("token_invalid");
  }
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (payload.iat! > nowSec + CLOCK_TOLERANCE_SECONDS) {
    throw new VerifyError("token_invalid");
  }
  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== opts.clientId) {
    throw new VerifyError("token_invalid"); // OIDC Core 3.1.3.7 rule 4-5
  }
  if (payload.azp !== undefined && payload.azp !== opts.clientId) {
    throw new VerifyError("token_invalid");
  }
  if (
    opts.nonce !== undefined &&
    (!opts.nonce || typeof payload.nonce !== "string" || payload.nonce !== opts.nonce)
  ) {
    throw new VerifyError("nonce_mismatch");
  }
  return payload;
}

export interface KeyMaterial {
  keys: JWTVerifyGetKey;
  algorithms: string[];
}

export type KeyResolver = (um: UserManager) => Promise<KeyMaterial>;

const remoteKeys = new Map<string, KeyMaterial>(); // by jwks_uri: survives new UserManager instances

// jwks_uri and signing algs come from Discovery; JWKS is fetched/cached by jose
export const resolveRemoteKeys: KeyResolver = async (um) => {
  const meta = await um.metadataService.getMetadata();
  if (!meta.jwks_uri) throw new VerifyError("token_invalid");
  const advertised = (meta as { id_token_signing_alg_values_supported?: string[] })
    .id_token_signing_alg_values_supported; // not in OidcMetadata typings
  const algorithms = advertised
    ? SUPPORTED_ALGS.filter((a) => advertised.includes(a))
    : DEFAULT_ALGS;
  if (algorithms.length === 0) throw new VerifyError("token_invalid");
  const cacheKey = `${meta.jwks_uri} ${algorithms.join(",")}`;
  const cached = remoteKeys.get(cacheKey);
  if (cached) return cached;
  const material = {
    keys: createRemoteJWKSet(new URL(meta.jwks_uri)),
    algorithms,
  };
  remoteKeys.set(cacheKey, material);
  return material;
};
