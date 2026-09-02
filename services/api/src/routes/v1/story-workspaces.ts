import { workspaceEvents } from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { manifestFromProjection } from "../../agents/catalog.js";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import { principal } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const StoryAgentParams = z.object({ projectId: z.string(), agentName: z.string() });
const StartStoryBody = z.object({
  provider: z.enum(["github", "manual"]).default("manual"),
  external_id: z.string().min(1).max(240).optional(),
  title: z.string().min(1).max(500),
  agent: z.string().min(1).max(64).default("builder"),
  message: z.string().min(1).max(200_000),
  idempotency_key: z.string().min(1).max(200),
});
const SendMessageBody = z.object({
  agent: z.string().min(1).max(64).default("builder"),
  message: z.string().min(1).max(200_000),
  idempotency_key: z.string().min(1).max(200),
});
const ListStoriesQuery = z.object({
  status: z.enum(["ready", "working", "attention", "review", "done", "archived"]).optional(),
});
const ConversationQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const DeleteBody = z.object({
  confirm: z.literal(true),
  idempotency_key: z.string().min(8).max(200),
});

export async function registerStoryWorkspaceRoutes(app: FastifyInstance, config: AppConfig) {
  const domain = app.storyDomain;

  app.get(
    "/v1/projects/:projectId/story-agents",
    {
      config: { permission: "projects:read" },
      schema: { params: ProjectParams, operationId: "listStoryAgents" },
    },
    async (request) => {
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const actor = principal(request);
      const rows = await translate(() => domain.catalog.list(actor.orgId, projectId));
      return {
        agents: rows.map((row) => ({
          ...manifestFromProjection(row),
          commit_sha: row.commitSha,
          synced_at: row.syncedAt,
        })),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/story-agents/:agentName",
    {
      config: { permission: "projects:read" },
      schema: { params: StoryAgentParams, operationId: "getStoryAgent" },
    },
    async (request) => {
      const { projectId, agentName } = request.params as z.infer<typeof StoryAgentParams>;
      const actor = principal(request);
      const row = await translate(() => domain.catalog.get(actor.orgId, projectId, agentName));
      return { ...manifestFromProjection(row), commit_sha: row.commitSha, synced_at: row.syncedAt };
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories",
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        querystring: ListStoriesQuery,
        operationId: "listWorkspaceStories",
      },
    },
    async (request) => {
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const query = request.query as z.infer<typeof ListStoriesQuery>;
      const actor = principal(request);
      return {
        stories: await translate(() => domain.stories.list(actor.orgId, projectId, query.status)),
      };
    },
  );

  app.post(
    "/v1/projects/:projectId/workspace-stories",
    {
      config: { permission: "workspaces:execute", idempotent: true },
      schema: { params: ProjectParams, body: StartStoryBody, operationId: "startWorkspaceStory" },
    },
    async (request, reply) => {
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const body = request.body as z.infer<typeof StartStoryBody>;
      const actor = principal(request);
      const orgId = actor.orgId;
      const [projection, projectManifest] = await translate(() =>
        Promise.all([
          domain.catalog.get(orgId, projectId, body.agent),
          domain.projectManifests.load(orgId, projectId),
        ]),
      );
      const result = await translate(() =>
        domain.stories.start({
          orgId,
          projectId,
          provider: body.provider,
          externalId: body.external_id ?? `manual:${body.idempotency_key}`,
          title: body.title,
          agent: manifestFromProjection(projection),
          message: body.message,
          messageDedupeKey: body.idempotency_key,
          actor: principalActor(actor),
          workspace: {
            image: projectManifest.environment.image ?? config.workspaceImage,
            ports: Object.entries(projectManifest.environment.services).map(([service, value]) => ({
              service,
              port: value.port,
              protocol: value.protocol,
              websocket: value.websocket,
            })),
          },
        }),
      );
      reply.status(202);
      return storyResponse(result);
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId",
    {
      config: { permission: "projects:read" },
      schema: { params: StoryParams, operationId: "getWorkspaceStory" },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const actor = principal(request);
      return storyResponse(
        await translate(() => domain.stories.get(actor.orgId, projectId, storyId)),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/workspace-stories/:storyId/messages",
    {
      config: { permission: "workspaces:execute", idempotent: true },
      schema: {
        params: StoryParams,
        body: SendMessageBody,
        operationId: "sendWorkspaceStoryMessage",
      },
    },
    async (request, reply) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const body = request.body as z.infer<typeof SendMessageBody>;
      const actor = principal(request);
      const orgId = actor.orgId;
      const projection = await translate(() => domain.catalog.get(orgId, projectId, body.agent));
      const queued = await translate(() =>
        domain.stories.queueMessage({
          orgId,
          projectId,
          storyId,
          body: body.message,
          dedupeKey: body.idempotency_key,
          agent: manifestFromProjection(projection),
          actor: principalActor(actor),
          trigger: { type: "manual" },
        }),
      );
      reply.status(202);
      return { queued };
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/conversation",
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        querystring: ConversationQuery,
        operationId: "getWorkspaceStoryConversation",
      },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const query = request.query as z.infer<typeof ConversationQuery>;
      const actor = principal(request);
      return {
        messages: await translate(() =>
          domain.stories.conversation(actor.orgId, projectId, storyId, query),
        ),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/environment",
    {
      config: { permission: "projects:read" },
      schema: { params: StoryParams, operationId: "getWorkspaceStoryEnvironment" },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const orgId = principal(request).orgId;
      const bundle = await translate(() => domain.stories.get(orgId, projectId, storyId));
      if (!bundle.workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found");
      const workspace = bundle.workspace;
      const events = await app.facilityDb
        .select()
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.orgId, orgId),
            eq(workspaceEvents.workspaceId, bundle.workspace.id),
          ),
        )
        .orderBy(desc(workspaceEvents.seq))
        .limit(100);
      return {
        workspace: presentWorkspace(workspace),
        inspection: await translate(() => domain.runtime.inspect(workspaceLocator(workspace))),
        events: events.reverse(),
      };
    },
  );

  for (const [action, permission] of [
    ["suspend", "workspaces:execute"],
    ["archive", "projects:write"],
    ["restore", "projects:write"],
  ] as const) {
    app.post(
      `/v1/projects/:projectId/workspace-stories/:storyId/${action}`,
      {
        config: { permission, idempotent: true },
        schema: { params: StoryParams, operationId: `${action}WorkspaceStory` },
      },
      async (request) => {
        const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
        const actor = principal(request);
        return storyResponse(
          await translate(() => domain.stories[action](actor.orgId, projectId, storyId)),
        );
      },
    );
  }

  app.delete(
    "/v1/projects/:projectId/workspace-stories/:storyId/workspace",
    {
      config: { permission: "projects:write", idempotent: true },
      schema: { params: StoryParams, body: DeleteBody, operationId: "deleteStoryWorkspace" },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const body = request.body as z.infer<typeof DeleteBody>;
      const actor = principal(request);
      if (request.headers["idempotency-key"] !== body.idempotency_key) {
        throw new ApiError(
          400,
          "idempotency_key_required",
          "Idempotency-Key must match idempotency_key for permanent workspace deletion",
        );
      }
      return storyResponse(
        await translate(() =>
          domain.stories.deleteWorkspace({
            orgId: actor.orgId,
            projectId,
            storyId,
            actor: principalActor(actor),
            confirm: true,
          }),
        ),
      );
    },
  );
}

function principalActor(principal: { type: "user" | "key"; id: string }) {
  return {
    type: principal.type === "key" ? ("service" as const) : ("user" as const),
    id: principal.id,
  };
}

function storyResponse(value: Record<string, unknown>) {
  const workspace = value.workspace as Parameters<typeof presentWorkspace>[0] | undefined;
  return {
    ...value,
    ...(workspace ? { workspace: presentWorkspace(workspace) } : {}),
    status: (value.story as { status?: string } | undefined)?.status,
    needs_attention:
      ((value.attention as unknown[] | undefined)?.length ?? 0) > 0 ||
      (value.story as { status?: string } | undefined)?.status === "attention",
  };
}

function presentWorkspace(row: { environment: unknown; [key: string]: unknown }) {
  const environment = row.environment as {
    image?: unknown;
    ports?: unknown;
    resources?: unknown;
  };
  return {
    ...row,
    environment: {
      image: environment.image,
      ports: environment.ports,
      resources: environment.resources,
    },
  };
}

function workspaceLocator(row: {
  id: string;
  externalRef: string | null;
  volumeRef: string;
  environment: unknown;
}) {
  const environment = row.environment as {
    image?: string;
    variables?: Record<string, string>;
    ports?: Array<{
      service: string;
      port: number;
      protocol?: "http" | "https";
      websocket?: boolean;
    }>;
    resources?: { cpu: number; memoryMb: number };
  };
  if (!row.externalRef || !environment.image) {
    throw new ApiError(409, "workspace_not_ready", "Workspace is not ready");
  }
  return {
    id: row.id,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
    image: environment.image,
    environment: environment.variables,
    ports: environment.ports,
    resources: environment.resources,
  };
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const value = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof value.code === "string") {
      throw new ApiError(
        typeof value.statusCode === "number" ? value.statusCode : 409,
        value.code,
        typeof value.message === "string" ? value.message : value.code,
        undefined,
        value.code === "agent_catalog_unavailable",
      );
    }
    throw error;
  }
}
