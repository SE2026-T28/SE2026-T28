import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const valid = {
  VITE_OIDC_AUTHORITY: "http://localhost:3000",
  VITE_OIDC_CLIENT_ID: "app04-react-demo",
  VITE_OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  VITE_OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/",
  VITE_OIDC_SCOPE: "openid profile email",
};

describe("readConfig", () => {
  it("accepts a valid env", () => {
    expect(readConfig(valid)).toEqual({
      authority: "http://localhost:3000",
      clientId: "app04-react-demo",
      redirectUri: "http://localhost:5173/callback",
      postLogoutRedirectUri: "http://localhost:5173/",
      scope: "openid profile email",
    });
  });

  it("throws naming a missing variable", () => {
    const env: Record<string, string> = { ...valid };
    delete env.VITE_OIDC_CLIENT_ID;
    expect(() => readConfig(env)).toThrow(/VITE_OIDC_CLIENT_ID/);
  });

  it("treats blank values as missing", () => {
    expect(() => readConfig({ ...valid, VITE_OIDC_AUTHORITY: "  " })).toThrow(
      /VITE_OIDC_AUTHORITY/,
    );
  });

  it("requires the openid scope", () => {
    expect(() =>
      readConfig({ ...valid, VITE_OIDC_SCOPE: "profile email" }),
    ).toThrow(/openid/);
  });
});
