import { interactionRouter } from './interactions/routes.js';
import { authenticateUser, findUserById } from './users/authentication.js';
import { randomBytes } from "node:crypto";
import express from "express";
import { Provider, errors } from "oidc-provider";
import { securityHeaders } from "./security/headers.js";
import type { AppConfig } from "./config.js";
import { searchRouter } from './users/search.routes.js';
import type { SearchRepository } from './users/search.js';
import { userRouter } from "./users/user.routes.js";
/**
 * CORS riêng cho Registration API.
 * OIDC Provider's clientBasedCORS chỉ bảo vệ các endpoint của Provider,
 * không tự áp dụng cho Express route /api/users.
 */
function registrationCors(allowedOrigin: string): express.RequestHandler {
    return (req, res, next) => {
        const origin = req.get("Origin");
        // Requests không phải cross-origin (ví dụ curl/server-to-server) vẫn được phép.
        if (!origin)
            return next();
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
export function createApp(config: AppConfig, options: {
    searchRepository?: SearchRepository;
} = {}) {
    const app = express();
    app.disable("x-powered-by");
    app.use(securityHeaders(config.issuer));
    // A1: JSON body parser và Registration API. S4 applies security headers above.
    app.use("/api/users", registrationCors(config.corsOrigin));
    app.use(express.json({ limit: "10kb" }));
    app.get("/health", (_req, res) => res.json({ status: "ok" }));
    app.use("/api/users", userRouter);
    // O1: giữ nguyên OIDC Provider configuration và Discovery middleware.
    const eligible = (id: string | undefined) => !!id && (config.searchAccountIds ?? []).includes(id);
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
        scopes: config.scopes.filter(scope => scope !== 'users:read'),
        pkce: { required: () => true },
        claims: { email: ['email'] },
        interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
        async findAccount(_ctx, id) {
            const user = await findUserById(id);
            if (!user)
                return undefined;
            return { accountId: user.id, claims: async (_use, scope) => scope.split(' ').includes('email') ? { sub: user.id, email: user.email } : { sub: user.id } };
        },
        async extraTokenClaims(_ctx, token) {
            if (token.scopes.has('users:read') &&
                (token.clientId !== config.clientId || token.aud !== `${config.issuer}/api/users` || !eligible('accountId' in token ? token.accountId : undefined))) {
                throw new errors.AccessDenied('Search entitlement denied');
            }
            return {};
        },
        clientBasedCORS(_ctx, origin, client) {
            return origin === config.corsOrigin && client.clientId === config.clientId;
        },
        cookies: { keys: [randomBytes(32).toString("hex")] },
        features: {
            devInteractions: { enabled: false },
            resourceIndicators: {
                enabled: true,
                getResourceServerInfo(_ctx, resource, client) {
                    if (resource !== `${config.issuer}/api/users` || client.clientId !== config.clientId)
                        throw new errors.InvalidTarget();
                    return { scope: 'users:read', audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
                },
            },
        },
    });
    app.use('/interaction', express.urlencoded({ extended: false, limit: '10kb' }), interactionRouter(provider, authenticateUser, eligible));
    app.locals.oidcProvider = provider;
    app.use('/api/users', searchRouter(provider, config.clientId, options.searchRepository, eligible));
    app.use(provider.callback());
    // Body parser errors are returned using the Registration API error shape.
    app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (res.headersSent)
            return next(error);
        const candidate = error as {
            status?: unknown;
            type?: unknown;
        } | null;
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
        // Không ghi request body, password hoặc passwordHash vào log.
        console.error("Unhandled request error", error instanceof Error ? error.message : "unknown");
        return res.status(500).json({
            error: {
                code: "INTERNAL_ERROR",
                message: "Đã xảy ra lỗi máy chủ.",
            },
        });
    });
    return app;
}
