import { ErrorResponse, type UserManager } from "oidc-client-ts";
import {
  resolveRemoteKeys,
  verifyIdToken,
  VerifyError,
  type KeyResolver,
} from "./verify";

export const VERIFIED_KEY = "app04.verified"; // SHA-256 of the ID Token that passed full verification

export interface Session {
  sub: string;
  email?: string; // only when present in the verified ID Token
}

export type CallbackError =
  | "oauth_error"
  | "state_missing"
  | "state_invalid"
  | "code_missing"
  | "exchange_failed"
  | "token_invalid"
  | "nonce_mismatch";

export type CallbackResult =
  | { ok: true; session: Session }
  | { ok: false; error: CallbackError; oauthCode?: string };

export interface SessionDeps {
  resolveKeys?: KeyResolver;
  storage?: Storage;
  now?: Date;
}

const OAUTH_CODES = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "login_required",
  "consent_required",
  "interaction_required",
]);

export const ERROR_MESSAGES: Record<CallbackError, string> = {
  oauth_error: "The identity provider returned an error.",
  state_missing: "Login response is missing state.",
  state_invalid: "Login response state is invalid or expired.",
  code_missing: "Login response is missing the authorization code.",
  exchange_failed: "Could not complete the login.",
  token_invalid: "ID Token verification failed.",
  nonce_mismatch: "ID Token nonce does not match this login.",
};

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// The library keeps the nonce in its per-state record; handleCallback reads it back from there.
export async function login(um: UserManager): Promise<void> {
  await um.signinRedirect({ nonce: randomNonce() });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The library only checks nonce when its stored copy is non-empty; we fail closed instead.
async function readExpectedNonce(um: UserManager, state: string): Promise<string> {
  try {
    const raw = await um.settings.stateStore.get(state);
    const nonce = raw ? (JSON.parse(raw) as { nonce?: unknown }).nonce : "";
    return typeof nonce === "string" ? nonce : "";
  } catch {
    return "";
  }
}

function toSession(claims: Record<string, unknown>): Session {
  const session: Session = { sub: claims.sub as string };
  if (typeof claims.email === "string" && claims.email) {
    session.email = claims.email;
  }
  return session;
}

async function fail(
  um: UserManager,
  storage: Storage,
  error: CallbackError,
  extra: { oauthCode?: string } = {},
): Promise<CallbackResult> {
  storage.removeItem(VERIFIED_KEY);
  await um.removeUser().catch(() => {});
  return { ok: false, error, ...extra };
}

export async function handleCallback(
  um: UserManager,
  url: string,
  deps: SessionDeps = {},
): Promise<CallbackResult> {
  const storage = deps.storage ?? window.sessionStorage;
  try {
    return await processCallback(um, url, storage, deps);
  } catch {
    return fail(um, storage, "exchange_failed"); // single failure path for unexpected throws
  }
}

// Exact strings from oidc-client-ts 3.5.0 / jwt-decode; anything else is a generic exchange failure.
function classifyLibraryError(e: unknown): CallbackError {
  if (e instanceof ErrorResponse) return "exchange_failed"; // IdP text never inspected
  if (!(e instanceof Error)) return "exchange_failed";
  if (e.message === "nonce in id_token does not match nonce in client storage") {
    return "nonce_mismatch";
  }
  if (e.name === "InvalidTokenError" || e.message === "ID Token is missing a subject claim") {
    return "token_invalid";
  }
  return "exchange_failed";
}

async function processCallback(
  um: UserManager,
  url: string,
  storage: Storage,
  deps: SessionDeps,
): Promise<CallbackResult> {
  const resolveKeys = deps.resolveKeys ?? resolveRemoteKeys;
  const params = new URL(url).searchParams;
  const state = params.get("state");

  // Until the state matches one of our own stored logins, a crafted link must not touch the session.
  const matched = state ? Boolean(await um.settings.stateStore.get(state)) : false;

  if (params.has("error")) {
    const code = params.get("error") ?? "";
    const extra = { oauthCode: OAUTH_CODES.has(code) ? code : undefined };
    if (!state || !matched) return { ok: false, error: "oauth_error", ...extra };
    await um.settings.stateStore.remove(state);
    return fail(um, storage, "oauth_error", extra);
  }
  if (!state) return { ok: false, error: "state_missing" };
  if (!matched) return { ok: false, error: "state_invalid" };
  if (!params.get("code")) {
    await um.settings.stateStore.remove(state);
    return fail(um, storage, "code_missing");
  }
  const expectedNonce = await readExpectedNonce(um, state);
  if (!expectedNonce) {
    await um.settings.stateStore.remove(state);
    return fail(um, storage, "nonce_mismatch"); // before the code is spent
  }

  storage.removeItem(VERIFIED_KEY); // a new login supersedes any earlier verified marker
  let idToken: string | undefined;
  try {
    // checks state, exchanges the code with the PKCE verifier; stores the user BEFORE we verify
    idToken = (await um.signinRedirectCallback(url)).id_token;
  } catch (e) {
    return fail(um, storage, classifyLibraryError(e));
  }
  // The library does not verify the signature: do it now.
  try {
    const { keys, algorithms } = await resolveKeys(um);
    const claims = await verifyIdToken(idToken, {
      keys,
      algorithms,
      issuer: um.settings.authority,
      clientId: um.settings.client_id,
      nonce: expectedNonce,
      now: deps.now,
    });
    storage.setItem(VERIFIED_KEY, await sha256Hex(idToken!));
    return { ok: true, session: toSession(claims) };
  } catch (e) {
    return fail(
      um,
      storage,
      e instanceof VerifyError ? e.category : "token_invalid",
    );
  }
}

// Never trust the stored user: it needs our verified marker, then its ID Token is re-verified.
export async function restoreSession(
  um: UserManager,
  deps: SessionDeps = {},
): Promise<Session | null> {
  const resolveKeys = deps.resolveKeys ?? resolveRemoteKeys;
  const storage = deps.storage ?? window.sessionStorage;
  let user;
  try {
    user = await um.getUser();
  } catch {
    user = null;
  }
  if (!user) {
    storage.removeItem(VERIFIED_KEY);
    return null;
  }
  try {
    const marker = storage.getItem(VERIFIED_KEY);
    if (!user.id_token || !marker || marker !== (await sha256Hex(user.id_token))) {
      throw new VerifyError("token_invalid"); // stored but never fully verified
    }
    const { keys, algorithms } = await resolveKeys(um);
    const claims = await verifyIdToken(user.id_token, {
      keys,
      algorithms,
      issuer: um.settings.authority,
      clientId: um.settings.client_id,
      now: deps.now,
    });
    return toSession(claims);
  } catch {
    storage.removeItem(VERIFIED_KEY);
    await um.removeUser().catch(() => {});
    return null;
  }
}

const inflight = new Map<string, Promise<CallbackResult>>();

export function resetInflightForTests(): void {
  inflight.clear();
}

// StrictMode runs effects twice; the one-time code must be exchanged once per URL.
export function handleCallbackOnce(
  um: UserManager,
  url: string,
  deps?: SessionDeps,
): Promise<CallbackResult> {
  let p = inflight.get(url);
  if (!p) {
    p = handleCallback(um, url, deps);
    inflight.set(url, p);
  }
  return p;
}

export async function logout(
  um: UserManager,
  storage: Storage = window.sessionStorage,
): Promise<void> {
  storage.removeItem(VERIFIED_KEY);
  await um.removeUser(); // local only; RP-initiated logout is C5
}
