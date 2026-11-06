import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type Provider from "oidc-provider";
import { normalizeEmail } from "../users/email.js";
import { renderLoginPage } from "../users/login-page.js";

export interface AuthenticatedUser { id: string; email: string }
export type AuthenticateUser = (email: string, password: string) => Promise<AuthenticatedUser | null>;

const forms = new Map<string, { token: string; attempts: number; expires: number }>();
const MAX_ATTEMPTS = 5;
const FORM_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_FAILURES = 5;
const MAX_IP_FAILURES = 20;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function newForm(uid: string) {
  for (const [key, entry] of forms) if (entry.expires < Date.now()) forms.delete(key);
  const existing = forms.get(uid);
  if (existing) return existing;
  const form = { token: randomBytes(32).toString("hex"), attempts: 0, expires: Date.now() + FORM_TTL_MS };
  forms.set(uid, form);
  return form;
}

function validToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function consentPage(uid: string, clientId: string, scope: string, token: string) {
  return page("Cấp quyền", `<p>Ứng dụng ${escapeHtml(clientId)} yêu cầu: ${escapeHtml(scope)}</p><form method="post" action="/interaction/${encodeURIComponent(uid)}/consent"><input type="hidden" name="csrf" value="${token}"><button name="allow" value="yes" type="submit">Đồng ý</button><button name="allow" value="no" type="submit">Từ chối</button></form>`);
}

export function interactionRouter(provider: Provider, authenticateUser?: AuthenticateUser): Router {
  const router = Router();
  const rateKey = randomBytes(32);
  const failures = new Map<string, { count: number; expires: number }>();

  function emailKey(email: string): string {
    return `email:${createHmac("sha256", rateKey).update(email).digest("hex")}`;
  }

  function attemptCount(key: string): number {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.expires <= Date.now()) {
      failures.delete(key);
      return 0;
    }
    return entry.count;
  }

  function recordFailure(key: string): void {
    if (failures.size > 1000) {
      for (const [storedKey, entry] of failures) {
        if (entry.expires <= Date.now()) failures.delete(storedKey);
      }
    }
    const count = attemptCount(key);
    failures.set(key, { count: count + 1, expires: Date.now() + RATE_WINDOW_MS });
  }

  async function details(req: Request, res: Response) {
    const interaction = await provider.interactionDetails(req, res);
    if (interaction.uid !== req.params.uid) throw new Error("Interaction UID mismatch");
    return interaction;
  }

  router.get("/:uid", async (req, res, next) => {
    try {
      const interaction = await details(req, res);
      const form = newForm(interaction.uid);
      res.set("Cache-Control", "no-store");
      if (interaction.prompt.name === "login") {
        return res.type("html").send(renderLoginPage({ uid: interaction.uid, csrfToken: form.token }));
      }
      if (interaction.prompt.name === "consent") {
        return res.type("html").send(consentPage(interaction.uid, String(interaction.params.client_id ?? ""), String(interaction.params.scope ?? ""), form.token));
      }
      return res.status(400).type("html").send(page("Yêu cầu không được hỗ trợ", ""));
    } catch (error) { next(error); }
  });

  router.post("/:uid/login", async (req, res, next) => {
    try {
      const interaction = await details(req, res);
      if (interaction.prompt.name !== "login") return res.sendStatus(400);
      const form = forms.get(interaction.uid);
      if (!form || form.expires < Date.now() || !validToken(req.body?.csrf, form.token)) return res.sendStatus(403);
      if (form.attempts >= MAX_ATTEMPTS) return res.status(429).type("html").send(page("Đăng nhập", "<p>Đã vượt quá số lần thử. Hãy bắt đầu lại.</p>"));
      if (!authenticateUser) return res.status(503).type("html").send(page("Đăng nhập", "<p>Chức năng đăng nhập chưa sẵn sàng.</p>"));
      const email = req.body?.email;
      const password = req.body?.password;
      if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 128) return res.sendStatus(400);
      const normalizedEmail = normalizeEmail(email);
      const identity = emailKey(normalizedEmail ?? email.trim().toLowerCase());
      const ip = `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
      if (attemptCount(identity) >= MAX_EMAIL_FAILURES || attemptCount(ip) >= MAX_IP_FAILURES) {
        return res.status(429).type("html").send(page("Đăng nhập", "<p>Đã vượt quá số lần thử. Vui lòng thử lại sau.</p>"));
      }
      form.attempts++;
      const user = await authenticateUser(email, password);
      if (!user) {
        recordFailure(identity);
        recordFailure(ip);
        return res.status(401).type("html").send(renderLoginPage({ uid: interaction.uid, csrfToken: form.token, error: "invalid_credentials" }));
      }
      failures.delete(identity);
      forms.delete(interaction.uid);
      return await provider.interactionFinished(req, res, { login: { accountId: user.id } }, { mergeWithLastSubmission: false });
    } catch (error) { next(error); }
  });

  router.post("/:uid/consent", async (req, res, next) => {
    try {
      const interaction = await details(req, res);
      if (interaction.prompt.name !== "consent" || !interaction.session) return res.sendStatus(400);
      const form = forms.get(interaction.uid);
      if (!form || form.expires < Date.now() || !validToken(req.body?.csrf, form.token)) return res.sendStatus(403);
      forms.delete(interaction.uid);
      if (req.body?.allow !== "yes") {
        return await provider.interactionFinished(req, res, { error: "access_denied" }, { mergeWithLastSubmission: false });
      }
      const { params, grantId, session } = interaction;
      const missing = interaction.prompt.details;
      const grant = grantId ? await provider.Grant.find(grantId) : new provider.Grant({ accountId: session.accountId, clientId: String(params.client_id) });
      if (!grant) return res.sendStatus(400);
      if (Array.isArray(missing.missingOIDCScope)) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      if (Array.isArray(missing.missingOIDCClaims)) grant.addOIDCClaims(missing.missingOIDCClaims);
      if (missing.missingResourceScopes && typeof missing.missingResourceScopes === "object") {
        for (const [resource, scopes] of Object.entries(missing.missingResourceScopes)) {
          if (Array.isArray(scopes)) grant.addResourceScope(resource, scopes.join(" "));
        }
      }
      return await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
    } catch (error) { next(error); }
  });

  return router;
}
