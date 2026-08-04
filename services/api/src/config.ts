import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });

const OptionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const OptionalGithubOrganization = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/, "GitHub organization must be a login, not a URL")
    .optional(),
);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    SECRET_MASTER_KEY: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(4400),
    PUBLIC_URL: z.string().url().default("http://localhost:4400"),
    WEB_URL: z.string().url().optional(),
    SANDBOX_API_URL: z.string().url().optional(),
    GATEWAY_URL: z.string().url().default("http://localhost:4410"),
    SANDBOX_GATEWAY_URL: z.string().url().optional(),
    // Container image that runs the Facility runner for platform-lane runs. The
    // seeded default sandbox profile and `facility doctor` both key off this.
    FACILITY_RUNNER_IMAGE: z.string().default("facility-runner:dev"),
    // Driver the seeded default sandbox profile uses. Must match the deployment:
    // "docker" for local/self-host, "aws" for the CodeBuild stack.
    FACILITY_SANDBOX_DRIVER: z.enum(["docker", "aws"]).default("docker"),
    AUTH_IDENTITY_PROVIDER: z.enum(["github", "oidc"]).default("github"),
    AUTH_CALLBACK_URL: OptionalUrl,
    GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
    GITHUB_OAUTH_AUTHORIZE_URL: z
      .string()
      .url()
      .default("https://github.com/login/oauth/authorize"),
    GITHUB_OAUTH_TOKEN_URL: z.string().url().default("https://github.com/login/oauth/access_token"),
    GITHUB_OAUTH_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_OAUTH_ALLOWED_ORGANIZATION: OptionalGithubOrganization,
    OIDC_ISSUER: OptionalUrl,
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    FACILITY_INSTANCE_ID: z.string().optional(),
    FACILITY_OAUTH_ISSUER: OptionalUrl,
    FACILITY_OAUTH_JWKS: z.string().optional(),
    MCP_PUBLIC_URL: OptionalUrl,
    FACILITY_INSECURE_DEV: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().optional(),
    PACKAGE_REGISTRY_TOKEN: z.string().trim().min(1).optional(),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_APP_SLUG: z.string().optional(),
    // Fallback clone credential for private repos when a GitHub App
    // installation token is not available (the App mints per-run tokens in
    // production; this is the self-host / validation path).
    GITHUB_CLONE_TOKEN: z.string().optional(),
    LOG_LEVEL: z.string().default("info"),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!isExactBase64Key(env.SECRET_MASTER_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["SECRET_MASTER_KEY"],
        message: "SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes",
      });
    }
    if (env.NODE_ENV === "production" && env.FACILITY_INSECURE_DEV === "1") {
      ctx.addIssue({
        code: "custom",
        path: ["FACILITY_INSECURE_DEV"],
        message: "FACILITY_INSECURE_DEV is refused in production",
      });
    }
    if (
      env.AUTH_IDENTITY_PROVIDER === "github" &&
      Boolean(env.GITHUB_OAUTH_CLIENT_ID) !== Boolean(env.GITHUB_OAUTH_CLIENT_SECRET)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["GITHUB_OAUTH_CLIENT_ID"],
        message: "GitHub OAuth client id and secret must be configured together",
      });
    }
    if (
      env.AUTH_IDENTITY_PROVIDER === "oidc" &&
      (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.FACILITY_INSTANCE_ID)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_ISSUER"],
        message: "OIDC issuer, client id, and Facility instance id are required in oidc mode",
      });
    }
    if (env.AUTH_IDENTITY_PROVIDER === "oidc" && env.GITHUB_OAUTH_ALLOWED_ORGANIZATION) {
      ctx.addIssue({
        code: "custom",
        path: ["GITHUB_OAUTH_ALLOWED_ORGANIZATION"],
        message: "GitHub organization restriction is only supported in github mode",
      });
    }
  });

function isExactBase64Key(value: string) {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

export function readConfig(env = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const webUrl = parsed.WEB_URL ?? parsed.PUBLIC_URL;
  return {
    databaseUrl: parsed.DATABASE_URL,
    secretMasterKey: parsed.SECRET_MASTER_KEY,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    webUrl,
    sandboxApiUrl: parsed.SANDBOX_API_URL ?? parsed.PUBLIC_URL,
    sandboxGatewayUrl: parsed.SANDBOX_GATEWAY_URL ?? parsed.GATEWAY_URL,
    gatewayUrl: parsed.GATEWAY_URL,
    sandboxRunnerImage: parsed.FACILITY_RUNNER_IMAGE,
    sandboxDriver: parsed.FACILITY_SANDBOX_DRIVER,
    authIdentityProvider: parsed.AUTH_IDENTITY_PROVIDER,
    authCallbackUrl: parsed.AUTH_CALLBACK_URL ?? `${webUrl.replace(/\/$/, "")}/api/auth/callback`,
    githubOauthClientId: parsed.GITHUB_OAUTH_CLIENT_ID,
    githubOauthClientSecret: parsed.GITHUB_OAUTH_CLIENT_SECRET,
    githubOauthAuthorizeUrl: parsed.GITHUB_OAUTH_AUTHORIZE_URL,
    githubOauthTokenUrl: parsed.GITHUB_OAUTH_TOKEN_URL,
    githubOauthApiUrl: parsed.GITHUB_OAUTH_API_URL,
    githubOauthAllowedOrganization: parsed.GITHUB_OAUTH_ALLOWED_ORGANIZATION,
    oidcIssuer: parsed.OIDC_ISSUER?.replace(/\/$/, ""),
    oidcClientId: parsed.OIDC_CLIENT_ID,
    oidcClientSecret: parsed.OIDC_CLIENT_SECRET,
    facilityInstanceId: parsed.FACILITY_INSTANCE_ID,
    oauthIssuer: parsed.FACILITY_OAUTH_ISSUER?.replace(/\/$/, ""),
    oauthJwks: parseJwks(parsed.FACILITY_OAUTH_JWKS),
    mcpPublicUrl: parsed.MCP_PUBLIC_URL?.replace(/\/$/, ""),
    facilityInsecureDev: parsed.FACILITY_INSECURE_DEV === "1",
    s3Endpoint: parsed.S3_ENDPOINT,
    s3AccessKey: parsed.S3_ACCESS_KEY,
    s3SecretKey: parsed.S3_SECRET_KEY,
    s3Bucket: parsed.S3_BUCKET,
    awsRegion: parsed.AWS_REGION,
    packageRegistryToken: parsed.PACKAGE_REGISTRY_TOKEN,
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    githubAppWebhookSecret: parsed.GITHUB_APP_WEBHOOK_SECRET,
    githubAppSlug: parsed.GITHUB_APP_SLUG,
    githubCloneToken: parsed.GITHUB_CLONE_TOKEN,
    logLevel: parsed.LOG_LEVEL,
  };
}

function parseJwks(value: string | undefined): { keys: Record<string, unknown>[] } | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as { keys?: unknown } | unknown[];
  const keys = Array.isArray(parsed) ? parsed : parsed.keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.some((key) => !key || typeof key !== "object")
  ) {
    throw new Error("FACILITY_OAUTH_JWKS must contain a non-empty JWK key array");
  }
  for (const key of keys as Record<string, unknown>[]) {
    if (
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      typeof key.x !== "string" ||
      typeof key.y !== "string" ||
      typeof key.d !== "string" ||
      typeof key.kid !== "string" ||
      key.kid.length === 0
    ) {
      throw new Error("FACILITY_OAUTH_JWKS keys must be private ES256 JWKs with unique kid values");
    }
  }
  if (new Set((keys as Record<string, unknown>[]).map((key) => key.kid)).size !== keys.length) {
    throw new Error("FACILITY_OAUTH_JWKS key ids must be unique");
  }
  return { keys: keys as Record<string, unknown>[] };
}
