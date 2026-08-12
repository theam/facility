import type { AuditInsert, FacilityDb } from "@facility/db";
import type {
  GithubAppMetadataReader,
  GithubClientFactory,
  GithubInstallationTokenFactory,
} from "./github/client.js";

export type Principal = {
  type: "user" | "key";
  id: string;
  orgId: string;
  userId?: string;
  email?: string;
  name?: string;
  githubLogin?: string;
  avatarUrl?: string;
  projectId?: string | null;
  permissions: string[];
};

export type AppConfig = {
  databaseUrl: string;
  secretMasterKey: string;
  port: number;
  publicUrl: string;
  webUrl?: string;
  // Browser origin used only for proxied preview application content. In
  // production this must be HTTPS on a registered site separate from every
  // control-plane site so untrusted JavaScript cannot toss Facility cookies.
  previewUrl?: string;
  // Optional value added by a trusted preview reverse proxy. A value match can
  // classify preview-surface requests even when that proxy replaces Host with
  // its origin hostname.
  previewSurfaceToken?: string;
  // URLs a sandbox uses to reach back — distinct from publicUrl because a
  // container cannot resolve the host's "localhost". Default to the public
  // URLs; override (e.g. host.docker.internal) for the local docker driver.
  sandboxApiUrl: string;
  sandboxGatewayUrl: string;
  // Gateway URL reachable from the API process itself (in-process assistant
  // loop) — sandboxGatewayUrl may be a container-network address instead.
  gatewayUrl: string;
  // Image the seeded default sandbox profile uses to run the platform runner.
  sandboxRunnerImage: string;
  // Driver the seeded default sandbox profile uses.
  sandboxDriver: "docker" | "aws" | "vercel";
  authIdentityProvider?: "github" | "oidc";
  authCallbackUrl?: string;
  githubOauthClientId?: string;
  githubOauthClientSecret?: string;
  githubOauthAuthorizeUrl?: string;
  githubOauthTokenUrl?: string;
  githubOauthApiUrl?: string;
  githubOauthAllowedOrganization?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  facilityInstanceId?: string;
  oauthIssuer?: string;
  oauthJwks?: { keys: Record<string, unknown>[] };
  mcpPublicUrl?: string;
  facilityInsecureDev: boolean;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
  awsRegion?: string;
  awsCodeBuildProject?: string;
  awsCodeBuildCacheBaseLocation?: string;
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
  packageRegistryToken?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppWebhookSecret?: string;
  githubAppSlug?: string;
  githubCloneToken?: string;
  logLevel: string;
};

export type ExternalIdentity = {
  provider: "github";
  githubUserId: string;
  login: string;
  email: string;
  emailVerified: true;
  verifiedEmails: string[];
  name?: string;
  avatarUrl?: string;
  installations: Array<{ installationId: number; accountId: number }>;
};

declare module "fastify" {
  interface FastifyInstance {
    facilityDb: FacilityDb;
    enqueue: (queue: string, data: Record<string, unknown>) => Promise<string | null>;
    githubClientFactory?: GithubClientFactory;
    githubInstallationTokenFactory?: GithubInstallationTokenFactory;
    githubAppMetadataReader?: GithubAppMetadataReader;
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
