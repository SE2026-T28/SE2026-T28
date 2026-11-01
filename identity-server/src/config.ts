export interface AppConfig {
  port: number;
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string[];
  corsOrigin: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; copy .env.example to .env`);
  return value;
}

function localUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a plain http://localhost URL for local O1`);
  }
  return url;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.NODE_ENV === "production") {
    throw new Error("O1 uses in-memory OIDC storage and ephemeral keys; production is not supported yet");
  }

  const port = Number(required(env, "PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const issuer = localUrl(required(env, "OIDC_ISSUER"), "OIDC_ISSUER");
  const redirect = localUrl(required(env, "OIDC_REDIRECT_URI"), "OIDC_REDIRECT_URI");
  const postLogout = localUrl(required(env, "OIDC_POST_LOGOUT_REDIRECT_URI"), "OIDC_POST_LOGOUT_REDIRECT_URI");
  const cors = localUrl(required(env, "OIDC_CORS_ORIGIN"), "OIDC_CORS_ORIGIN");
  if (issuer.pathname !== "/" || issuer.origin !== `http://localhost:${port}`) {
    throw new Error("OIDC_ISSUER must equal http://localhost:PORT without a path");
  }
  if (cors.href !== cors.origin + "/" || redirect.origin !== cors.origin || postLogout.origin !== cors.origin) {
    throw new Error("CORS origin must match the client redirect and post-logout origins");
  }

  const scopes = [...new Set(required(env, "OIDC_SCOPES").split(/\s+/))];
  if (!scopes.includes("openid")) throw new Error("OIDC_SCOPES must include openid");

  return {
    port,
    issuer: issuer.origin,
    clientId: required(env, "OIDC_CLIENT_ID"),
    redirectUri: redirect.href,
    postLogoutRedirectUri: postLogout.href,
    scopes,
    corsOrigin: cors.origin,
  };
}
