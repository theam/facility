import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://facility:facility@localhost:5432/facility",
  SECRET_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
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

  it("treats blank Vercel credentials from a copied .env.example as unset", () => {
    expect(
      readConfig({
        ...validEnv,
        VERCEL_TOKEN: "",
        VERCEL_OIDC_TOKEN: "",
        VERCEL_TEAM_ID: "",
        VERCEL_PROJECT_ID: "",
      }),
    ).toMatchObject({
      vercelToken: undefined,
      vercelTeamId: undefined,
      vercelProjectId: undefined,
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
        FACILITY_OAUTH_ISSUER: "https://api.example.com/",
        MCP_PUBLIC_URL: "https://mcp.example.com/",
        FACILITY_OAUTH_JWKS: JSON.stringify({ keys: [privateKey] }),
      }),
    ).toMatchObject({
      oauthIssuer: "https://api.example.com",
      mcpPublicUrl: "https://mcp.example.com",
      oauthJwks: { keys: [privateKey] },
    });
  });
});
