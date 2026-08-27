import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://facility:facility@localhost:5432/facility",
  SECRET_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
};

const validOauthJwks = JSON.stringify({
  keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "oauth-key" }],
});

const enabledOauthEnv = {
  FACILITY_OAUTH_JWKS: validOauthJwks,
  MCP_PUBLIC_URL: "https://mcp.example.org/mcp",
};

const validProductionOauthEnv = {
  ...validEnv,
  NODE_ENV: "production",
  PUBLIC_URL: "https://api.example.com",
  WEB_URL: "https://app.example.com",
  FACILITY_PREVIEW_URL: "https://facility-previews.example.net",
  AUTH_CALLBACK_URL: "https://app.example.com/api/auth/callback",
  FACILITY_OAUTH_ISSUER: "https://app.example.com",
  ...enabledOauthEnv,
};

describe("API configuration", () => {
  it("accepts a master key that decodes to exactly 32 bytes", () => {
    expect(readConfig(validEnv).secretMasterKey).toBe(validEnv.SECRET_MASTER_KEY);
  });

  it("fails at startup for a malformed master key", () => {
    expect(() => readConfig({ ...validEnv, SECRET_MASTER_KEY: "not-a-32-byte-key" })).toThrow(
      "SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes",
    );
  });

  it("rejects malformed base64 even when Node can permissively decode 32 bytes", () => {
    expect(() =>
      readConfig({ ...validEnv, SECRET_MASTER_KEY: `${validEnv.SECRET_MASTER_KEY}!` }),
    ).toThrow("SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes");
  });

  it("refuses insecure development login in production", () => {
    expect(() =>
      readConfig({ ...validEnv, NODE_ENV: "production", FACILITY_INSECURE_DEV: "1" }),
    ).toThrow("FACILITY_INSECURE_DEV is refused in production");
  });

  it("requires an isolated HTTPS preview origin in production", () => {
    expect(() => readConfig({ ...validEnv, NODE_ENV: "production" })).toThrow(
      "FACILITY_PREVIEW_URL is required in production",
    );
    expect(() =>
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        FACILITY_PREVIEW_URL: "http://previews.example.net",
      }),
    ).toThrow("FACILITY_PREVIEW_URL must use HTTPS in production");
    expect(() =>
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_PREVIEW_URL: "https://previews.example.com",
      }),
    ).toThrow(
      "FACILITY_PREVIEW_URL must use a registered site separate from other Facility origins",
    );
    expect(() =>
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        MCP_PUBLIC_URL: "https://facility-previews.example.net",
        FACILITY_PREVIEW_URL: "https://facility-previews.example.net",
      }),
    ).toThrow(
      "FACILITY_PREVIEW_URL must use a registered site separate from other Facility origins",
    );
    expect(() =>
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        FACILITY_PREVIEW_URL: "https://127.0.0.1",
      }),
    ).toThrow(
      "FACILITY_PREVIEW_URL must use a registered site separate from other Facility origins",
    );
    expect(
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_PREVIEW_URL: "https://facility-previews.example.net/",
      }),
    ).toMatchObject({ previewUrl: "https://facility-previews.example.net" });
    expect(
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://d111111abcdef8.cloudfront.net",
        WEB_URL: "https://app.example.com",
        FACILITY_PREVIEW_URL: "https://d222222abcdef8.cloudfront.net",
      }),
    ).toMatchObject({ previewUrl: "https://d222222abcdef8.cloudfront.net" });
    expect(() =>
      readConfig({
        ...validEnv,
        FACILITY_PREVIEW_URL: "https://user:secret@facility-previews.example.net/base?x=1",
      }),
    ).toThrow(
      "FACILITY_PREVIEW_URL must be an origin without credentials, path, query, or fragment",
    );
  });

  it("accepts only a bounded preview proxy surface token", () => {
    const token = "p".repeat(64);
    expect(readConfig({ ...validEnv, FACILITY_PREVIEW_SURFACE_TOKEN: token })).toMatchObject({
      previewSurfaceToken: token,
    });
    expect(
      readConfig({ ...validEnv, FACILITY_PREVIEW_SURFACE_TOKEN: "" }).previewSurfaceToken,
    ).toBeUndefined();
    expect(() => readConfig({ ...validEnv, FACILITY_PREVIEW_SURFACE_TOKEN: "short" })).toThrow();
    expect(() =>
      readConfig({ ...validEnv, FACILITY_PREVIEW_SURFACE_TOKEN: "p".repeat(129) }),
    ).toThrow();
  });

  it("requires direct GitHub client credentials as a pair", () => {
    expect(() => readConfig({ ...validEnv, GITHUB_OAUTH_CLIENT_ID: "client" })).toThrow(
      "GitHub OAuth client id and secret must be configured together",
    );
  });

  it("normalizes an optional GitHub organization restriction", () => {
    expect(
      readConfig({ ...validEnv, GITHUB_OAUTH_ALLOWED_ORGANIZATION: "  TheAM  " }),
    ).toMatchObject({ githubOauthAllowedOrganization: "theam" });
    expect(
      readConfig({ ...validEnv, GITHUB_OAUTH_ALLOWED_ORGANIZATION: "" })
        .githubOauthAllowedOrganization,
    ).toBeUndefined();
    expect(() =>
      readConfig({
        ...validEnv,
        GITHUB_OAUTH_ALLOWED_ORGANIZATION: "https://github.com/theam",
      }),
    ).toThrow("GitHub organization must be a login, not a URL");
  });

  it("trims the optional package registry credential for scoped runner handoff", () => {
    expect(readConfig({ ...validEnv, PACKAGE_REGISTRY_TOKEN: "  package-token\n" })).toMatchObject({
      packageRegistryToken: "package-token",
    });
  });

  it("surfaces the AWS CodeBuild runner project to the production doctor", () => {
    expect(
      readConfig({
        ...validEnv,
        FACILITY_AWS_CODEBUILD_PROJECT: "  facility-prod-runner  ",
        FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION: "  facility-prod-objects/codebuild-cache  ",
      }),
    ).toMatchObject({
      awsCodeBuildProject: "facility-prod-runner",
      awsCodeBuildCacheBaseLocation: "facility-prod-objects/codebuild-cache",
    });
  });

  it("accepts a Vercel sandbox project binding without exposing a token fallback", () => {
    expect(
      readConfig({
        ...validEnv,
        FACILITY_SANDBOX_DRIVER: "vercel",
        VERCEL_TOKEN: "  personal-token  ",
        VERCEL_OIDC_TOKEN: "  workload-token  ",
        VERCEL_TEAM_ID: "  team_facility  ",
        VERCEL_PROJECT_ID: "  prj_facility  ",
      }),
    ).toMatchObject({
      sandboxDriver: "vercel",
      vercelToken: "workload-token",
      vercelTeamId: "team_facility",
      vercelProjectId: "prj_facility",
    });
  });

  it("rejects the direct GitHub organization restriction in broker mode", () => {
    expect(() =>
      readConfig({
        ...validEnv,
        AUTH_IDENTITY_PROVIDER: "oidc",
        OIDC_ISSUER: "https://broker.example.com",
        OIDC_CLIENT_ID: "client",
        FACILITY_INSTANCE_ID: "instance_1",
        GITHUB_OAUTH_ALLOWED_ORGANIZATION: "theam",
      }),
    ).toThrow("GitHub organization restriction is only supported in github mode");
  });

  it("requires the issuer, client, and instance binding in broker mode", () => {
    expect(() => readConfig({ ...validEnv, AUTH_IDENTITY_PROVIDER: "oidc" })).toThrow(
      "OIDC issuer, client id, and Facility instance id are required in oidc mode",
    );
  });

  it("accepts only private P-256 signing keys with unique key ids", () => {
    expect(() =>
      readConfig({
        ...validEnv,
        FACILITY_OAUTH_JWKS: JSON.stringify({
          keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "public-only" }],
        }),
      }),
    ).toThrow("FACILITY_OAUTH_JWKS keys must be private ES256 JWKs with unique kid values");

    const privateKey = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "key-1" };
    expect(
      readConfig({
        ...validEnv,
        PUBLIC_URL: "https://api.example.com/",
        WEB_URL: "https://app.example.com/",
        AUTH_CALLBACK_URL: "https://app.example.com/api/auth/callback",
        FACILITY_OAUTH_ISSUER: "https://app.example.com/",
        MCP_PUBLIC_URL: "https://mcp.example.com/",
        FACILITY_OAUTH_JWKS: JSON.stringify({ keys: [privateKey] }),
      }),
    ).toMatchObject({
      oauthIssuer: "https://app.example.com",
      mcpPublicUrl: "https://mcp.example.com/mcp",
      oauthJwks: { keys: [privateKey] },
    });
  });

  it("canonicalizes the MCP resource and rejects an unrelated path", () => {
    expect(readConfig({ ...validEnv, MCP_PUBLIC_URL: "https://mcp.example.com" })).toMatchObject({
      mcpPublicUrl: "https://mcp.example.com/mcp",
    });
    expect(
      readConfig({ ...validEnv, MCP_PUBLIC_URL: "https://mcp.example.com/mcp/" }),
    ).toMatchObject({ mcpPublicUrl: "https://mcp.example.com/mcp" });
    expect(() =>
      readConfig({ ...validEnv, MCP_PUBLIC_URL: "https://mcp.example.com/other" }),
    ).toThrow("MCP_PUBLIC_URL path must be /mcp");
    expect(() => readConfig({ ...validEnv, MCP_PUBLIC_URL: "http://mcp.facility.test" })).toThrow(
      "MCP_PUBLIC_URL must use HTTPS unless it is a loopback URL",
    );
  });

  it("preserves an exact same-origin HTTP OAuth flow outside production", () => {
    expect(
      readConfig({
        ...validEnv,
        PUBLIC_URL: "http://localhost:4400",
        WEB_URL: "http://localhost:3400",
        FACILITY_OAUTH_ISSUER: "http://localhost:3400",
        AUTH_CALLBACK_URL: "http://localhost:3400/api/auth/callback",
        MCP_PUBLIC_URL: "http://localhost:4420",
        FACILITY_OAUTH_JWKS: validOauthJwks,
      }),
    ).toMatchObject({
      webUrl: "http://localhost:3400",
      oauthIssuer: "http://localhost:3400",
      authCallbackUrl: "http://localhost:3400/api/auth/callback",
      mcpPublicUrl: "http://localhost:4420/mcp",
    });
  });

  it("allows all-loopback HTTP OAuth URLs when the Compose image sets production", () => {
    expect(
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "http://localhost:4400",
        WEB_URL: "http://localhost:3400",
        FACILITY_PREVIEW_URL: "https://facility-previews.example.net",
        FACILITY_OAUTH_ISSUER: "http://localhost:3400",
        AUTH_CALLBACK_URL: "http://localhost:3400/api/auth/callback",
        MCP_PUBLIC_URL: "http://127.0.0.1:4420",
        FACILITY_OAUTH_JWKS: validOauthJwks,
      }),
    ).toMatchObject({
      oauthIssuer: "http://localhost:3400",
      mcpPublicUrl: "http://127.0.0.1:4420/mcp",
    });
  });

  it("does not apply Facility OAuth transport policy to an incomplete configuration", () => {
    expect(
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "http://api.example.com",
        WEB_URL: "http://app.example.com",
        FACILITY_PREVIEW_URL: "https://facility-previews.example.net",
        FACILITY_OAUTH_ISSUER: "http://app.example.com",
        AUTH_CALLBACK_URL: "http://app.example.com/api/auth/callback",
        MCP_PUBLIC_URL: "https://mcp.example.org",
        FACILITY_OAUTH_JWKS: "",
      }),
    ).toMatchObject({ oauthJwks: undefined, mcpPublicUrl: "https://mcp.example.org/mcp" });
  });

  it.each([
    [
      "WEB_URL",
      {
        WEB_URL: "http://app.example.com",
        FACILITY_OAUTH_ISSUER: "http://app.example.com",
        AUTH_CALLBACK_URL: "http://app.example.com/api/auth/callback",
      },
    ],
    ["AUTH_CALLBACK_URL", { AUTH_CALLBACK_URL: "http://app.example.com/api/auth/callback" }],
    ["FACILITY_OAUTH_ISSUER", { FACILITY_OAUTH_ISSUER: "http://app.example.com" }],
  ])("requires HTTPS for %s in production", (name, overrides) => {
    expect(() => readConfig({ ...validProductionOauthEnv, ...overrides })).toThrow(
      `${name} must use HTTPS in production`,
    );
  });

  it.each([
    "https://user:secret@app.example.com",
    "https://app.example.com/oauth",
    "https://app.example.com?tenant=one",
    "https://app.example.com#fragment",
  ])("requires the OAuth WEB_URL to be a canonical origin: %s", (webUrl) => {
    expect(() =>
      readConfig({
        ...validEnv,
        ...enabledOauthEnv,
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: webUrl,
        FACILITY_OAUTH_ISSUER: "https://app.example.com",
      }),
    ).toThrow(
      "WEB_URL must be an HTTP(S) origin without credentials, path, query, or fragment when Facility OAuth is enabled",
    );
  });

  it("requires the MCP authorization server issuer to be the canonical web origin", () => {
    expect(() =>
      readConfig({
        ...validEnv,
        ...enabledOauthEnv,
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_OAUTH_ISSUER: "https://api.example.com",
      }),
    ).toThrow(
      "FACILITY_OAUTH_ISSUER must be the WEB_URL origin so OAuth browser cookies remain host-only and same-origin",
    );
    for (const oauthIssuer of [
      "https://user:secret@app.example.com",
      "https://app.example.com/oauth",
      "https://app.example.com?tenant=one",
      "https://app.example.com#fragment",
    ]) {
      expect(() =>
        readConfig({
          ...validEnv,
          ...enabledOauthEnv,
          WEB_URL: "https://app.example.com",
          FACILITY_OAUTH_ISSUER: oauthIssuer,
        }),
      ).toThrow(
        "FACILITY_OAUTH_ISSUER must be the WEB_URL origin so OAuth browser cookies remain host-only and same-origin",
      );
    }
  });

  it.each([
    "https://user:secret@app.example.com/api/auth/callback",
    "https://app.example.com/auth/callback",
    "https://app.example.com/api/auth/callback/",
    "https://app.example.com/api/auth/callback?tenant=one",
    "https://app.example.com/api/auth/callback#fragment",
    "https://other.example.com/api/auth/callback",
  ])("requires the exact host-only OAuth callback URL: %s", (callbackUrl) => {
    expect(() =>
      readConfig({
        ...validEnv,
        ...enabledOauthEnv,
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_OAUTH_ISSUER: "https://app.example.com",
        AUTH_CALLBACK_URL: callbackUrl,
      }),
    ).toThrow("AUTH_CALLBACK_URL must be exactly the WEB_URL /api/auth/callback URL");
  });
});
