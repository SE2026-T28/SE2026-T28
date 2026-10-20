import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from "oidc-client-ts";
import type { OidcConfig } from "./config";

export function buildSettings(
  config: OidcConfig,
  storage: Storage = window.sessionStorage,
): UserManagerSettings {
  return {
    authority: config.authority, // endpoints come from Discovery, never hard-coded
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    scope: config.scope,
    response_type: "code", // Authorization Code + PKCE (S256 is the library default)
    userStore: new WebStorageStateStore({ store: storage }),
    stateStore: new WebStorageStateStore({ store: storage }), // default would be localStorage
    automaticSilentRenew: false,
    loadUserInfo: false,
  };
}

export function createUserManager(
  config: OidcConfig,
  overrides: Partial<UserManagerSettings> = {},
): UserManager {
  return new UserManager({ ...buildSettings(config), ...overrides });
}
