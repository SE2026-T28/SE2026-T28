import { Router } from "express";
import type { Provider } from "oidc-provider";
import { findUserById } from "../users/authentication.js";

const CLIENT_ID = "app04-react-demo";
const REQUIRED_SCOPE = "api:read";

export function protectedProfileRouter(provider: Provider, allowedOrigin: string): Router {
  const router = Router();
  const audience = `${provider.issuer}/api`;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) => {
    const origin = req.get("Origin");
    if (!origin) return next();
    res.vary("Origin");
    if (origin !== allowedOrigin) return res.status(403).json({ error: "origin_not_allowed" });
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization");
      return res.sendStatus(204);
    }
    next();
  });

  router.get("/profile", async (req, res) => {
    const unauthorized = () => res.status(401)
      .set("WWW-Authenticate", 'Bearer error="invalid_token"')
      .json({ error: "invalid_token" });
    const forbidden = () => res.status(403)
      .set("WWW-Authenticate", 'Bearer error="insufficient_scope", scope="api:read"')
      .json({ error: "insufficient_scope" });
    // Accept exactly one header credential. Query/body credentials never authenticate.
    const authorizationHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0)
      .filter(name => name.toLowerCase() === "authorization");
    const match = req.get("Authorization")?.match(/^Bearer +([A-Za-z0-9._~+/-]+=*)$/i);
    if (authorizationHeaders.length !== 1 || !match) return unauthorized();

    try {
      const token = await provider.AccessToken.find(match[1]);
      const now = Math.floor(Date.now() / 1000);
      if (!token || token.kind !== "AccessToken" || token.tokenType !== "Bearer"
        || token.isSenderConstrained() || !Number.isFinite(token.exp) || token.exp! <= now
        || token.clientId !== CLIENT_ID || token.aud !== audience
        || !token.grantId || !token.accountId) return unauthorized();

      const grant = await provider.Grant.find(token.grantId);
      if (!grant || grant.isExpired || grant.clientId !== CLIENT_ID
        || grant.accountId !== token.accountId) return unauthorized();
      const account = await findUserById(token.accountId);
      if (!account) return unauthorized();

      if (!token.scope?.split(" ").includes(REQUIRED_SCOPE)
        || !grant.getResourceScope(audience).split(" ").includes(REQUIRED_SCOPE)) return forbidden();

      return res.json({ sub: account.id });
    } catch {
      // Dependency errors can contain credentials. Return only a fixed error code.
      return res.status(500).json({ error: "server_error" });
    }
  });
  return router;
}
