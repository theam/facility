import { FacilityApiError, FacilityClient, type QueryParams } from "@facility/sdk";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

type Method = "GET" | "POST" | "DELETE";
type Args = Record<string, unknown>;
type Shape = Record<string, z.ZodType>;
type ApiClientLike = {
  request(
    method: string,
    path: string,
    options?: {
      query?: QueryParams;
      body?: unknown;
      idempotencyKey?: string;
      responseType?: "json" | "text";
    },
  ): Promise<unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  permission: string;
  inputSchema?: Shape;
  method: Method;
  path: (args: Args) => string;
  query?: (args: Args) => QueryParams;
  body?: (args: Args) => unknown;
  write?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  idempotencyKey?: (args: Args) => string | undefined;
};

export type FacilityMcpOptions = {
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  client?: ApiClientLike;
};

const projectId = z.string().min(1).describe("Facility project id.");
const storyId = z.string().min(1).describe("Facility story id.");
const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .describe("Stable key for safely retrying this action.");
const agent = z
  .string()
  .min(1)
  .max(64)
  .default("builder")
  .describe("Agent name from the repository's .agents directory.");

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "facility_list_projects",
    permission: "projects:read",
    description: "List accessible Facility projects and their runtime status. Needs projects:read.",
    method: "GET",
    path: () => "/v1/projects",
    query: () => ({ limit: 200, offset: 0 }),
  },
  {
    name: "facility_list_agents",
    permission: "projects:read",
    description:
      "List the agents, engines, models, and triggers defined in a project's .agents directory. Needs projects:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/story-agents`,
  },
  {
    name: "facility_list_stories",
    permission: "projects:read",
    description:
      "List persistent stories for a project, optionally filtered by state. Needs projects:read.",
    inputSchema: {
      projectId,
      status: z.enum(["ready", "working", "attention", "review", "done", "archived"]).optional(),
    },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/workspace-stories`,
    query: (args) => ({ status: stringValue(args.status) }),
  },
  {
    name: "facility_get_story",
    permission: "projects:read",
    description:
      "Get a story's status, workspace, active turn, branch, pull request, artifacts, and attention items. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}`,
  },
  {
    name: "facility_start_story",
    permission: "workspaces:execute",
    description:
      "Create or resume one persistent story workspace and queue its first agent turn directly. Needs workspaces:execute.",
    inputSchema: {
      projectId,
      provider: z.enum(["github", "manual"]).default("manual"),
      externalId: z.string().min(1).max(240).optional(),
      title: z.string().min(1).max(500),
      agent,
      message: z.string().min(1).max(200_000),
      idempotencyKey,
    },
    method: "POST",
    path: (args) => `/v1/projects/${part(args.projectId)}/workspace-stories`,
    body: (args) => ({
      provider: args.provider,
      external_id: args.externalId,
      title: args.title,
      agent: args.agent,
      message: args.message,
      idempotency_key: args.idempotencyKey,
    }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_send_message",
    permission: "workspaces:execute",
    description:
      "Append a message to the shared story conversation and queue the selected repository-defined agent. Needs workspaces:execute.",
    inputSchema: {
      projectId,
      storyId,
      agent,
      message: z.string().min(1).max(200_000),
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/messages`,
    body: (args) => ({
      agent: args.agent,
      message: args.message,
      idempotency_key: args.idempotencyKey,
    }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_get_conversation",
    permission: "projects:read",
    description:
      "Read ordered messages from a story's persistent conversation. Needs projects:read.",
    inputSchema: {
      projectId,
      storyId,
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/conversation`,
    query: (args) => ({ after: Number(args.after ?? 0), limit: Number(args.limit ?? 50) }),
  },
  {
    name: "facility_get_environment",
    permission: "projects:read",
    description:
      "Inspect the story workspace, service endpoints, readiness, and recent environment events. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/environment`,
  },
  {
    name: "facility_open_preview",
    permission: "workspaces:execute",
    description:
      "Wake the workspace and return a short-lived authenticated browser URL for one configured service. Needs workspaces:execute.",
    inputSchema: { projectId, storyId, service: z.string().min(1).max(63) },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/preview/${part(args.service)}/open`,
    write: true,
    openWorld: true,
  },
  ...(["suspend", "archive", "restore"] as const).map(
    (action): ToolDefinition => ({
      name: `facility_${action}_story`,
      permission: action === "suspend" ? "workspaces:execute" : "projects:write",
      description: `${capitalize(action)} a story without deleting its worktree or native agent sessions. Needs ${
        action === "suspend" ? "workspaces:execute" : "projects:write"
      }.`,
      inputSchema: { projectId, storyId },
      method: "POST",
      path: (args) =>
        `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/${action}`,
      write: true,
    }),
  ),
  {
    name: "facility_delete_workspace",
    permission: "projects:write",
    description:
      "Permanently delete a story's worktree, native sessions, and durable workspace volume. This is the only destructive lifecycle action. Needs projects:write.",
    inputSchema: {
      projectId,
      storyId,
      confirm: z.literal(true).describe("Must be true after reviewing what will be deleted."),
      idempotencyKey,
    },
    method: "DELETE",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/workspace`,
    body: (args) => ({ confirm: true, idempotency_key: args.idempotencyKey }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    destructive: true,
  },
];

export function createFacilityMcpServer(options: FacilityMcpOptions): McpServer {
  const server = new McpServer({ name: "@facility/mcp", version: "0.12.0" });
  const api =
    options.client ??
    (new FacilityClient({
      baseUrl: options.apiUrl,
      apiKey: options.apiKey,
      fetch: options.fetch,
    }) as unknown as ApiClientLike);

  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        title: humanize(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: {
          data: z.unknown().optional(),
          error: z
            .object({
              code: z.string(),
              message: z.string(),
              status: z.number().int().optional(),
              details: z.unknown().optional(),
            })
            .optional(),
        },
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: !tool.write || Boolean(tool.idempotencyKey),
          openWorldHint: tool.openWorld ?? false,
        },
      },
      async (args) => {
        try {
          const values = (args ?? {}) as Args;
          const data = await api.request(tool.method, tool.path(values), {
            query: tool.query?.(values),
            body: tool.body?.(values),
            idempotencyKey: tool.idempotencyKey?.(values),
          });
          return jsonResult(data);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
  server.server.registerCapabilities({ tools: { listChanged: false } });

  server.registerResource(
    "facility-project",
    new ResourceTemplate("facility://projects/{id}", {
      list: async () => {
        const result = await api.request("GET", "/v1/projects", {
          query: { limit: 200, offset: 0 },
        });
        return {
          resources: rows(result).map((project) => ({
            uri: `facility://projects/${project.id}`,
            name: String(project.name ?? project.id),
            description: String(project.status ?? ""),
            mimeType: "application/json",
          })),
        };
      },
    }),
    { mimeType: "application/json", description: "Facility project by id." },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            await api.request("GET", `/v1/projects/${part(variables.id)}`),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "facility-story",
    new ResourceTemplate("facility://projects/{projectId}/stories/{storyId}", {
      list: undefined,
    }),
    { mimeType: "application/json", description: "Persistent Facility story by id." },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            await api.request(
              "GET",
              `/v1/projects/${part(variables.projectId)}/workspace-stories/${part(variables.storyId)}`,
            ),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    "facility-work-on-story",
    {
      description: "Start or continue a persistent Facility story through the task-oriented tools.",
      argsSchema: {
        projectId: z.string().min(1),
        storyId: z.string().min(1).optional(),
      },
    },
    async ({ projectId: selectedProject, storyId: selectedStory }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: selectedStory
              ? `Continue Facility story ${selectedStory} in project ${selectedProject}. Read the story and conversation first, then send the next explicit instruction with the appropriate repository-defined agent.`
              : `Start a Facility story in project ${selectedProject}. List .agents first, choose the requested agent, and use a stable idempotency key.`,
          },
        },
      ],
    }),
  );

  return server;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { data: value },
  };
}

function errorResult(error: unknown): CallToolResult {
  const value =
    error instanceof FacilityApiError
      ? {
          code: error.code,
          message: error.message,
          status: error.status,
          ...(error.details === undefined ? {} : { details: error.details }),
        }
      : {
          code: "facility_request_failed",
          message: error instanceof Error ? error.message : String(error),
        };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: value }) }],
    structuredContent: { error: value },
  };
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of ["projects", "items", "data"]) {
      if (Array.isArray(value[key])) return value[key].filter(isRecord);
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function part(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function humanize(name: string) {
  return name
    .replace(/^facility_/, "")
    .split("_")
    .map(capitalize)
    .join(" ");
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
