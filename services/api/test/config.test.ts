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
