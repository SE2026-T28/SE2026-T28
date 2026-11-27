import type { UserManager } from "oidc-client-ts";
import { createUserManager } from "./auth";
import { loadConfig, type OidcConfig } from "./config";
import { resetProfileForTests } from "./profile";
import {
  processLogoutReturn,
  resetInflightForTests,
  resetRefreshForTests,
  type LogoutReturn,
} from "./session";

let userManager: UserManager | null = null;
let config: OidcConfig | null = null;
let callbackUrl: string | null = null;
let path: string | null = null;
let logoutReturn: Promise<LogoutReturn> | null = null;

export function getConfig(): OidcConfig {
  return (config ??= loadConfig());
}

// One UserManager per page load: shares Discovery metadata and the JWKS key cache.
export function getUserManager(): UserManager {
  return (userManager ??= createUserManager(getConfig()));
}

// The route is fixed at first render: scrubbing the address bar must not flip Callback to Home.
export function currentPath(): string {
  return (path ??= window.location.pathname);
}

// StrictMode renders/effects twice: capture the callback URL once, scrub the address bar at once.
export function takeCallbackUrl(): string {
  if (callbackUrl === null) {
    callbackUrl = window.location.href;
    window.history.replaceState(null, "", "/");
  }
  return callbackUrl;
}

// StrictMode runs effects twice: process the post-logout return once per page load.
export function takeLogoutReturn(): Promise<LogoutReturn> {
  return (logoutReturn ??= processLogoutReturn(getUserManager(), window.location.href));
}

export function resetRuntimeForTests(): void {
  userManager = null;
  config = null;
  callbackUrl = null;
  path = null;
  logoutReturn = null;
  resetInflightForTests();
  resetRefreshForTests();
  resetProfileForTests();
}
