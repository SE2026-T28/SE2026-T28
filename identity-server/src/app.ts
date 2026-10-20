import { randomBytes } from "node:crypto";
import express from "express";
import { Provider } from "oidc-provider";
import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig) {
  const app = express();
  app.disable("x-powered-by");

  const provider = new Provider(config.issuer, {
    clients: [
      {
        client_id: config.clientId,
        token_endpoint_auth_method: "none",
        response_types: ["code"],
        grant_types: ["authorization_code"],
        redirect_uris: [config.redirectUri],
        post_logout_redirect_uris: [config.postLogoutRedirectUri],
      },
    ],
    scopes: config.scopes,
    clientBasedCORS(_ctx, origin, client) {
      return origin === config.corsOrigin && client.clientId === config.clientId;
    },
    cookies: { keys: [randomBytes(32).toString("hex")] },
    features: { devInteractions: { enabled: false } },
  });

  app.use(provider.callback());
  return app;
}
