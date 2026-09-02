import type { FacilityDb } from "@facility/db";
import type { GithubClientFactory } from "./github/client.js";
import type { StoryDomain } from "./story-domain.js";

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
  workspaceImage: string;
  workspaceDriver: "docker" | "vercel";
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
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
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
    storyDomain: StoryDomain;
  }
  interface FastifyRequest {
    principal?: Principal;
    idempotencyId?: string;
    idempotencyReplayed?: boolean;
    audit: (
      action: string,
      target: { type: string; id?: string },
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
