export interface OidcConfig {
  authority: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scope: string;
  apiResource: string; // RFC 8707 resource indicator = protected API base URL, also the Access Token audience
}

export class ConfigError extends Error {} // safe to show: only names env vars

type EnvRecord = Record<string, string | undefined>;

const REQUIRED = {
  authority: "VITE_OIDC_AUTHORITY",
  clientId: "VITE_OIDC_CLIENT_ID",
  redirectUri: "VITE_OIDC_REDIRECT_URI",
  postLogoutRedirectUri: "VITE_OIDC_POST_LOGOUT_REDIRECT_URI",
  scope: "VITE_OIDC_SCOPE",
} as const;

const API_RESOURCE_ENV = "VITE_API_RESOURCE"; // optional override

function resolveApiResource(authority: string, override: string | undefined): string {
  if (!override) return `${authority.replace(/\/+$/, "")}/api`; // contract: <issuer>/api
  let url: URL;
  let base: URL;
  try {
    url = new URL(override);
    base = new URL(authority);
  } catch {
    throw new ConfigError(`${API_RESOURCE_ENV} must be an absolute http(s) URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new ConfigError(
      `${API_RESOURCE_ENV} must be an http(s) URL without query, fragment or credentials.`,
    );
  }
  if (url.origin !== base.origin) {
    // the Access Token is sent to this URL: it must stay on the identity provider's origin
    throw new ConfigError(`${API_RESOURCE_ENV} must have the same origin as VITE_OIDC_AUTHORITY.`);
  }
  return url.href.replace(/\/+$/, "");
}

export function readConfig(env: EnvRecord): OidcConfig {
  const out: Partial<OidcConfig> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(REQUIRED)) {
    const value = env[name]?.trim();
    if (value) out[key as keyof OidcConfig] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing env var(s): ${missing.join(", ")}. Copy .env.example to .env.`,
    );
  }
  const config = out as OidcConfig;
  config.apiResource = resolveApiResource(config.authority, env[API_RESOURCE_ENV]?.trim());
  if (!config.scope.split(/\s+/).includes("openid")) {
    throw new ConfigError('VITE_OIDC_SCOPE must include the "openid" scope.');
  }
  return config;
}

export function loadConfig(): OidcConfig {
  return readConfig(import.meta.env as EnvRecord);
}
