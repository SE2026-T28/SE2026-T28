import { useState } from "react";
import { createUserManager } from "./auth";
import { loadConfig } from "./config";

function Home() {
  const [error, setError] = useState<string | null>(null);

  async function login() {
    setError(null);
    try {
      await createUserManager(loadConfig()).signinRedirect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>APP-04 Demo Client</h1>
      <button type="button" onClick={login}>
        Login
      </button>
      {error && <p role="alert">Login failed: {error}</p>}
    </main>
  );
}

function Callback() {
  // Token exchange + ID token validation belong to issue C2.
  return (
    <main>
      <h1>APP-04 Demo Client</h1>
      <p>Callback received — handled in C2</p>
    </main>
  );
}

export function App() {
  return window.location.pathname === "/callback" ? <Callback /> : <Home />;
}
