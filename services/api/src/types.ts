import type { AuditInsert, FacilityDb } from "@facility/db";
import type { GithubClientFactory, GithubInstallationTokenFactory } from "./github/client.js";

export type Principal = {
  type: "user" | "key";
  id: string;
  orgId: string;
  userId?: string;
  email?: string;
  name?: string;
  projectId?: string | null;
  permissions: string[];
};

export type AppConfig = {
  databaseUrl: string;
  secretMasterKey: string;
  port: number;
  publicUrl: string;
  webUrl?: string;
  // URLs a sandbox uses to reach back — distinct from publicUrl because a
  // container cannot resolve the host's "localhost". Default to the public
  // URLs; override (e.g. host.docker.internal) for the local docker driver.
  sandboxApiUrl: string;
  sandboxGatewayUrl: string;
  // Image the seeded default sandbox profile uses to run the platform runner.
  sandboxRunnerImage: string;
  // Driver the seeded default sandbox profile uses ("docker" | "aws").
  sandboxDriver: "docker" | "aws";
  workosApiKey?: string;
  workosAuthkitDomain?: string;
  workosRedirectUri?: string;
  workosClientId?: string;
  workosCookiePassword?: string;
  // Expected `aud` for WorkOS OAuth access tokens. REQUIRED to enable the JWT
  // credential kind: the resource server keeps OAuth JWT auth disabled unless
  // this is set, so audience is always validated (never fail-open).
  mcpOauthAudience?: string;
  facilityInsecureDev: boolean;
  facilityAutoJoin?: boolean;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
  awsRegion?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppWebhookSecret?: string;
  githubAppSlug?: string;
  githubCloneToken?: string;
  logLevel: string;
};

declare module "fastify" {
  interface FastifyInstance {
    facilityDb: FacilityDb;
    enqueue: (queue: string, data: Record<string, unknown>) => Promise<string | null>;
    githubClientFactory?: GithubClientFactory;
    githubInstallationTokenFactory?: GithubInstallationTokenFactory;
  }
  interface FastifyRequest {
    principal?: Principal;
    idempotencyId?: string;
    idempotencyReplayed?: boolean;
    audit: (
      action: string,
      target: AuditInsert["target"],
      payload?: Record<string, unknown>,
    ) => Promise<void>;
  }
  interface FastifyContextConfig {
    permission?: string | string[];
    auditAction?: string;
    public?: boolean;
    orgAdmin?: boolean;
    idempotent?: boolean;
  }
}
