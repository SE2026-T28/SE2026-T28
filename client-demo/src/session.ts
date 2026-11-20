import { ErrorResponse, type User, type UserManager } from "oidc-client-ts";
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
// resource (RFC 8707) goes on the authorization request AND the code exchange; prompt=consent is
// required or oidc-provider drops offline_access (no refresh token).
export async function login(um: UserManager, apiResource: string): Promise<void> {
  await um.signinRedirect({
    nonce: randomNonce(),
    prompt: "consent",
    resource: apiResource,
    extraTokenParams: { resource: apiResource },
  });
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

export async function clearSession(
  um: UserManager,
  storage: Storage = window.sessionStorage,
): Promise<void> {
  storage.removeItem(VERIFIED_KEY);
  await um.removeUser().catch(() => {});
}

// ---- C4: refresh ----------------------------------------------------------------------------

export type RefreshResult = { ok: true; accessToken: string } | { ok: false };

const EXPIRY_SKEW_MS = 5_000;

export function isAccessTokenExpired(user: User, nowMs: number = Date.now()): boolean {
  return user.expires_at !== undefined && user.expires_at * 1000 <= nowMs + EXPIRY_SKEW_MS;
}

let refreshInflight: Promise<RefreshResult> | null = null;

export function resetRefreshForTests(): void {
  refreshInflight = null;
}

// Single-flight: refresh tokens rotate, so two parallel refreshes would make the loser fail with
// invalid_grant. `staleToken` is the access token the caller just got a 401 for: when the stored
// token already differs (a refresh finished between the 401 and this call) it is reused.
export function refreshSession(
  um: UserManager,
  apiResource: string,
  expectedSub: string,
  deps: SessionDeps = {},
  staleToken?: string,
): Promise<RefreshResult> {
  if (refreshInflight) return refreshInflight;
  const p: Promise<RefreshResult> = (async (): Promise<RefreshResult> => {
    if (staleToken) {
      const current = await um.getUser().catch(() => null);
      if (
        current?.access_token &&
        current.access_token !== staleToken &&
        !isAccessTokenExpired(current)
      ) {
        return { ok: true, accessToken: current.access_token };
      }
    }
    return doRefresh(um, apiResource, expectedSub, deps);
  })().finally(() => {
    if (refreshInflight === p) refreshInflight = null;
  });
  refreshInflight = p;
  return p;
}

async function doRefresh(
  um: UserManager,
  apiResource: string,
  expectedSub: string,
  deps: SessionDeps,
): Promise<RefreshResult> {
  const storage = deps.storage ?? window.sessionStorage;
  const failed = async (): Promise<RefreshResult> => {
    await clearSession(um, storage); // revoked / expired / unverifiable: never keep it
    return { ok: false };
  };
  const before = await um.getUser().catch(() => null);
  if (!before?.refresh_token) return failed();
  let user: User | null;
  try {
    user = await um.signinSilent({
      resource: apiResource,
      extraTokenParams: { resource: apiResource },
    });
  } catch {
    return failed(); // invalid_grant, revoked, network: details are never surfaced
  }
  if (!user?.access_token || !user.id_token) return failed();
  try {
    const marker = storage.getItem(VERIFIED_KEY);
    const digest = await sha256Hex(user.id_token);
    if (marker !== digest) {
      // New ID Token from the refresh response: full verification, except the nonce
      // (OIDC Core 12.2: a refreshed ID Token need not carry one).
      const resolveKeys = deps.resolveKeys ?? resolveRemoteKeys;
      const { keys, algorithms } = await resolveKeys(um);
      const claims = await verifyIdToken(user.id_token, {
        keys,
        algorithms,
        issuer: um.settings.authority,
        clientId: um.settings.client_id,
        now: deps.now,
      });
      if (claims.sub !== expectedSub) throw new VerifyError("token_invalid");
      storage.setItem(VERIFIED_KEY, digest);
    }
  } catch {
    return failed();
  }
  return { ok: true, accessToken: user.access_token };
}

// ---- C5: logout -----------------------------------------------------------------------------

export const LOGOUT_PENDING_KEY = "app04.logout.pending"; // set just before RP-initiated logout
export const LOGOUT_WARNING_KEY = "app04.logout.revoke_failed"; // non-sensitive flag, no token text

export type LogoutOutcome = "redirected" | "local_only";

// Order matters: (1) revoke at the Provider, (2) capture id_token + wipe client state,
// (3) end the Provider session. RP logout alone never revokes tokens.
export async function logout(
  um: UserManager,
  storage: Storage = window.sessionStorage,
): Promise<LogoutOutcome> {
  const user = await um.getUser().catch(() => null);
  const idToken = user?.id_token;
  let revoked = true;
  try {
    // revoking the refresh token also revokes its grant and the Access Tokens issued from it
    if (user?.refresh_token) await um.revokeTokens(["refresh_token"]);
    else if (user?.access_token) await um.revokeTokens(["access_token"]);
  } catch {
    revoked = false; // still log out; warn after the redirect returns
  }
  storage.removeItem(VERIFIED_KEY);
  await um.removeUser().catch(() => {});
  storage.removeItem(LOGOUT_WARNING_KEY);
  if (!revoked) storage.setItem(LOGOUT_WARNING_KEY, "1");
  storage.setItem(LOGOUT_PENDING_KEY, "1");
  try {
    // state: {} makes the library send a state it can match on return; the flow also works
    // when the Provider does not echo it.
    await um.signoutRedirect({ ...(idToken ? { id_token_hint: idToken } : {}), state: {} });
    return "redirected";
  } catch {
    storage.removeItem(LOGOUT_PENDING_KEY);
    return "local_only"; // e.g. Discovery has no end_session_endpoint
  }
}

export interface LogoutReturn {
  returned: boolean;
  revokeFailed: boolean;
}

// Called on the post_logout_redirect_uri. Local state is already gone; this only consumes our
// flags, lets the library drop its signout state, and scrubs the address bar.
export async function processLogoutReturn(
  um: UserManager,
  url: string,
  storage: Storage = window.sessionStorage,
): Promise<LogoutReturn> {
  if (storage.getItem(LOGOUT_PENDING_KEY) !== "1") {
    return { returned: false, revokeFailed: false };
  }
  const revokeFailed = storage.getItem(LOGOUT_WARNING_KEY) === "1";
  storage.removeItem(LOGOUT_PENDING_KEY);
  storage.removeItem(LOGOUT_WARNING_KEY);
  const params = new URL(url).searchParams;
  if (params.has("state")) {
    try {
      await um.signoutCallback(url);
    } catch {
      // unknown/expired state or Provider error: the user is already logged out locally
    }
  }
  if (params.size > 0) window.history.replaceState(null, "", "/");
  await clearSession(um, storage); // defensive: nothing may survive a logout
  return { returned: true, revokeFailed };
}
