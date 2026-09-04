import { createHash, randomBytes } from "node:crypto";
import { newId } from "@facility/core";
import {
  type FacilityDb,
  orgMembers,
  previewSessions,
  roles,
  stories,
  users,
  workspaces,
} from "@facility/db";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { GithubWorkspaceCredentialBroker } from "../github/workspace-credentials.js";
import { assertWorkspacePreviewAvailable } from "../origin-isolation.js";
import type { AppConfig } from "../types.js";
import type { ProjectEnvironmentService, ProjectManifestSource } from "./project-environment.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "./runtime.js";

const SESSION_TTL_MS = 60 * 60 * 1_000;

export class WorkspacePreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "WorkspacePreviewError";
  }
}

export class WorkspacePreviewService {
  constructor(
    private readonly db: FacilityDb,
    private readonly config: AppConfig,
    private readonly runtime: WorkspaceRuntime,
    private readonly credentials: GithubWorkspaceCredentialBroker,
    private readonly manifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
  ) {}

  async open(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    userId: string;
    service: string;
  }) {
    assertWorkspacePreviewAvailable(this.config);
    const { story, workspace } = await this.bundle(input.orgId, input.projectId, input.storyId);
    if (story.deletedAt || workspace.state === "destroyed" || !workspace.externalRef) {
      throw new WorkspacePreviewError("workspace_not_available", "Workspace is not available");
    }
    const [credentials, manifest] = await Promise.all([
      this.credentials.issue(input.orgId, input.projectId),
      this.manifests.load(input.orgId, input.projectId),
    ]);
    const branch = story.branch ?? `facility/story-${story.id.slice(-8)}`;
    if (!story.branch) {
      await this.db
        .update(stories)
        .set({ branch, updatedAt: new Date() })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, story.id)));
    }
    await this.runtime.wake(locator(workspace));
    const prepared = await this.environment.prepare({
      orgId: input.orgId,
      projectId: input.projectId,
      workspace: locator(workspace),
      manifest,
      credentials,
      branch,
      previousSetupChecksum: workspace.setupChecksum,
    });
    if (!prepared.endpoints.some((endpoint) => endpoint.service === input.service)) {
      throw new WorkspacePreviewError(
        "preview_service_not_found",
        "Preview service not found",
        404,
      );
    }

    const token = randomBytes(32).toString("base64url");
    const sessionId = newId("psess");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insert(previewSessions).values({
      id: sessionId,
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      workspaceId: workspace.id,
      userId: input.userId,
      service: input.service,
      tokenHash: tokenHash(token),
      expiresAt,
    });
    const url = new URL(
      `/workspace-preview-auth/${encodeURIComponent(sessionId)}`,
      this.config.previewUrl,
    );
    url.searchParams.set("token", token);
    return { sessionId, url: url.toString(), expiresAt };
  }

  async exchange(sessionId: string, token: string) {
    const consumed = (
      await this.db
        .update(previewSessions)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(previewSessions.id, sessionId),
            eq(previewSessions.tokenHash, tokenHash(token)),
            isNull(previewSessions.consumedAt),
            isNull(previewSessions.revokedAt),
            gt(previewSessions.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];
    if (!consumed) throw invalidAccess();
    await this.assertMembership(consumed.orgId, consumed.userId);
    return consumed;
  }

  async authorize(sessionId: string, token: string) {
    const session = (
      await this.db
        .select()
        .from(previewSessions)
        .where(
          and(
            eq(previewSessions.id, sessionId),
            eq(previewSessions.tokenHash, tokenHash(token)),
            isNotNull(previewSessions.consumedAt),
            isNull(previewSessions.revokedAt),
            gt(previewSessions.expiresAt, new Date()),
          ),
        )
        .limit(1)
    )[0];
    if (!session) throw invalidAccess();
    await this.assertMembership(session.orgId, session.userId);
    return session;
  }

  async target(session: typeof previewSessions.$inferSelect, path: string) {
    const workspace = (
      await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, session.orgId),
            eq(workspaces.projectId, session.projectId),
            eq(workspaces.storyId, session.storyId),
            eq(workspaces.id, session.workspaceId),
          ),
        )
        .limit(1)
    )[0];
    if (workspace?.state !== "running") {
      throw new WorkspacePreviewError("preview_not_running", "Preview workspace is not running");
    }
    const endpoints = Array.isArray(workspace.endpoints)
      ? (workspace.endpoints as Array<{ service?: unknown; url?: unknown }>)
      : [];
    const endpoint = endpoints.find(
      (candidate) => candidate.service === session.service && typeof candidate.url === "string",
    );
    if (!endpoint || typeof endpoint.url !== "string") {
      throw new WorkspacePreviewError(
        "preview_service_not_found",
        "Preview service not found",
        404,
      );
    }
    const environment = workspace.environment as { variables?: Record<string, string> };
    const gatewayToken = environment.variables?.FACILITY_PREVIEW_GATEWAY_TOKEN;
    if (!gatewayToken) {
      throw new WorkspacePreviewError(
        "preview_gateway_unavailable",
        "Workspace preview gateway is unavailable",
        503,
      );
    }
    const target = new URL(endpoint.url);
    const safePath = normalizeProxyPath(path);
    target.pathname = safePath.pathname;
    target.search = safePath.search;
    return { url: target, gatewayToken };
  }

  private async bundle(orgId: string, projectId: string, storyId: string) {
    const story = (
      await this.db
        .select()
        .from(stories)
        .where(
          and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)),
        )
        .limit(1)
    )[0];
    if (!story) throw new WorkspacePreviewError("story_not_found", "Story not found", 404);
    const workspace = (
      await this.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.storyId, storyId)))
        .limit(1)
    )[0];
    if (!workspace)
      throw new WorkspacePreviewError("workspace_not_found", "Workspace not found", 404);
    return { story, workspace };
  }

  private async assertMembership(orgId: string, userId: string) {
    const member = (
      await this.db
        .select({ permissions: roles.permissions })
        .from(orgMembers)
        .innerJoin(roles, eq(orgMembers.roleId, roles.id))
        .innerJoin(users, eq(orgMembers.userId, users.id))
        .where(
          and(
            eq(orgMembers.orgId, orgId),
            eq(orgMembers.userId, userId),
            eq(users.status, "active"),
          ),
        )
        .limit(1)
    )[0];
    if (!member) throw invalidAccess();
  }
}

export function previewCookieName(sessionId: string) {
  if (!/^psess_[a-z0-9]{16,64}$/.test(sessionId)) throw invalidAccess();
  return `facility_workspace_preview_${sessionId}`;
}

export function previewCookieOptions(config: AppConfig, sessionId: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.previewUrl?.startsWith("https://") ?? false,
    path: `/workspace-preview/${encodeURIComponent(sessionId)}`,
    maxAge: SESSION_TTL_MS / 1_000,
  };
}

function locator(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  const environment = row.environment as {
    image?: unknown;
    variables?: unknown;
    ports?: WorkspaceLocator["ports"];
    resources?: WorkspaceLocator["resources"];
  };
  if (!row.externalRef || typeof environment.image !== "string") {
    throw new WorkspacePreviewError("workspace_not_available", "Workspace is not available");
  }
  return {
    id: row.id,
    image: environment.image,
    environment:
      environment.variables && typeof environment.variables === "object"
        ? (environment.variables as Record<string, string>)
        : {},
    ports: environment.ports,
    resources: environment.resources,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}

function tokenHash(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "invalid";
  return createHash("sha256").update(token).digest("hex");
}

function normalizeProxyPath(path: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new WorkspacePreviewError("preview_path_invalid", "Preview path is invalid", 400);
  }
  if (
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => segment === "..") ||
    decoded.includes("\0")
  ) {
    throw new WorkspacePreviewError("preview_path_invalid", "Preview path is invalid", 400);
  }
  return new URL(`http://preview/${decoded.replace(/^\/+/, "")}`);
}

function invalidAccess() {
  return new WorkspacePreviewError(
    "preview_access_invalid",
    "Preview access is invalid or expired",
    401,
  );
}
