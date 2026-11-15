import type { UserManager } from "oidc-client-ts";
import { createUserManager } from "./auth";
import { loadConfig } from "./config";
import { resetInflightForTests } from "./session";

let userManager: UserManager | null = null;
let callbackUrl: string | null = null;
let path: string | null = null;

// One UserManager per page load: shares Discovery metadata and the JWKS key cache.
export function getUserManager(): UserManager {
  return (userManager ??= createUserManager(loadConfig()));
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

export function resetRuntimeForTests(): void {
  userManager = null;
  callbackUrl = null;
  path = null;
  resetInflightForTests();
}
