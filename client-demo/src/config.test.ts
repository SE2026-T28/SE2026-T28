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
      apiResource: "http://localhost:3000/api",
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

  describe("apiResource", () => {
    it("derives <authority>/api and trims trailing slashes", () => {
      expect(readConfig({ ...valid, VITE_OIDC_AUTHORITY: "http://localhost:3000/" }).apiResource).toBe(
        "http://localhost:3000/api",
      );
    });

    it("accepts a same-origin override", () => {
      const env = { ...valid, VITE_API_RESOURCE: "http://localhost:3000/v2/api/" };
      expect(readConfig(env).apiResource).toBe("http://localhost:3000/v2/api");
    });

    it("returns the normalized URL (host case, trailing slash) for an override", () => {
      const env = { ...valid, VITE_API_RESOURCE: "HTTP://LOCALHOST:3000/v2/api//" };
      expect(readConfig(env).apiResource).toBe("http://localhost:3000/v2/api");
    });

    it("an uppercase-host override on the authority's origin is accepted and bare origins have no slash", () => {
      const env = { ...valid, VITE_API_RESOURCE: "http://LocalHost:3000/" };
      expect(readConfig(env).apiResource).toBe("http://localhost:3000");
    });

    it.each([
      ["not a URL", "api"],
      ["non-http scheme", "ftp://localhost:3000/api"],
      ["other origin (token would leave the Provider)", "http://evil.example/api"],
      ["query", "http://localhost:3000/api?x=1"],
      ["fragment", "http://localhost:3000/api#x"],
      ["credentials", "http://user:pw@localhost:3000/api"],
    ])("rejects %s", (_name, value) => {
      expect(() => readConfig({ ...valid, VITE_API_RESOURCE: value })).toThrow(/VITE_API_RESOURCE/);
    });
  });
});
