import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type Provider from "oidc-provider";
import { normalizeEmail } from "../users/email.js";
import { renderLoginPage } from "../users/login-page.js";
import { MfaChallengeService } from "../mfa/service.js";
import { MfaRateLimitedError } from "../mfa/repository.js";
import { MfaFormSecurity } from "../mfa/form-security.js";
import { createMfaBrowserBinding, readMfaBrowserBinding, setMfaBrowserBindingCookie, clearMfaBrowserBindingCookie } from "../mfa/browser-binding.js";
import { renderMfaPage } from "../mfa/login-page.js";
import { verifyMfaAndFinishInteraction } from "../mfa/interaction-handoff.js";
import { completeLoginWithAudit, type InteractionAudit } from "../audit/interaction-events.js";

export interface AuthenticatedUser { id: string; email: string }
export type AuthenticateUser = (email: string, password: string) => Promise<AuthenticatedUser | null>;

const forms = new Map<string, { token: string; attempts: number; expires: number }>();
const MAX_ATTEMPTS = 5;
const FORM_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_FAILURES = 5;
const MAX_IP_FAILURES = 20;

class InteractionUidMismatch extends Error {}

function handleInteractionError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof InteractionUidMismatch) {
    res.sendStatus(403);
    return;
  }
  next(error);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function newForm(uid: string) {
  for (const [key, entry] of forms) if (entry.expires <= Date.now()) forms.delete(key);
  const existing = forms.get(uid);
  if (existing && existing.expires > Date.now()) return existing;
  const form = { token: randomBytes(32).toString("hex"), attempts: 0, expires: Date.now() + FORM_TTL_MS };
  forms.set(uid, form);
  return form;
}

function validToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function consentPage(uid: string, clientId: string, scope: string, token: string) {
  return page("Cấp quyền", `<p>Ứng dụng ${escapeHtml(clientId)} yêu cầu: ${escapeHtml(scope)}</p><form method="post" action="/interaction/${encodeURIComponent(uid)}/consent"><input type="hidden" name="csrf" value="${token}"><button name="allow" value="yes" type="submit">Đồng ý</button><button name="allow" value="no" type="submit">Từ chối</button></form>`);
}

export function interactionRouter(provider: Provider, authenticateUser?: AuthenticateUser, audit?: InteractionAudit): Router {
  const router = Router();
  const mfa = process.env.MFA_MOCK_ENABLED === "true" && authenticateUser
    ? new MfaChallengeService({
      codePepper: process.env.MFA_CODE_PEPPER ?? "",
      exposeDemoCode: process.env.MFA_DEMO_CODE_ENABLED === "true",
      ...(audit ? { publishAudit: audit.mfa } : {}),
    }) : null;
  const mfaForms = new MfaFormSecurity();
  const rateKey = randomBytes(32);
  const failures = new Map<string, { count: number; expires: number }>();
  const pending = new Map<string, number>();
  const processingUids = new Set<string>();

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

  function reserve(key: string): void { pending.set(key, (pending.get(key) ?? 0) + 1); }
  function release(key: string): void {
    const remaining = (pending.get(key) ?? 1) - 1;
    if (remaining) pending.set(key, remaining);
    else pending.delete(key);
  }

  async function details(req: Request, res: Response) {
    const interaction = await provider.interactionDetails(req, res);
    if (interaction.uid !== req.params.uid) throw new InteractionUidMismatch();
    return interaction;
  }

  router.get("/:uid", async (req, res, next) => {
    try {
      const interaction = await details(req, res);
      const form = newForm(interaction.uid);
      res.set("Cache-Control", "no-store");
      if (interaction.prompt.name === "login") {
        if (mfa) {
          const browserBinding = readMfaBrowserBinding(req);
          const pendingChallenge = browserBinding
            ? await mfa.findPendingChallenge({ interactionUid: interaction.uid, browserBinding }) : null;
          if (pendingChallenge) {
            res.set("Pragma", "no-cache");
            const csrfToken = mfaForms.issue(interaction.uid, pendingChallenge.expiresAt);
            return res.type("html").send(renderMfaPage({
              uid: interaction.uid, csrfToken, expiresAt: pendingChallenge.expiresAt,
              demoCode: pendingChallenge.demoCode,
              ...(pendingChallenge.status === "LOCKED" ? { error: "locked" as const } : {}),
            }));
          }
        }
        return res.type("html").send(renderLoginPage({ uid: interaction.uid, csrfToken: form.token }));
      }
      if (interaction.prompt.name === "consent") {
        return res.type("html").send(consentPage(interaction.uid, String(interaction.params.client_id ?? ""), String(interaction.params.scope ?? ""), form.token));
      }
      return res.status(400).type("html").send(page("Yêu cầu không được hỗ trợ", ""));
    } catch (error) { handleInteractionError(error, res, next); }
  });

  router.post("/:uid/login", async (req, res, next) => {
    try {
      const interaction = await details(req, res);
      if (interaction.prompt.name !== "login") return res.sendStatus(400);
      const form = forms.get(interaction.uid);
      if (!form || form.expires < Date.now() || !validToken(req.body?.csrf, form.token)) return res.sendStatus(403);
      if (processingUids.has(interaction.uid)) return res.sendStatus(409);
      if (form.attempts >= MAX_ATTEMPTS) return res.status(429).type("html").send(page("Đăng nhập", "<p>Đã vượt quá số lần thử. Hãy bắt đầu lại.</p>"));
      if (!authenticateUser) return res.status(503).type("html").send(page("Đăng nhập", "<p>Chức năng đăng nhập chưa sẵn sàng.</p>"));
      const email = req.body?.email;
      const password = req.body?.password;
      if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 128) return res.sendStatus(400);
      const normalizedEmail = normalizeEmail(email);
      const identity = emailKey(normalizedEmail ?? email.trim().toLowerCase());
      const ip = `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
      if (attemptCount(identity) + (pending.get(identity) ?? 0) >= MAX_EMAIL_FAILURES
        || attemptCount(ip) + (pending.get(ip) ?? 0) >= MAX_IP_FAILURES) {
        return res.status(429).type("html").send(page("Đăng nhập", "<p>Đã vượt quá số lần thử. Vui lòng thử lại sau.</p>"));
      }
      // Claim synchronously before the asynchronous password check: only one
      // request may attempt to finish this interaction at a time.
      processingUids.add(interaction.uid);
      form.attempts++;
      reserve(identity);
      reserve(ip);
      try {
        const user = await authenticateUser(email, password);
        if (!user) {
          // A failed password still counts when a GET replaced the expired form.
          recordFailure(identity);
          recordFailure(ip);
          audit?.loginFailure(interaction.uid);
        }
        // A GET may have replaced an expired form while Authentication was pending.
        // The old request must never complete that interaction or consume its new form.
        if (forms.get(interaction.uid) !== form || form.expires <= Date.now()) return res.sendStatus(403);
        if (!user) {
          return res.status(401).type("html").send(renderLoginPage({ uid: interaction.uid, csrfToken: form.token, error: "invalid_credentials" }));
        }
        failures.delete(identity);
        if (forms.get(interaction.uid) === form) forms.delete(interaction.uid);
        if (mfa) {
          const browserBinding = createMfaBrowserBinding();
          let created;
          try {
            created = await mfa.createChallenge({
              userId: user.id,
              interactionUid: interaction.uid,
              browserBinding,
              clientId: String(interaction.params.client_id ?? ""),
            });
          } catch (error) {
            if (error instanceof MfaRateLimitedError) {
              return res.status(429).type("html").send(page("Xác minh MFA", "<p>Đã vượt quá số lần thử. Vui lòng thử lại sau.</p>"));
            }
            throw error;
          }
          const csrfToken = mfaForms.rotate(interaction.uid, created.challenge.expiresAt);
          setMfaBrowserBindingCookie(res, browserBinding, req.secure);
          return res.set("Cache-Control", "no-store").set("Pragma", "no-cache")
            .type("html").send(renderMfaPage({
              uid: interaction.uid, csrfToken, expiresAt: created.challenge.expiresAt,
              demoCode: created.demoCode,
            }));
        }
        return await completeLoginWithAudit(
          () => provider.interactionFinished(req, res, { login: { accountId: user.id } }, { mergeWithLastSubmission: false }),
          audit, interaction.uid, user.id,
        );
      } finally {
        release(identity);
        release(ip);
        processingUids.delete(interaction.uid);
        // Bad credentials or a backend error may be retried while valid.
        if (forms.get(interaction.uid) === form && form.expires <= Date.now()) forms.delete(interaction.uid);
      }
    } catch (error) { handleInteractionError(error, res, next); }
  });

  router.post("/:uid/mfa", async (req, res, next) => {
    try {
      if (!mfa) return res.sendStatus(404);
      const interaction = await details(req, res);
      if (interaction.prompt.name !== "login") return res.sendStatus(400);
      const csrf = req.body?.csrf;
      if (!mfaForms.validate(interaction.uid, csrf)) return res.sendStatus(403);
      const browserBinding = readMfaBrowserBinding(req);
      if (!browserBinding) return res.sendStatus(403);
      const code = req.body?.code;
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) return res.sendStatus(400);
      const result = await verifyMfaAndFinishInteraction(mfa, {
        interactionUid: interaction.uid,
        browserBinding,
        code,
        clientId: String(interaction.params.client_id ?? ""),
      }, async accountId => {
        if (!mfaForms.consume(interaction.uid, csrf)) throw new Error("MFA CSRF expired before completion");
        clearMfaBrowserBindingCookie(res, req.secure);
        return completeLoginWithAudit(
          () => provider.interactionFinished(req, res, { login: { accountId } }, { mergeWithLastSubmission: false }),
          audit, interaction.uid, accountId,
        );
      });
      if (res.headersSent) return;
      if (!result.ok && result.reason === "interaction_failed") {
        mfaForms.invalidate(interaction.uid);
        clearMfaBrowserBindingCookie(res, req.secure);
        return res.status(503).set("Cache-Control", "no-store").type("html")
          .send(page("Xác minh MFA", "<p>Không thể hoàn tất đăng nhập. Hãy bắt đầu lại luồng đăng nhập.</p>"));
      }
      if (!result.ok) {
        const pending = await mfa.findPendingChallenge({ interactionUid: interaction.uid, browserBinding });
        if (!pending || result.reason === "expired" || result.reason === "locked") {
          mfaForms.invalidate(interaction.uid);
          clearMfaBrowserBindingCookie(res, req.secure);
          return res.status(result.reason === "locked" ? 429 : 401)
            .set("Cache-Control", "no-store").type("html")
            .send(page("Xác minh MFA", "<p>Không thể xác minh. Hãy bắt đầu lại luồng đăng nhập.</p>"));
        }
        return res.status(401).set("Cache-Control", "no-store").set("Pragma", "no-cache")
          .type("html").send(renderMfaPage({
            uid: interaction.uid, csrfToken: mfaForms.issue(interaction.uid, pending.expiresAt),
            expiresAt: pending.expiresAt, demoCode: pending.demoCode, error: "invalid_code",
          }));
      }
    } catch (error) { handleInteractionError(error, res, next); }
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
    } catch (error) { handleInteractionError(error, res, next); }
  });

  return router;
}
