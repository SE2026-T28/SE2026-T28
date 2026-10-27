export interface OidcConfig {
  authority: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scope: string;
}

type EnvRecord = Record<string, string | undefined>;

const REQUIRED = {
  authority: "VITE_OIDC_AUTHORITY",
  clientId: "VITE_OIDC_CLIENT_ID",
  redirectUri: "VITE_OIDC_REDIRECT_URI",
  postLogoutRedirectUri: "VITE_OIDC_POST_LOGOUT_REDIRECT_URI",
  scope: "VITE_OIDC_SCOPE",
} as const;

export function readConfig(env: EnvRecord): OidcConfig {
  const out: Partial<OidcConfig> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(REQUIRED)) {
    const value = env[name]?.trim();
    if (value) out[key as keyof OidcConfig] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing env var(s): ${missing.join(", ")}. Copy .env.example to .env.`,
    );
  }
  const config = out as OidcConfig;
  if (!config.scope.split(/\s+/).includes("openid")) {
    throw new Error('VITE_OIDC_SCOPE must include the "openid" scope.');
  }
  return config;
}

export function loadConfig(): OidcConfig {
  return readConfig(import.meta.env as EnvRecord);
}
