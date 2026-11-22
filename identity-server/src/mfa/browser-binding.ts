import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export const MFA_BROWSER_COOKIE_NAME = "app04_mfa_browser";
export const MFA_BROWSER_COOKIE_MAX_AGE_SECONDS = 5 * 60;

/** Generate a per-browser binding value; persist only its HMAC in the MFA table. */
export function createMfaBrowserBinding(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Read exactly one well-formed MFA browser cookie. Duplicate cookie names are
 * rejected to avoid ambiguity between proxy/browser cookie ordering.
 */
export function readMfaBrowserBinding(req: Pick<Request, "headers">): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;

  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === MFA_BROWSER_COOKIE_NAME) values.push(part.slice(separator + 1).trim());
  }
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) return null;
  return values[0]!;
}

export function setMfaBrowserBindingCookie(res: Response, binding: string, secure: boolean): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) throw new TypeError("MFA browser binding is invalid");
  const cookie = [
    `${MFA_BROWSER_COOKIE_NAME}=${binding}`,
    "Path=/interaction",
    `Max-Age=${MFA_BROWSER_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  res.append("Set-Cookie", cookie);
}

export function clearMfaBrowserBindingCookie(res: Response, secure: boolean): void {
  const cookie = [
    `${MFA_BROWSER_COOKIE_NAME}=`,
    "Path=/interaction",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  res.append("Set-Cookie", cookie);
}

/** Constant-time equality helper for the value returned from the cookie parser. */
export function isSameMfaBrowserBinding(actual: string | null, expected: string): boolean {
  if (!actual || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return false;
  const actualBytes = Buffer.from(actual, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
