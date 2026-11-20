import type { UserManager } from "oidc-client-ts";
import {
  clearSession,
  isAccessTokenExpired,
  refreshSession,
  type Session,
  type SessionDeps,
} from "./session";

// Fixed outcomes only: no server text, no token text ever reaches the UI.
export type ProfileResult =
  | { status: "ok"; sub: string }
  | { status: "forbidden" }
  | { status: "expired" }
  | { status: "error" };

export interface ProfileDeps extends SessionDeps {
  fetch?: typeof fetch;
}

type ApiOutcome =
  | { kind: "ok"; sub: string }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "error" };

async function callApi(
  apiResource: string,
  accessToken: string,
  doFetch: typeof fetch,
): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await doFetch(`${apiResource.replace(/\/+$/, "")}/protected/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, // header only, never the URL
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    return { kind: "error" };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status !== 200) return { kind: "error" };
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      typeof (body as { sub?: unknown }).sub === "string" &&
      (body as { sub: string }).sub !== ""
    ) {
      return { kind: "ok", sub: (body as { sub: string }).sub };
    }
  } catch {
    // fall through
  }
  return { kind: "error" };
}

async function run(
  um: UserManager,
  apiResource: string,
  session: Session,
  deps: ProfileDeps,
): Promise<ProfileResult> {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const user = await um.getUser().catch(() => null);
  if (!user?.access_token) {
    await clearSession(um, deps.storage);
    return { status: "expired" };
  }
  let token = user.access_token;
  let refreshed = false; // exactly one refresh per load
  if (isAccessTokenExpired(user)) {
    const r = await refreshSession(um, apiResource, session.sub, deps, token);
    if (!r.ok) return { status: "expired" }; // refreshSession already cleared the session
    token = r.accessToken;
    refreshed = true;
  }
  for (;;) {
    const out = await callApi(apiResource, token, doFetch);
    switch (out.kind) {
      case "ok":
        // the API answer must belong to the user whose ID Token we verified
        return out.sub === session.sub ? { status: "ok", sub: out.sub } : { status: "error" };
      case "forbidden":
        return { status: "forbidden" };
      case "error":
        return { status: "error" };
      case "unauthorized": {
        if (refreshed) {
          await clearSession(um, deps.storage);
          return { status: "expired" };
        }
        refreshed = true;
        const r = await refreshSession(um, apiResource, session.sub, deps, token);
        if (!r.ok) return { status: "expired" };
        token = r.accessToken;
      }
    }
  }
}

// Keyed by who and where: a load for another user (or API) must never be answered with this one.
const inflight = new Map<string, Promise<ProfileResult>>();

export function resetProfileForTests(): void {
  inflight.clear();
}

// Single-flight so StrictMode's double effect (or a double click) makes one API call.
export function loadProfile(
  um: UserManager,
  apiResource: string,
  session: Session,
  deps: ProfileDeps = {},
): Promise<ProfileResult> {
  const key = JSON.stringify([apiResource, session.sub]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p: Promise<ProfileResult> = run(um, apiResource, session, deps)
    .catch((): ProfileResult => ({ status: "error" }))
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
