import express from "express";
import { Provider, errors } from "oidc-provider";
import { securityHeaders } from "./security/headers.js";
import type { AppConfig } from "./config.js";
import { userRouter } from "./users/user.routes.js";
import { interactionRouter, type AuthenticateUser } from "./interactions/routes.js";
import { findUserById } from "./users/authentication.js";
import { PostgresOidcAdapter } from "./oidc/postgres-adapter.js";
import { protectedProfileRouter } from "./resources/protected-profile.js";
import { registerOidcAudit } from "./audit/oidc-events.js";
import { createInteractionAudit } from "./audit/interaction-events.js";

/**
 * CORS riêng cho Registration API.
 * OIDC Provider's clientBasedCORS chỉ bảo vệ các endpoint của Provider,
 * không tự áp dụng cho Express route /api/users.
 */
function registrationCors(allowedOrigin: string): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.get("Origin");

    // Requests không phải cross-origin (ví dụ curl/server-to-server) vẫn được phép.
    if (!origin) return next();

    if (origin !== allowedOrigin) {
      return res.status(403).json({
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Origin không được phép truy cập API đăng ký.",
        },
      });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      return res.sendStatus(204);
    }

    return next();
  };
}

export function createApp(config: AppConfig, authenticateUser?: AuthenticateUser) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders(config.issuer, config.corsOrigin));

  // A1: JSON body parser và Registration API. S4 applies security headers above.
  app.use("/api/users", registrationCors(config.corsOrigin));
  app.use(express.json({ limit: "10kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/users", userRouter);

  // O1: giữ nguyên OIDC Provider configuration và Discovery middleware.
  let oidcAudit: ReturnType<typeof registerOidcAudit> | undefined;
  const provider = new Provider(config.issuer, {
    clients: [
      {
        client_id: config.clientId,
        token_endpoint_auth_method: "none",
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [config.redirectUri],
        post_logout_redirect_uris: [config.postLogoutRedirectUri],
      },
    ],
    // Refresh grant is only enabled by oidc-provider when offline_access is advertised.
    // Preserve older deployments whose configured scopes predate M3.
    scopes: [...new Set([...config.scopes.filter(scope => scope !== "api:read"), "offline_access"])],
    adapter: name => new PostgresOidcAdapter(name, config.adapterKey),
    ttl: { AccessToken: 300, RefreshToken: 3600 },
    rotateRefreshToken: true,
    // Keep oidc-provider 9.12.2's default policy: direct AT revocation does
    // not revoke the whole Grant. The callback runs after token.destroy().
    revokeGrantPolicy(ctx) {
      if (ctx.oidc.route === "revocation" && ctx.oidc.entities.AccessToken) {
        oidcAudit?.directAccessTokenRevocation(ctx);
        return false;
      }
      return true;
    },
    claims: { email: ["email"] },
    pkce: { required: () => true },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    async findAccount(_ctx, sub) {
      const user = await findUserById(sub);
      if (!user) return undefined;
      return {
        accountId: user.id,
        async claims(_use, scope) {
          return scope.split(" ").includes("email") ? { sub: user.id, email: user.email } : { sub: user.id };
        },
      };
    },
    clientBasedCORS(_ctx, origin, client) {
      return origin === config.corsOrigin && client.clientId === config.clientId;
    },
    cookies: { keys: config.cookieKeys },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo(_ctx, resource, client) {
          if (client.clientId !== config.clientId || resource !== `${config.issuer}/api`) {
            throw new errors.InvalidTarget();
          }
          return { scope: "api:read", audience: `${config.issuer}/api`, accessTokenFormat: "opaque" };
        },
      },
    },
  });
  app.locals.oidcProvider = provider;
  oidcAudit = registerOidcAudit(provider, config.clientId);
  const providerAudit = oidcAudit;
  const interactionAudit = createInteractionAudit(config.clientId);
  app.locals.oidcAudit = { async drain() {
    await Promise.all([providerAudit.drain(), interactionAudit.drain()]);
  } };

  app.use("/interaction", express.urlencoded({ extended: false, limit: "10kb" }), interactionRouter(provider, authenticateUser, interactionAudit));
  app.use("/api/protected", protectedProfileRouter(provider, config.corsOrigin));
  app.use(provider.callback());

  // Body parser errors are returned using the Registration API error shape.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);

    const candidate = error as { status?: unknown; type?: unknown } | null;
    if (candidate?.type === "entity.too.large" || candidate?.status === 413) {
      return res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body vượt quá giới hạn 10 KB.",
        },
      });
    }

    if (candidate?.type === "entity.parse.failed" || candidate?.status === 400) {
      return res.status(400).json({
        error: {
          code: "INVALID_JSON",
          message: "Request body phải là JSON hợp lệ.",
        },
      });
    }

    // Error messages from dependencies may contain credentials or request data.
    console.error("Unhandled request error");

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Đã xảy ra lỗi máy chủ.",
      },
    });
  });

  return app;
}
