import { useEffect, useState } from "react";
import { ConfigError } from "./config";
import { currentPath, getUserManager, takeCallbackUrl } from "./runtime";
import {
  ERROR_MESSAGES,
  handleCallbackOnce,
  login,
  logout,
  restoreSession,
  type CallbackResult,
  type Session,
} from "./session";

function Dashboard({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
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
      <button type="button" onClick={onLogout}>
        Logout
      </button>
    </main>
  );
}

function Home() {
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    let restoring: Promise<Session | null>;
    try {
      restoring = restoreSession(getUserManager());
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
  }, []);

  async function doLogin() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await login(getUserManager());
      // the browser is navigating away; keep the button disabled
    } catch (e) {
      setError(e instanceof ConfigError ? e.message : "Could not start the login.");
      setPending(false);
    }
  }

  async function doLogout() {
    await logout(getUserManager());
    setSession(null);
  }

  if (!ready) {
    return (
      <main>
        <h1>APP-04 Demo Client</h1>
        <p>Loading…</p>
      </main>
    );
  }
  if (session) return <Dashboard session={session} onLogout={doLogout} />;
  return (
    <main>
      <h1>APP-04 Demo Client</h1>
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
  if (result.ok) {
    return (
      <Dashboard
        session={result.session}
        onLogout={async () => {
          await logout(getUserManager());
          window.location.assign("/");
        }}
      />
    );
  }
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
