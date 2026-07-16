import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });

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
    // "docker" for local/self-host, "aws" for the Fargate stack.
    FACILITY_SANDBOX_DRIVER: z.enum(["docker", "aws"]).default("docker"),
    WORKOS_API_KEY: z.string().optional(),
    WORKOS_CLIENT_ID: z.string().optional(),
    WORKOS_COOKIE_PASSWORD: z.string().optional(),
    WORKOS_AUTHKIT_DOMAIN: z.string().optional(),
    MCP_OAUTH_AUDIENCE: z.string().optional(),
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: z.string().optional(),
    FACILITY_INSECURE_DEV: z.string().optional(),
    FACILITY_AUTO_JOIN: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().optional(),
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
  });

function isExactBase64Key(value: string) {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

export function readConfig(env = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    secretMasterKey: parsed.SECRET_MASTER_KEY,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    webUrl: parsed.WEB_URL,
    sandboxApiUrl: parsed.SANDBOX_API_URL ?? parsed.PUBLIC_URL,
    sandboxGatewayUrl: parsed.SANDBOX_GATEWAY_URL ?? parsed.GATEWAY_URL,
    sandboxRunnerImage: parsed.FACILITY_RUNNER_IMAGE,
    sandboxDriver: parsed.FACILITY_SANDBOX_DRIVER,
    workosApiKey: parsed.WORKOS_API_KEY,
    workosClientId: parsed.WORKOS_CLIENT_ID,
    workosCookiePassword: parsed.WORKOS_COOKIE_PASSWORD,
    workosAuthkitDomain: parsed.WORKOS_AUTHKIT_DOMAIN,
    mcpOauthAudience: parsed.MCP_OAUTH_AUDIENCE,
    workosRedirectUri: parsed.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    facilityInsecureDev: parsed.FACILITY_INSECURE_DEV === "1",
    facilityAutoJoin: parsed.FACILITY_AUTO_JOIN === "1",
    s3Endpoint: parsed.S3_ENDPOINT,
    s3AccessKey: parsed.S3_ACCESS_KEY,
    s3SecretKey: parsed.S3_SECRET_KEY,
    s3Bucket: parsed.S3_BUCKET,
    awsRegion: parsed.AWS_REGION,
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    githubAppWebhookSecret: parsed.GITHUB_APP_WEBHOOK_SECRET,
    githubAppSlug: parsed.GITHUB_APP_SLUG,
    githubCloneToken: parsed.GITHUB_CLONE_TOKEN,
    logLevel: parsed.LOG_LEVEL,
  };
}
