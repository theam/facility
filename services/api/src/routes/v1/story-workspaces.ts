import {
  type AgentManifest,
  AgentNameSchema,
  AgentTriggerSchema,
  renderAgentManifest,
} from "@facility/agents";
import { projectRepositories, workspaceEvents } from "@facility/db";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { manifestFromProjection } from "../../agents/catalog.js";
import { ApiError } from "../../errors.js";
import { provisionalTitle, resolveDefaultAgent } from "../../stories/phase.js";
import type { AppConfig } from "../../types.js";
import {
  parseWorkspaceVariables,
  WorkspaceVariablesInput,
  WorkspaceVariablesMetadata,
} from "../../workspaces/variables.js";
import { principal } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const AttentionParams = StoryParams.extend({ attentionId: z.string() });
const TurnParams = StoryParams.extend({ turnId: z.string() });
const TurnEventParams = TurnParams.extend({ seq: z.coerce.number().int().min(0) });
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
  /** Repository the GitHub identity belongs to; defaults to the primary repository. */
  repository_id: z.string().min(1).max(200).optional(),
  /** Optional. Omitted titles start provisional and are generated from the request. */
  title: z.string().trim().min(1).max(500).optional(),
  /** Optional. Omitted agents resolve to the project's default for this surface. */
  agent: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(200_000),
  idempotency_key: z.string().min(1).max(200),
});
const SendMessageBody = z.object({
  agent: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(200_000),
  idempotency_key: z.string().min(1).max(200),
});
const ListStoriesQuery = z.object({
  status: z.enum(["ready", "working", "attention", "review", "done", "archived"]).optional(),
});
const ConversationQuery = z.object({
  order: z.enum(["asc", "desc"]).default("asc"),
  before: z.coerce.number().int().min(1).optional(),
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const StoryBundleQuery = z.object({
  // "recent" keeps the bounded turn events and composed timeline in the bundle for
  // existing clients; readers that page evidence separately ask for "none".
  evidence: z.enum(["recent", "none"]).default("recent"),
});
const ActivityQuery = z.object({
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const TimelineQuery = z.object({
  // Opaque keyset cursor returned as next_cursor by the previous page.
  before: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const EnvironmentQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const DeleteBody = z.object({
  confirm: z.literal(true),
  idempotency_key: z.string().min(8).max(200),
});

export async function registerStoryWorkspaceRoutes(app: FastifyInstance, config: AppConfig) {
  const domain = app.storyDomain;

  for (const method of ["GET", "PATCH"] as const) {
    app.route({
      method,
      url: "/v1/projects/:projectId/environment/variables",
      config: {
        permission: method === "GET" ? "workspaces:read" : "workspaces:execute",
        ...(method === "PATCH" ? { auditAction: "project.variables.updated" } : {}),
      },
      schema: {
        params: ProjectParams,
        ...(method === "PATCH" ? { body: WorkspaceVariablesInput } : {}),
        operationId: method === "GET" ? "listProjectVariables" : "updateProjectVariables",
        response: { 200: WorkspaceVariablesMetadata },
      },
      handler: async (request, reply) => {
        const { projectId } = request.params as z.infer<typeof ProjectParams>;
        const scope = { orgId: principal(request).orgId, projectId };
        reply.header("cache-control", "no-store");
        return method === "GET"
          ? domain.variables.projectMetadata(scope)
          : domain.variables.updateProject(
              scope,
              parseWorkspaceVariables(request.body as z.infer<typeof WorkspaceVariablesInput>),
            );
      },
    });
  }

  for (const method of ["GET", "PATCH"] as const) {
    app.route({
      method,
      url: "/v1/projects/:projectId/workspace-stories/:storyId/environment/variables",
      config: {
        permission: method === "GET" ? "workspaces:read" : "workspaces:execute",
        ...(method === "PATCH" ? { auditAction: "workspace.variables.updated" } : {}),
      },
      schema: {
        params: StoryParams,
        ...(method === "PATCH" ? { body: WorkspaceVariablesInput } : {}),
        operationId: method === "GET" ? "listWorkspaceVariables" : "updateWorkspaceVariables",
        response: { 200: WorkspaceVariablesMetadata },
      },
      handler: async (request, reply) => {
        const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
        const actor = principal(request);
        const { workspace } = await domain.stories.get(actor.orgId, projectId, storyId);
        if (!workspace) throw new ApiError(404, "not_found", "Workspace not found");
        const scope = { orgId: actor.orgId, projectId, workspaceId: workspace.id };
        reply.header("cache-control", "no-store");
        return method === "GET"
          ? domain.variables.metadata(scope)
          : domain.variables.update(
              scope,
              parseWorkspaceVariables(request.body as z.infer<typeof WorkspaceVariablesInput>),
            );
      },
    });
  }

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
      const manifests = rows.map(manifestFromProjection);
      return {
        agents: rows.map((row) => ({
          ...manifestFromProjection(row),
          commit_sha: row.commitSha,
          synced_at: row.syncedAt,
          schedule_status: presentScheduleStatus(scheduleStatus.get(row.name)),
        })),
        defaults: {
          ui: resolveDefaultAgent(manifests, "ui")?.name ?? null,
          mcp: resolveDefaultAgent(manifests, "mcp")?.name ?? null,
          manual: resolveDefaultAgent(manifests, "manual")?.name ?? null,
        },
        title_generation: await domain.titles.available(actor.orgId, projectId),
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
      const surface = requestSurface(request.headers["x-facility-surface"]);
      const [manifest, projectManifest] = await translate(() =>
        Promise.all([
          selectAgent(domain, orgId, projectId, body.agent, surface),
          domain.projectManifests.load(orgId, projectId),
        ]),
      );
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
                    body.repository_id
                      ? eq(projectRepositories.id, body.repository_id)
                      : eq(projectRepositories.role, "primary"),
                  ),
                )
                .limit(1)
            )[0]?.id
          : undefined;
      if (body.provider === "github" && !repositoryId) {
        throw new ApiError(404, "repository_not_found", "Repository not found in this project");
      }
      requireAgentSurface(manifest, surface);
      // A request without a title is stored at once under a provisional title.
      // The AI title arrives asynchronously; the request is never held for it.
      const titled = body.title !== undefined;
      const generation = titled ? false : await domain.titles.available(orgId, projectId);
      const result = await translate(() =>
        domain.stories.start({
          orgId,
          projectId,
          repositoryId,
          provider: body.provider,
          externalId: body.external_id ?? `manual:${body.idempotency_key}`,
          title: body.title ?? provisionalTitle(body.message),
          titleSource: titled
            ? body.provider === "github"
              ? "github"
              : "user"
            : generation
              ? "pending"
              : "fallback",
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
      if (result.story.titleSource === "pending") {
        try {
          await domain.titles.request({ orgId, projectId, storyId: result.story.id });
        } catch (error) {
          // The worker re-queues pending titles on its own; the story is already durable.
          request.log.warn({ err: error, storyId: result.story.id }, "title job enqueue failed");
        }
      }
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
      schema: {
        params: StoryParams,
        querystring: StoryBundleQuery,
        operationId: "getWorkspaceStory",
      },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const query = request.query as z.infer<typeof StoryBundleQuery>;
      const actor = principal(request);
      return storyResponse(
        await translate(() =>
          domain.stories.get(actor.orgId, projectId, storyId, {
            evidence: query.evidence !== "none",
          }),
        ),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/timeline",
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        querystring: TimelineQuery,
        operationId: "getWorkspaceStoryTimeline",
      },
    },
    async (request) => {
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const query = request.query as z.infer<typeof TimelineQuery>;
      const actor = principal(request);
      const before = query.before === undefined ? undefined : decodeTimelineCursor(query.before);
      const page = await translate(() =>
        domain.stories.timelinePage(actor.orgId, projectId, storyId, {
          limit: query.limit,
          before,
        }),
      );
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          source: entry.source,
          type: entry.type,
          turn_id: entry.turnId,
          data: entry.data,
          occurred_at: entry.occurredAt,
          observed_at: entry.observedAt,
        })),
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? encodeTimelineCursor(page.nextCursor) : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/turns/:turnId/activity",
    {
      config: { permission: "projects:read" },
      schema: {
        params: TurnParams,
        querystring: ActivityQuery,
        operationId: "getWorkspaceStoryTurnActivity",
      },
    },
    async (request) => {
      const { projectId, storyId, turnId } = request.params as z.infer<typeof TurnParams>;
      const query = request.query as z.infer<typeof ActivityQuery>;
      const actor = principal(request);
      const page = await translate(() =>
        domain.stories.turnActivity(actor.orgId, projectId, storyId, turnId, query),
      );
      return {
        turn: page.turn,
        items: page.items,
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/turns/:turnId/events/:seq",
    {
      config: { permission: "projects:read" },
      schema: { params: TurnEventParams, operationId: "getWorkspaceStoryTurnEvent" },
    },
    async (request, reply) => {
      const { projectId, storyId, turnId, seq } = request.params as z.infer<typeof TurnEventParams>;
      const actor = principal(request);
      const event = await translate(() =>
        domain.stories.turnEvent(actor.orgId, projectId, storyId, turnId, seq),
      );
      reply.header("cache-control", "no-store");
      return {
        turn_id: event.turnId,
        seq: event.seq,
        type: event.type,
        data: event.data,
        created_at: event.createdAt,
      };
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
      const surface = requestSurface(request.headers["x-facility-surface"]);
      const manifest = await translate(() =>
        selectAgent(domain, orgId, projectId, body.agent, surface),
      );
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
      const page = await translate(() =>
        domain.stories.conversationPage(actor.orgId, projectId, storyId, query),
      );
      return {
        messages: page.messages,
        related: page.related,
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
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
        ...(query.before === undefined ? [] : [lt(workspaceEvents.seq, query.before)]),
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
        const workspaceRow = bundle.workspace;
        const manifest = await translate(() => domain.projectManifests.load(orgId, projectId));
        // Validate before issuing credentials, waking compute, or touching the workspace.
        if (action === "browser-test" && !manifest.environment.browser_test) {
          throw new ApiError(
            409,
            "browser_test_not_configured",
            ".facility.yml does not define environment.browser_test",
          );
        }
        let browser: Awaited<ReturnType<typeof domain.environment.runBrowserTest>> | undefined;
        if (action === "browser-test") {
          const setupChecksum = workspaceRow.setupChecksum;
          if (!setupChecksum) {
            throw new ApiError(
              409,
              "workspace_not_prepared",
              "Prepare the workspace with Clean setup before running a browser test",
            );
          }
          const credentials = await translate(() => domain.credentials.issue(orgId, projectId));
          const input = {
            orgId,
            projectId,
            workspace: workspaceLocator(workspaceRow),
            manifest,
            credentials,
          };
          await translate(() => domain.environment.startPrepared({ ...input, setupChecksum }));
          browser = await translate(() => domain.environment.runBrowserTest({ ...input, storyId }));
        } else {
          const branch = bundle.story.branch;
          if (!branch)
            throw new ApiError(409, "story_branch_missing", "Story branch is not available");
          const credentials = await translate(() => domain.credentials.issue(orgId, projectId));
          await translate(() =>
            domain.environment.prepare({
              orgId,
              projectId,
              workspace: workspaceLocator(workspaceRow),
              manifest,
              credentials,
              branch,
              previousSetupChecksum: workspaceRow.setupChecksum,
              cleanSetup: true,
            }),
          );
        }
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

function encodeTimelineCursor(cursor: { at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ at: cursor.at.toISOString(), id: cursor.id })).toString(
    "base64url",
  );
}

function decodeTimelineCursor(value: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };
    const at = typeof parsed.at === "string" ? new Date(parsed.at) : new Date(Number.NaN);
    if (!Number.isFinite(at.getTime()) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("invalid");
    }
    return { at, id: parsed.id };
  } catch {
    throw new ApiError(400, "timeline_cursor_invalid", "The timeline cursor is not valid");
  }
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
  const events = value.events as
    | Array<{
        turnId: string;
        seq: number;
        type: string;
        data: unknown;
        createdAt: Date;
      }>
    | undefined;
  const timeline = value.timeline as
    | Array<{
        id: string;
        source: string;
        type: string;
        turnId: string | null;
        data: unknown;
        occurredAt: Date;
        observedAt: Date;
      }>
    | undefined;
  const { events: _events, timeline: _timeline, ...rest } = value;
  return {
    ...rest,
    ...(events
      ? {
          events: events.map((event) => ({
            turn_id: event.turnId,
            seq: event.seq,
            type: event.type,
            data: event.data,
            created_at: event.createdAt,
          })),
        }
      : {}),
    ...(timeline
      ? {
          timeline: timeline.map((event) => ({
            id: event.id,
            source: event.source,
            type: event.type,
            turn_id: event.turnId,
            data: event.data,
            occurred_at: event.occurredAt,
            observed_at: event.observedAt,
          })),
        }
      : {}),
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

/**
 * A named agent is looked up directly. Without a name, the project's catalog
 * decides through the same rule the UI shows, so "no selection" is predictable
 * and honours the agents the repository enables for this surface.
 */
async function selectAgent(
  domain: FastifyInstance["storyDomain"],
  orgId: string,
  projectId: string,
  name: string | undefined,
  surface: "manual" | "mcp" | "ui",
): Promise<AgentManifest> {
  if (name) return manifestFromProjection(await domain.catalog.get(orgId, projectId, name));
  const rows = await domain.catalog.list(orgId, projectId);
  const manifest = resolveDefaultAgent(rows.map(manifestFromProjection), surface);
  if (!manifest) {
    throw new ApiError(
      409,
      "agent_unavailable",
      `No enabled agent in .agents/ accepts ${surface} requests; choose an agent or enable one`,
    );
  }
  return manifest;
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
