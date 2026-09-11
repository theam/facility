import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://facility:facility@localhost:5432/facility",
  SECRET_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
};

describe("Facility 0.12 configuration", () => {
  it("requires an exact 32-byte base64 master key", () => {
    expect(readConfig(validEnv).secretMasterKey).toBe(validEnv.SECRET_MASTER_KEY);
    for (const value of ["bad", `${validEnv.SECRET_MASTER_KEY}!`]) {
      expect(() => readConfig({ ...validEnv, SECRET_MASTER_KEY: value })).toThrow(
        "SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes",
      );
    }
  });

  it("supports only Docker and Vercel workspace runtimes", () => {
    expect(readConfig(validEnv).workspaceDriver).toBe("docker");
    expect(readConfig({ ...validEnv, FACILITY_WORKSPACE_DRIVER: "vercel" })).toMatchObject({
      workspaceDriver: "vercel",
    });
    expect(() => readConfig({ ...validEnv, FACILITY_WORKSPACE_DRIVER: "aws" })).toThrow();
  });

  it("refuses insecure development login in production", () => {
    expect(() =>
      readConfig({ ...validEnv, NODE_ENV: "production", FACILITY_INSECURE_DEV: "1" }),
    ).toThrow("FACILITY_INSECURE_DEV is refused in production");
    expect(() =>
      readConfig({
        ...validEnv,
        FACILITY_INSECURE_DEV: "1",
        PUBLIC_URL: "http://facility.internal:4400",
      }),
    ).toThrow("FACILITY_INSECURE_DEV requires loopback PUBLIC_URL and WEB_URL");
  });

  it("requires a separate HTTPS preview site in production", () => {
    expect(() => readConfig({ ...validEnv, NODE_ENV: "production" })).toThrow(
      "FACILITY_PREVIEW_URL is required in production",
    );
    expect(() =>
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_PREVIEW_URL: "https://preview.example.com",
      }),
    ).toThrow("must use a registered site separate");
    expect(
      readConfig({
        ...validEnv,
        NODE_ENV: "production",
        PUBLIC_URL: "https://api.example.com",
        WEB_URL: "https://app.example.com",
        FACILITY_PREVIEW_URL: "https://preview.example.net",
      }),
    ).toMatchObject({ previewUrl: "https://preview.example.net" });
  });

  it("rejects preview URLs with credentials, paths, queries, or fragments", () => {
    expect(() =>
      readConfig({
        ...validEnv,
        FACILITY_PREVIEW_URL: "https://user:secret@preview.example.net/path?x=1",
      }),
    ).toThrow("FACILITY_PREVIEW_URL must be an origin");
  });

  it("requires GitHub OAuth client credentials as a pair", () => {
    expect(() => readConfig({ ...validEnv, GITHUB_OAUTH_CLIENT_ID: "client" })).toThrow(
      "GitHub OAuth client id and secret must be configured together",
    );
  });

  it("normalizes an optional GitHub organization restriction", () => {
    expect(
      readConfig({ ...validEnv, GITHUB_OAUTH_ALLOWED_ORGANIZATION: "  Facility  " }),
    ).toMatchObject({ githubOauthAllowedOrganization: "facility" });
    expect(() =>
      readConfig({
        ...validEnv,
        GITHUB_OAUTH_ALLOWED_ORGANIZATION: "https://github.com/facility",
      }),
    ).toThrow("GitHub organization must be a login");
  });

  it("requires complete broker identity configuration", () => {
    expect(() => readConfig({ ...validEnv, AUTH_IDENTITY_PROVIDER: "oidc" })).toThrow(
      "OIDC issuer, client id, and Facility instance id are required",
    );
  });

  it("normalizes the MCP resource to the single /mcp endpoint", () => {
    expect(readConfig({ ...validEnv, MCP_PUBLIC_URL: "http://localhost:4400" })).toMatchObject({
      mcpPublicUrl: "http://localhost:4400/mcp",
    });
    expect(() =>
      readConfig({ ...validEnv, MCP_PUBLIC_URL: "https://facility.example/v1/mcp" }),
    ).toThrow("MCP_PUBLIC_URL path must be /mcp");
  });

  it.each([
    ["a WebCrypto signing export", ["sign"], true],
    ["a set that also permits verification", ["sign", "verify"], undefined],
  ])("loads %s without its key_ops or ext members", (_label, key_ops, ext) => {
    const loaded = readConfig({
      ...validEnv,
      FACILITY_OAUTH_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "key-1", key_ops, ext }],
      }),
    }).oauthJwks;

    expect(loaded?.keys).toEqual([
      { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "key-1" },
    ]);
  });

  it.each([
    ["verification only", ["verify"]],
    ["an empty operation list", []],
    ["a non-array value", "sign"],
    ["a non-string entry", [1]],
  ])("refuses a signing key whose key_ops declares %s", (_label, key_ops) => {
    expect(() =>
      readConfig({
        ...validEnv,
        FACILITY_OAUTH_JWKS: JSON.stringify({
          keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "key-1", key_ops }],
        }),
      }),
    ).toThrow('FACILITY_OAUTH_JWKS keys with key_ops must permit "sign"');
  });

  it("uses Vercel workload identity ahead of a personal token", () => {
    expect(
      readConfig({
        ...validEnv,
        FACILITY_WORKSPACE_DRIVER: "vercel",
        VERCEL_TOKEN: "personal",
        VERCEL_OIDC_TOKEN: "workload",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
      }),
    ).toMatchObject({
      vercelToken: "workload",
      vercelTeamId: "team",
      vercelProjectId: "project",
    });
  });

  it("treats blank optional values as unset", () => {
    expect(
      readConfig({
        ...validEnv,
        VERCEL_TOKEN: "",
        VERCEL_TEAM_ID: "",
        VERCEL_PROJECT_ID: "",
        FACILITY_PREVIEW_URL: "",
      }),
    ).toMatchObject({
      vercelToken: undefined,
      vercelTeamId: undefined,
      vercelProjectId: undefined,
      previewUrl: undefined,
    });
  });
});
