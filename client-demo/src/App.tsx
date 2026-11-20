import { useEffect, useRef, useState } from "react";
import { ConfigError } from "./config";
import { loadProfile, type ProfileResult } from "./profile";
import { currentPath, getConfig, getUserManager, takeCallbackUrl, takeLogoutReturn } from "./runtime";
import {
  ERROR_MESSAGES,
  handleCallbackOnce,
  login,
  logout,
  restoreSession,
  type CallbackResult,
  type Session,
} from "./session";

export const PROFILE_MESSAGES = {
  forbidden: "Access to the profile API was not granted (insufficient scope).",
  expired: "Your session expired. Please log in again.",
  error: "Could not load the profile. Try again later.",
} as const;

export const LOGOUT_WARNING =
  "Token revocation failed: access tokens already issued may stay valid for up to 300 seconds.";
export const LOGOUT_LOCAL_ONLY =
  "Could not reach the identity provider to end its session. You are logged out of this app only.";

type ProfileState = { status: "loading" } | ProfileResult;

// Verified ID Token session in, API data out. Nothing here is rendered for a user that is not verified.
function Dashboard({
  session,
  onLogout,
  onExpired,
}: {
  session: Session;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const expiredRef = useRef(onExpired); // keeps the effect from re-running on every parent render
  expiredRef.current = onExpired;

  useEffect(() => {
    let active = true;
    setProfile({ status: "loading" });
    let loading: Promise<ProfileResult>;
    try {
      loading = loadProfile(getUserManager(), getConfig().apiResource, session);
    } catch {
      loading = Promise.resolve({ status: "error" });
    }
    loading.then((r) => {
      if (!active) return;
      if (r.status === "expired") expiredRef.current();
      else setProfile(r);
    });
    return () => {
      active = false;
    };
  }, [session, attempt]);

  return (
    <main>
      <h1>APP-04 Demo Client</h1>
      <p>Logged in</p>
      <dl>
        <dt>sub</dt>
        <dd>{session.sub}</dd>
        {session.email && (
          <>
            <dt>email</dt>
            <dd>{session.email}</dd>
          </>
        )}
      </dl>
      <section aria-label="Protected API profile">
        <h2>Protected API</h2>
        {profile.status === "loading" && <p>Loading profile…</p>}
        {profile.status === "ok" && (
          <dl>
            <dt>API sub</dt>
            <dd data-testid="api-sub">{profile.sub}</dd>
          </dl>
        )}
        {profile.status === "forbidden" && <p role="alert">{PROFILE_MESSAGES.forbidden}</p>}
        {profile.status === "error" && (
          <>
            <p role="alert">{PROFILE_MESSAGES.error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </>
        )}
      </section>
      <button type="button" onClick={onLogout}>
        Logout
      </button>
    </main>
  );
}

function LoggedOutNotice({ kind }: { kind: "expired" | "logged_out" | "revoke_failed" | "local_only" }) {
  if (kind === "expired") return <p role="status">{PROFILE_MESSAGES.expired}</p>;
  return (
    <>
      <p role="status">You are logged out.</p>
      {kind === "revoke_failed" && <p role="alert">{LOGOUT_WARNING}</p>}
      {kind === "local_only" && <p role="alert">{LOGOUT_LOCAL_ONLY}</p>}
    </>
  );
}

type Notice = "expired" | "logged_out" | "revoke_failed" | "local_only";

function Home({ initialSession }: { initialSession?: Session }) {
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(initialSession ?? null);
  const [ready, setReady] = useState(initialSession !== undefined);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (initialSession) return;
    let active = true;
    let restoring: Promise<Session | null>;
    try {
      const um = getUserManager();
      // post-logout return first (consumes the logout flags), then whatever session is left
      restoring = takeLogoutReturn()
        .then((r) => {
          if (r.returned && active) setNotice(r.revokeFailed ? "revoke_failed" : "logged_out");
        })
        .catch(() => {})
        .then(() => restoreSession(um));
    } catch (e) {
      if (e instanceof ConfigError) setError(e.message);
      restoring = Promise.resolve(null);
    }
    restoring
      .catch(() => null)
      .then((s) => {
        if (!active) return;
        setSession(s);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [initialSession]);

  // Back/forward cache restores the old DOM without running effects: re-check the session so a
  // page frozen before logout (or expiry) never keeps showing protected data.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (!e.persisted) return;
      let um;
      try {
        um = getUserManager();
      } catch {
        setSession(null);
        return;
      }
      restoreSession(um)
        .catch(() => null)
        .then((s) => {
          setSession(s);
          if (!s) setNotice((n) => n ?? "logged_out");
        });
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function doLogin() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await login(getUserManager(), getConfig().apiResource);
      // the browser is navigating away; keep the button disabled
    } catch (e) {
      setError(e instanceof ConfigError ? e.message : "Could not start the login.");
      setPending(false);
    }
  }

  async function doLogout() {
    if (pending) return;
    setPending(true);
    let outcome: Awaited<ReturnType<typeof logout>> = "local_only";
    try {
      outcome = await logout(getUserManager());
    } catch {
      // logout() clears local state first; a throw before that only means we could not even start
    }
    if (outcome === "redirected") return; // navigating to the Provider; keep everything hidden
    setSession(null); // local_only: the redirect never started, so show the final state here
    setNotice("local_only");
    setPending(false);
  }

  if (!ready) {
    return (
      <main>
        <h1>APP-04 Demo Client</h1>
        <p>Loading…</p>
      </main>
    );
  }
  if (session) {
    return (
      <Dashboard
        session={session}
        onLogout={doLogout}
        onExpired={() => {
          setSession(null);
          setNotice("expired");
        }}
      />
    );
  }
  return (
    <main>
      <h1>APP-04 Demo Client</h1>
      {notice && <LoggedOutNotice kind={notice} />}
      <button type="button" onClick={doLogin} disabled={pending}>
        Login
      </button>
      {error && <p role="alert">Login failed: {error}</p>}
    </main>
  );
}

function Callback() {
  const [result, setResult] = useState<CallbackResult | null>(null);

  const [url] = useState(takeCallbackUrl);

  useEffect(() => {
    let active = true;
    let handling: Promise<CallbackResult>;
    try {
      handling = handleCallbackOnce(getUserManager(), url);
    } catch {
      handling = Promise.resolve({ ok: false, error: "exchange_failed" });
    }
    handling.then((r) => {
      if (active) setResult(r);
    });
    return () => {
      active = false;
    };
  }, [url]);

  if (!result) {
    return (
      <main>
        <h1>APP-04 Demo Client</h1>
        <p>Signing in…</p>
      </main>
    );
  }
  if (result.ok) return <Home initialSession={result.session} />;
  return (
    <main>
      <h1>APP-04 Demo Client</h1>
      <p role="alert">
        Login failed: {ERROR_MESSAGES[result.error]}
        {result.oauthCode && ` (${result.oauthCode})`}
      </p>
      <a href="/">Back to login</a>
    </main>
  );
}

export function App() {
  return currentPath() === "/callback" ? <Callback /> : <Home />;
}
