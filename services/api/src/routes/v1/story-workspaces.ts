import {
  type AgentManifest,
  AgentNameSchema,
  AgentTriggerSchema,
  renderAgentManifest,
} from "@facility/agents";
import { projectRepositories, workspaceEvents } from "@facility/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { manifestFromProjection } from "../../agents/catalog.js";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import { principal } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const AttentionParams = StoryParams.extend({ attentionId: z.string() });
const TurnParams = StoryParams.extend({ turnId: z.string() });
const StoryAgentParams = z.object({ projectId: z.string(), agentName: AgentNameSchema });
const ReasoningEffort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const UpdateAgentBody = z.object({
  expected_commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
  description: z.string().min(1).max(240),
  engine: z.enum(["claude_code", "codex"]),
  model: z.string().min(1).max(160),
  reasoning_effort: ReasoningEffort.nullable().optional(),
  enabled: z.boolean(),
  triggers: z.array(AgentTriggerSchema).min(1),
  prompt: z.string().trim().min(1).max(200_000),
});
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
const EnvironmentQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
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
      const [rows, scheduleStatus] = await translate(() =>
        Promise.all([
          domain.catalog.list(actor.orgId, projectId),
          domain.scheduler.status(actor.orgId, projectId),
        ]),
      );
      return {
        agents: rows.map((row) => ({
          ...manifestFromProjection(row),
          commit_sha: row.commitSha,
          synced_at: row.syncedAt,
          schedule_status: presentScheduleStatus(scheduleStatus.get(row.name)),
        })),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/project-skills",
    {
      config: { permission: "projects:read" },
      schema: { params: ProjectParams, operationId: "listProjectSkills" },
    },
    async (request) => {
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const actor = principal(request);
      const rows = await translate(() => domain.catalog.listSkills(actor.orgId, projectId));
      return {
        skills: rows.map((row) => ({
          name: row.name,
          description: row.description,
          path: row.path,
          directory: row.directory,
          hash: row.contentHash,
          commit_sha: row.commitSha,
          synced_at: row.syncedAt,
        })),
      };
    },
  );

  for (const action of ["retry", "dismiss"] as const) {
    app.post(
      `/v1/projects/:projectId/workspace-stories/:storyId/attention/:attentionId/${action}`,
      {
        config: { permission: "workspaces:execute", idempotent: true },
        schema: {
          params: AttentionParams,
          operationId: `${action}WorkspaceStoryAttention`,
        },
      },
      async (request) => {
        const { projectId, storyId, attentionId } = request.params as z.infer<
          typeof AttentionParams
        >;
        const actor = principal(request);
        const input = {
          orgId: actor.orgId,
          projectId,
          storyId,
          attentionId,
          actor: principalActor(actor),
        };
        return storyResponse(
          await translate(() =>
            action === "retry"
              ? domain.stories.retryAttention(input)
              : domain.stories.dismissAttention(input),
          ),
        );
      },
    );
  }

  app.patch(
    "/v1/projects/:projectId/story-agents/:agentName",
    {
      config: { permission: "projects:write", idempotent: true },
      schema: { params: StoryAgentParams, body: UpdateAgentBody, operationId: "updateStoryAgent" },
    },
    async (request) => {
      const { projectId, agentName } = request.params as z.infer<typeof StoryAgentParams>;
      const body = request.body as z.infer<typeof UpdateAgentBody>;
      const actor = principal(request);
      const result = await translate(async () => {
        const rendered = renderAgentManifest(
          {
            name: agentName,
            description: body.description,
            engine: body.engine,
            model: body.model,
            enabled: body.enabled,
            options: body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {},
            triggers: body.triggers,
            prompt: body.prompt,
          },
          `.agents/${agentName}.md`,
        );
        return domain.catalog.proposeUpdate(actor.orgId, projectId, {
          name: agentName,
          source: rendered.source,
          expectedCommitSha: body.expected_commit_sha,
        });
      });
      return {
        agent: result.agent,
        base_commit_sha: result.baseCommitSha,
        branch: result.branch,
        commit_sha: result.commitSha,
        pull_request: result.pullRequest,
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
      const [row, scheduleStatus] = await translate(() =>
        Promise.all([
          domain.catalog.get(actor.orgId, projectId, agentName),
          domain.scheduler.status(actor.orgId, projectId),
        ]),
      );
      return {
        ...manifestFromProjection(row),
        commit_sha: row.commitSha,
        synced_at: row.syncedAt,
        schedule_status: presentScheduleStatus(scheduleStatus.get(row.name)),
      };
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
      const manifest = manifestFromProjection(projection);
      const repositoryId =
        body.provider === "github"
          ? (
              await app.facilityDb
                .select({ id: projectRepositories.id })
                .from(projectRepositories)
                .where(
                  and(
                    eq(projectRepositories.orgId, orgId),
                    eq(projectRepositories.projectId, projectId),
                    eq(projectRepositories.role, "primary"),
                  ),
                )
                .limit(1)
            )[0]?.id
          : undefined;
      const surface = requestSurface(request.headers["x-facility-surface"]);
      requireAgentSurface(manifest, surface);
      const result = await translate(() =>
        domain.stories.start({
          orgId,
          projectId,
          repositoryId,
          provider: body.provider,
          externalId: body.external_id ?? `manual:${body.idempotency_key}`,
          title: body.title,
          agent: manifest,
          message: body.message,
          messageDedupeKey: body.idempotency_key,
          actor: principalActor(actor),
          trigger: { type: surface },
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

  app.post(
    "/v1/projects/:projectId/workspace-stories/:storyId/turns/:turnId/cancel",
    {
      config: { permission: "workspaces:execute", idempotent: true },
      schema: { params: TurnParams, operationId: "cancelWorkspaceStoryTurn" },
    },
    async (request) => {
      const { projectId, storyId, turnId } = request.params as z.infer<typeof TurnParams>;
      const actor = principal(request);
      return storyResponse(
        await translate(() =>
          domain.stories.cancelTurn({
            orgId: actor.orgId,
            projectId,
            storyId,
            turnId,
            actor: principalActor(actor),
          }),
        ),
      );
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
      const manifest = manifestFromProjection(projection);
      const surface = requestSurface(request.headers["x-facility-surface"]);
      requireAgentSurface(manifest, surface);
      const queued = await translate(() =>
        domain.stories.queueMessage({
          orgId,
          projectId,
          storyId,
          body: body.message,
          dedupeKey: body.idempotency_key,
          agent: manifest,
          actor: principalActor(actor),
          trigger: { type: surface },
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
      schema: {
        params: StoryParams,
        querystring: EnvironmentQuery,
        operationId: "getWorkspaceStoryEnvironment",
      },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const query = request.query as z.infer<typeof EnvironmentQuery>;
      const orgId = principal(request).orgId;
      const bundle = await translate(() => domain.stories.get(orgId, projectId, storyId));
      if (!bundle.workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found");
      const workspace = bundle.workspace;
      const eventScope = and(
        eq(workspaceEvents.orgId, orgId),
        eq(workspaceEvents.workspaceId, bundle.workspace.id),
        ...(query.after === undefined ? [] : [gt(workspaceEvents.seq, query.after)]),
      );
      const rows = await app.facilityDb
        .select()
        .from(workspaceEvents)
        .where(eventScope)
        .orderBy(query.after === undefined ? desc(workspaceEvents.seq) : asc(workspaceEvents.seq))
        .limit(query.limit + 1);
      const hasMore = rows.length > query.limit;
      const events = rows.slice(0, query.limit).sort((left, right) => left.seq - right.seq);
      const inspection = await translate(() => domain.runtime.inspect(workspaceLocator(workspace)));
      return {
        workspace: presentWorkspace(workspace),
        inspection,
        metrics: workspaceMetrics(events, inspection),
        events,
        next_cursor: events.at(-1)?.seq ?? query.after ?? 0,
        has_more: hasMore,
      };
    },
  );

  for (const action of ["clean-setup", "browser-test"] as const) {
    app.post(
      `/v1/projects/:projectId/workspace-stories/:storyId/environment/${action}`,
      {
        config: {
          permission: action === "clean-setup" ? "projects:write" : "workspaces:execute",
        },
        schema: {
          params: StoryParams,
          operationId:
            action === "clean-setup"
              ? "cleanSetupWorkspaceStoryEnvironment"
              : "testWorkspaceStoryEnvironmentInBrowser",
        },
      },
      async (request) => {
        const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
        const orgId = principal(request).orgId;
        const bundle = await translate(() => domain.stories.get(orgId, projectId, storyId));
        if (!bundle.workspace) {
          throw new ApiError(404, "workspace_not_found", "Workspace not found");
        }
        if (bundle.workspace.state === "destroyed") {
          throw new ApiError(409, "workspace_deleted", "Workspace has been deleted");
        }
        if (!bundle.story.branch) {
          throw new ApiError(409, "story_branch_missing", "Story branch is not available");
        }
        const workspaceRow = bundle.workspace;
        const branch = bundle.story.branch;
        const [manifest, credentials] = await translate(() =>
          Promise.all([
            domain.projectManifests.load(orgId, projectId),
            domain.credentials.issue(orgId, projectId),
          ]),
        );
        const workspace = workspaceLocator(workspaceRow);
        await translate(() =>
          domain.environment.prepare({
            orgId,
            projectId,
            workspace,
            manifest,
            credentials,
            branch,
            previousSetupChecksum: workspaceRow.setupChecksum,
            cleanSetup: action === "clean-setup",
          }),
        );
        const browser =
          action === "browser-test"
            ? await translate(() =>
                domain.environment.runBrowserTest({
                  orgId,
                  projectId,
                  storyId,
                  workspace,
                  manifest,
                  credentials,
                }),
              )
            : undefined;
        return {
          ...storyResponse(await domain.stories.get(orgId, projectId, storyId)),
          ...(browser
            ? {
                browser_test: {
                  exit_code: browser.result.exitCode,
                  duration_ms: browser.result.durationMs,
                  artifacts: browser.artifacts.map((artifact) => ({
                    id: artifact.id,
                    kind: artifact.kind,
                    label: artifact.label,
                    uri: artifact.uri,
                  })),
                },
              }
            : {}),
        };
      },
    );
  }

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

function presentScheduleStatus(
  status:
    | {
        schedules: Array<{
          triggerName: string;
          cron: string;
          timezone: string;
          enabled: boolean;
          nextRunAt: Date;
          lastScheduledAt: Date | null;
        }>;
        lastResult?: {
          state: string;
          endedAt: Date | null;
          createdAt: Date;
          error: string | null;
        };
      }
    | undefined,
) {
  return {
    schedules: (status?.schedules ?? []).map((schedule) => ({
      name: schedule.triggerName,
      cron: schedule.cron,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      next_run_at: schedule.nextRunAt,
      last_scheduled_at: schedule.lastScheduledAt,
    })),
    last_result: status?.lastResult
      ? {
          state: status.lastResult.state,
          at: status.lastResult.endedAt ?? status.lastResult.createdAt,
          error: status.lastResult.error,
        }
      : null,
  };
}

function storyResponse(value: Record<string, unknown>) {
  const workspace = value.workspace as Parameters<typeof presentWorkspace>[0] | undefined;
  const story = value.story as
    | { status?: string; deletedAt?: unknown; archivedAt?: unknown }
    | undefined;
  const attention =
    (value.attention as
      | Array<{
          status?: string;
          kind?: string;
          turnId?: string | null;
        }>
      | undefined) ?? [];
  const openAttention = attention.filter((item) => item.status === "open");
  const events =
    (value.events as
      | Array<{
          turnId: string;
          seq: number;
          type: string;
          data: unknown;
          createdAt: Date;
        }>
      | undefined) ?? [];
  const timeline =
    (value.timeline as
      | Array<{
          id: string;
          source: string;
          type: string;
          turnId: string | null;
          data: unknown;
          occurredAt: Date;
          observedAt: Date;
        }>
      | undefined) ?? [];
  return {
    ...value,
    events: events.map((event) => ({
      turn_id: event.turnId,
      seq: event.seq,
      type: event.type,
      data: event.data,
      created_at: event.createdAt,
    })),
    timeline: timeline.map((event) => ({
      id: event.id,
      source: event.source,
      type: event.type,
      turn_id: event.turnId,
      data: event.data,
      occurred_at: event.occurredAt,
      observed_at: event.observedAt,
    })),
    ...(workspace ? { workspace: presentWorkspace(workspace) } : {}),
    status: story?.status,
    needs_attention: openAttention.length > 0 || story?.status === "attention",
    next_operations: nextOperations(story, workspace, openAttention),
  };
}

function nextOperations(
  story: { status?: string; deletedAt?: unknown } | undefined,
  workspace: Parameters<typeof presentWorkspace>[0] | undefined,
  attention: Array<{ kind?: string; turnId?: string | null }>,
) {
  if (!story || story.deletedAt) return ["view_conversation"];
  const operations = ["view_conversation"];
  if (story.status === "archived") operations.push("restore");
  else operations.push("send_message", "suspend", "archive");
  if (workspace && workspace.state !== "destroyed")
    operations.push("open_preview", "delete_workspace");
  if (attention.length > 0) operations.push("dismiss_attention");
  if (attention.some((item) => item.kind === "agent_waiting")) operations.push("reply");
  if (attention.some((item) => item.turnId && item.kind !== "agent_waiting"))
    operations.push("retry");
  if (story.status === "working") operations.push("cancel_turn");
  return [...new Set(operations)];
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

function workspaceMetrics(
  events: Array<{ type: string; data: unknown }>,
  inspection: {
    state: string;
    volumeRef: string;
    usage?: Record<string, unknown>;
  },
) {
  const ready = events.filter((event) => event.type === "workspace.ready");
  const duration = (operation: string) => {
    const event = ready.findLast(
      (candidate) =>
        candidate.data &&
        typeof candidate.data === "object" &&
        (candidate.data as { operation?: unknown }).operation === operation,
    );
    const value = (event?.data as { durationMs?: unknown } | undefined)?.durationMs;
    return typeof value === "number" ? value : null;
  };
  return {
    create_time_ms: duration("create"),
    wake_time_ms: duration("wake"),
    active_compute: inspection.state === "running",
    retained_storage: inspection.state !== "destroyed",
    provider_errors: events.filter((event) => event.type === "workspace.provider_error").length,
    usage: inspection.usage ?? {},
    cost: {
      currency: "USD",
      active_compute_cents: null,
      retained_storage_cents: null,
      status: "provider_pricing_unavailable",
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

function requestSurface(value: string | string[] | undefined): "manual" | "mcp" | "ui" {
  const surface = Array.isArray(value) ? value[0] : value;
  return surface === "mcp" || surface === "ui" ? surface : "manual";
}

function requireAgentSurface(agent: AgentManifest, surface: "manual" | "mcp" | "ui") {
  if (!agent.enabled) {
    throw new ApiError(409, "agent_disabled", `Agent ${agent.name} is disabled`);
  }
  if (!agent.triggers.some((trigger) => trigger.type === surface)) {
    throw new ApiError(
      409,
      "agent_trigger_unavailable",
      `Agent ${agent.name} does not allow ${surface} activation`,
    );
  }
}
