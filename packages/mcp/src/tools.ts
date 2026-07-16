import { createHash } from "node:crypto";
import {
  FacilityApiError,
  FacilityClient,
  type FacilityRouteBody,
  type FacilityRoutePath,
  type FacilityRouteResponse,
  type McpToolProposalRequest,
  type QueryParams,
  type Run,
  type RunEvent,
} from "@facility/sdk";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Shape = Record<string, z.ZodType>;
type Args = Record<string, unknown>;
type ApiRequest = {
  method: Method;
  path: string;
  query?: QueryParams;
  body?: unknown;
  responseType?: "json" | "text";
};
type ApiClient = {
  request<RequestMethod extends Method, Path extends FacilityRoutePath<RequestMethod>>(
    method: RequestMethod,
    path: Path,
    options?: {
      query?: QueryParams;
      body?: FacilityRouteBody<RequestMethod, Path>;
      idempotencyKey?: string;
      responseType?: "json" | "text";
    },
  ): Promise<FacilityRouteResponse<RequestMethod, Path>>;
};
type ApiClientLike = {
  request(
    method: string,
    path: string,
    options?: { query?: QueryParams; body?: unknown; responseType?: "json" | "text" },
  ): Promise<unknown>;
};

const optionalString = z.string().min(1).optional();
const pageInput = {
  limit: z.number().int().min(1).max(200).default(50).describe("Page size, max 200."),
  offset: z.number().int().min(0).default(0).describe("Zero-based pagination offset."),
};
const pageQuery = (args: Args) => ({
  limit: Number(args.limit ?? 50),
  offset: Number(args.offset ?? 0),
});
const toolOutputSchema = {
  data: z.unknown().optional().describe("Successful Facility API result."),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      status: z.number().int().optional(),
      details: z.unknown().optional(),
    })
    .optional()
    .describe("Structured error when isError is true."),
};
export type FacilityMcpOptions = {
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  client?: ApiClientLike;
};

type ToolDefinition = {
  name: string;
  description: string;
  permission: string;
  inputSchema?: Shape;
  write?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  request?: (args: Args) => ApiRequest | Promise<ApiRequest>;
  summarize?: (args: Args) => string;
};

const readTools: ToolDefinition[] = [
  {
    name: "facility_me",
    permission: "org:read",
    description:
      "Show the authenticated Facility principal, org, and granted permissions. Needs org:read.",
    request: () => ({ method: "GET", path: "/v1/me" }),
  },
  {
    name: "facility_list_projects",
    permission: "projects:read",
    description:
      "List Facility projects visible to the caller, optionally filtered by status. Needs projects:read.",
    inputSchema: {
      status: optionalString.describe("Project status filter, such as active or archived."),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/projects",
      query: { status: str(args.status), ...pageQuery(args) },
    }),
  },
  {
    name: "facility_get_project",
    permission: "projects:read",
    description:
      "Fetch one Facility project by id for configuration, status, and repo context. Needs projects:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    request: (args) => ({ method: "GET", path: `/v1/projects/${pathPart(args.projectId)}` }),
  },
  {
    name: "facility_list_runs",
    permission: "runs:read",
    description:
      "List runs for a project, or all visible projects when projectId is omitted. Needs runs:read.",
    inputSchema: {
      projectId: optionalString.describe(
        "Facility project id. Omit to aggregate visible projects.",
      ),
      status: optionalString.describe(
        "Run status filter, such as running, failed, or awaiting_human.",
      ),
      limit: z.number().int().min(1).max(200).default(50).describe("Page size, max 200."),
      offset: z.number().int().min(0).default(0).describe("Zero-based pagination offset."),
    },
    request: (args) => ({
      method: "GET",
      path: args.projectId ? `/v1/projects/${pathPart(args.projectId)}/runs` : "/v1/runs",
      query: {
        status: str(args.status),
        limit: Number(args.limit ?? 50),
        offset: Number(args.offset ?? 0),
      },
    }),
  },
  {
    name: "facility_get_run",
    permission: "runs:read",
    description:
      "Fetch one run and include the last N run events inline, capped at 200. Needs runs:read.",
    inputSchema: {
      runId: z.string().min(1).describe("Facility run id."),
      lastEvents: z
        .number()
        .int()
        .min(0)
        .max(200)
        .default(50)
        .describe("Number of recent events to include, max 200."),
    },
    request: (args) => ({ method: "GET", path: `/v1/runs/${pathPart(args.runId)}` }),
  },
  {
    name: "facility_list_run_events",
    permission: "runs:read",
    description:
      "Read the next page of durable run events after a sequence number; repeat with the last returned seq to page long runs. Needs runs:read.",
    inputSchema: {
      runId: z.string().min(1).describe("Facility run id."),
      afterSeq: z.number().int().min(0).default(0).describe("Return events after this sequence."),
      limit: z.number().int().min(1).max(500).default(100).describe("Page size, max 500."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/runs/${pathPart(args.runId)}/events`,
      query: { afterSeq: Number(args.afterSeq ?? 0), limit: Number(args.limit ?? 100) },
    }),
  },
  {
    name: "facility_list_inbox",
    permission: "hitl:read",
    description: "List human-in-the-loop proposals waiting on the caller. Needs hitl:read.",
    inputSchema: {
      state: optionalString.describe(
        "Proposal state filter. Defaults to open in most operator workflows.",
      ),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/inbox",
      query: { state: str(args.state) ?? "open", ...pageQuery(args) },
    }),
  },
  {
    name: "facility_get_proposal",
    permission: "hitl:read",
    description: "Fetch one proposal with its decision ledger events. Needs hitl:read.",
    inputSchema: { proposalId: z.string().min(1).describe("Facility proposal id.") },
    request: (args) => ({ method: "GET", path: `/v1/proposals/${pathPart(args.proposalId)}` }),
  },
  {
    name: "facility_spend",
    permission: "spend:read",
    description:
      "Review LLM spend counters, optionally scoped to a project and grouped for analysis. Needs spend:read.",
    inputSchema: {
      projectId: optionalString.describe("Facility project id."),
      groupBy: z.enum(["model", "agent", "task", "day"]).optional().describe("Aggregation bucket."),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/spend",
      query: { projectId: str(args.projectId), groupBy: str(args.groupBy), ...pageQuery(args) },
    }),
  },
  {
    name: "facility_list_registry",
    permission: "registry:read",
    description:
      "List registry items such as skills, guards, contracts, harnesses, and template sets. Needs registry:read.",
    inputSchema: { kind: optionalString.describe("Registry item kind filter."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: "/v1/registry/items",
      query: { kind: str(args.kind), ...pageQuery(args) },
    }),
  },
  {
    name: "facility_get_registry_item",
    permission: "registry:read",
    description:
      "Fetch one registry item with versions so the active content can be inspected. Needs registry:read.",
    inputSchema: { itemId: z.string().min(1).describe("Registry item id."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: `/v1/registry/items/${pathPart(args.itemId)}`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_list_issues",
    permission: "issues:read",
    description:
      "List platform issues such as drift, budget breaches, stuck runs, and integration errors. Needs issues:read.",
    inputSchema: {
      state: optionalString.describe("Issue state filter."),
      kind: optionalString.describe("Issue kind filter."),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/issues",
      query: { state: str(args.state), kind: str(args.kind), ...pageQuery(args) },
    }),
  },
  {
    name: "facility_audit_tail",
    permission: "audit:read",
    description:
      "Read the latest audit events for incident review and change attribution. Needs audit:read.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(25)
        .describe("Maximum audit events to return, max 500."),
      actor: optionalString.describe("Actor id or type:id filter."),
      action: optionalString.describe("Audit action filter."),
      cursor: z.number().int().optional().describe("Pagination cursor from the previous page."),
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/audit",
      query: {
        limit: Math.min(Number(args.limit ?? 25), 500),
        actor: str(args.actor),
        action: str(args.action),
        cursor: typeof args.cursor === "number" ? args.cursor : undefined,
      },
    }),
  },
  {
    name: "facility_llm_requests",
    permission: "spend:read",
    description:
      "Fetch raw LLM request rows for data mining, including tokens, cost, latency, status, and envelope URIs. Needs spend:read.",
    inputSchema: {
      projectId: optionalString.describe("Facility project id."),
      from: optionalString.describe("Inclusive ISO timestamp lower bound."),
      to: optionalString.describe("Inclusive ISO timestamp upper bound."),
      limit: z.number().int().min(1).max(500).default(25).describe("Page size, max 500."),
      cursor: optionalString.describe("Pagination cursor from the previous page."),
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/llm-requests",
      query: {
        projectId: str(args.projectId),
        from: str(args.from),
        to: str(args.to),
        limit: Math.min(Number(args.limit ?? 25), 500),
        cursor: str(args.cursor),
      },
    }),
  },
  {
    name: "facility_llm_request_envelope",
    permission: "audit:read",
    description:
      "Fetch the stored request/response envelope (full transcript) for one LLM request id. Needs audit:read.",
    inputSchema: {
      requestId: z.string().min(1).describe("llm_requests.id to fetch."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/llm-requests/${pathPart(args.requestId)}/envelope`,
    }),
  },
  {
    name: "facility_list_budgets",
    permission: "budgets:read",
    description:
      "List org, project, and agent budget limits used by gateway enforcement. Needs budgets:read.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/budgets", query: pageQuery(args) }),
  },
  {
    name: "facility_get_budget",
    permission: "budgets:read",
    description: "Fetch one enforced budget by id. Needs budgets:read.",
    inputSchema: { budgetId: z.string().min(1).describe("Facility budget id.") },
    request: (args) => ({ method: "GET", path: `/v1/budgets/${pathPart(args.budgetId)}` }),
  },
  {
    name: "facility_get_org",
    permission: "org:read",
    description: "Fetch organization metadata and settings. Needs org:read and org scope.",
    request: () => ({ method: "GET", path: "/v1/org" }),
  },
  {
    name: "facility_list_members",
    permission: "members:read",
    description: "List organization members with their roles. Needs members:read and org scope.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/members", query: pageQuery(args) }),
  },
  {
    name: "facility_list_roles",
    permission: "roles:read",
    description:
      "List bundled and organization roles with permissions. Needs roles:read and org scope.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/roles", query: pageQuery(args) }),
  },
  {
    name: "facility_list_api_keys",
    permission: "keys:issue",
    description: "List API key metadata; secrets are never returned. Needs keys:issue.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/keys", query: pageQuery(args) }),
  },
  {
    name: "facility_list_repos",
    permission: "repos:read",
    description: "List GitHub repositories connected to a project. Needs repos:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/repos`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_list_agents",
    permission: "agents:read",
    description:
      "List agent definitions, triggers, engines, and contracts for a project. Needs agents:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/agents`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_list_providers",
    permission: "providers:read",
    description:
      "List configured provider credential metadata without secrets. Needs providers:read and org scope.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/providers", query: pageQuery(args) }),
  },
  {
    name: "facility_list_action_types",
    permission: "hitl:read",
    description: "List proposal action types and their payload schemas. Needs hitl:read.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/action-types", query: pageQuery(args) }),
  },
  {
    name: "facility_get_action_type",
    permission: "hitl:read",
    description: "Fetch one proposal action type and payload schema. Needs hitl:read.",
    inputSchema: { actionTypeId: z.string().min(1).describe("Facility action type id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/action-types/${pathPart(args.actionTypeId)}`,
    }),
  },
  {
    name: "facility_list_sandboxes",
    permission: "sandboxes:read",
    description: "List sandbox execution profiles. Needs sandboxes:read.",
    inputSchema: pageInput,
    request: (args) => ({ method: "GET", path: "/v1/sandbox-profiles", query: pageQuery(args) }),
  },
  {
    name: "facility_list_tasks",
    permission: "tasks:read",
    description: "List product-owner tasks for a project. Needs tasks:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/tasks`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_list_virtual_keys",
    permission: "keys:issue",
    description: "List project virtual-key metadata without secrets. Needs keys:issue.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id."), ...pageInput },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/virtual-keys`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_get_kb_space",
    permission: "kb:read",
    description:
      "Fetch the project knowledge-base charter, active index, and config. Needs kb:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/kb/space`,
    }),
  },
  {
    name: "facility_list_kb_entries",
    permission: "kb:read",
    description: "List project knowledge-base entries, optionally by artifact type. Needs kb:read.",
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      type: optionalString.describe("Artifact type filter."),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/kb/entries`,
      query: { type: str(args.type), ...pageQuery(args) },
    }),
  },
  {
    name: "facility_get_kb_entry",
    permission: "kb:read",
    description: "Fetch one knowledge-base entry by id. Needs kb:read.",
    inputSchema: { entryId: z.string().min(1).describe("Facility KB entry id.") },
    request: (args) => ({ method: "GET", path: `/v1/kb/entries/${pathPart(args.entryId)}` }),
  },
  {
    name: "facility_analytics",
    permission: "analytics:read",
    description: "Query operational analytics by day, agent, or model. Needs analytics:read.",
    inputSchema: {
      projectId: optionalString.describe("Facility project id."),
      from: optionalString.describe("Inclusive ISO timestamp."),
      to: optionalString.describe("Inclusive ISO timestamp."),
      groupBy: z.enum(["day", "agent", "model"]).default("day"),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/analytics",
      query: {
        projectId: str(args.projectId),
        from: str(args.from),
        to: str(args.to),
        groupBy: str(args.groupBy),
        ...pageQuery(args),
      },
    }),
  },
  {
    name: "facility_analytics_overview",
    permission: "analytics:read",
    description: "Fetch the current analytics overview. Needs analytics:read.",
    inputSchema: pageInput,
    request: (args) => ({
      method: "GET",
      path: "/v1/analytics/overview",
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_verify_audit",
    permission: "audit:read",
    description:
      "Verify the organization audit hash chain and locate the first break. Needs audit:read.",
    request: () => ({ method: "GET", path: "/v1/audit/verify" }),
  },
  {
    name: "facility_list_integrations",
    permission: "integrations:read",
    description: "List inbound and outbound integrations without secrets. Needs integrations:read.",
    inputSchema: {
      projectId: optionalString.describe("Facility project id."),
      kind: optionalString.describe(
        "Integration kind, including managed catalog kinds such as github or github_app.",
      ),
      enabled: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/integrations",
      query: {
        projectId: str(args.projectId),
        kind: str(args.kind),
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        limit: Number(args.limit ?? 50),
        offset: Number(args.offset ?? 0),
      },
    }),
  },
  {
    name: "facility_get_integration",
    permission: "integrations:read",
    description:
      "Fetch one integration configuration without its signing secret. Needs integrations:read.",
    inputSchema: { integrationId: z.string().min(1).describe("Facility integration id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/integrations/${pathPart(args.integrationId)}`,
    }),
  },
  {
    name: "facility_integration_deliveries",
    permission: "integrations:read",
    description: "List outbound webhook delivery attempts and outcomes. Needs integrations:read.",
    inputSchema: {
      integrationId: z.string().min(1).describe("Facility integration id."),
      status: optionalString.describe("Delivery status filter."),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/integrations/${pathPart(args.integrationId)}/deliveries`,
      query: {
        status: str(args.status),
        limit: Number(args.limit ?? 50),
        offset: Number(args.offset ?? 0),
      },
    }),
  },
  {
    name: "facility_integration_events",
    permission: "integrations:read",
    description:
      "List verified and processed inbound events for an integration. Needs integrations:read.",
    inputSchema: {
      integrationId: z.string().min(1).describe("Facility integration id."),
      ...pageInput,
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/integrations/${pathPart(args.integrationId)}/events`,
      query: pageQuery(args),
    }),
  },
  {
    name: "facility_catalog",
    permission: "org:read",
    description:
      "Discover supported engines, priced models, permissions, and wired trigger types. Needs org:read.",
    request: () => ({ method: "GET", path: "/v1/catalog" }),
  },
  {
    name: "facility_agent_status",
    permission: "agents:read",
    description:
      "Inspect live, recent, scheduled, and integration-bound status for every project agent. Needs agents:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/agents/status`,
    }),
  },
  {
    name: "facility_run_transcript",
    permission: "runs:read",
    description:
      "Read a run's complete durable NDJSON transcript for diagnosis or handoff. Needs runs:read.",
    inputSchema: { runId: z.string().min(1).describe("Facility run id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/runs/${pathPart(args.runId)}/transcript`,
      responseType: "text",
    }),
  },
  {
    name: "facility_list_conversations",
    permission: "runs:read",
    description:
      "List durable resumable agent conversations for a project, including the latest message. Needs runs:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/conversations`,
    }),
  },
  {
    name: "facility_get_conversation",
    permission: "runs:read",
    description: "Read one durable conversation and its ordered messages. Needs runs:read.",
    inputSchema: {
      conversationId: z.string().min(1).describe("Facility conversation id."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/conversations/${pathPart(args.conversationId)}`,
    }),
  },
  {
    name: "facility_github_installations",
    permission: "projects:kickstart",
    description:
      "List organization GitHub App installations available for repository discovery. Needs projects:kickstart and org scope.",
    openWorld: true,
    request: () => ({ method: "GET", path: "/v1/github/installations" }),
  },
  {
    name: "facility_github_installation_repos",
    permission: "projects:kickstart",
    description:
      "Discover repositories visible to one GitHub App installation. Needs projects:kickstart and org scope.",
    openWorld: true,
    inputSchema: {
      installationId: z.number().int().positive().describe("Numeric GitHub installation id."),
      query: optionalString.describe("Optional owner/name search text."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/github/installations/${pathPart(String(args.installationId))}/repos`,
      query: { query: str(args.query) },
    }),
  },
  {
    name: "facility_list_github_issues",
    permission: "runs:read",
    description:
      "List the synchronized GitHub issue cache with linked Facility runs. Needs runs:read.",
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      state: z.enum(["open", "closed", "all"]).default("open"),
      query: optionalString.describe("Title search text."),
      cursor: optionalString.describe("Opaque cursor from the previous page."),
      limit: z.number().int().min(1).max(100).default(50),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/issues`,
      query: {
        state: str(args.state),
        q: str(args.query),
        cursor: str(args.cursor),
        limit: Number(args.limit ?? 50),
      },
    }),
  },
  {
    name: "facility_get_github_issue",
    permission: "runs:read",
    description:
      "Read a synchronized GitHub issue with body and linked run history. Needs runs:read.",
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      number: z.number().int().positive().describe("GitHub issue number."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/issues/${pathPart(String(args.number))}`,
    }),
  },
  {
    name: "facility_list_outcomes",
    permission: "runs:read",
    description:
      "List open or terminal pull-request outcomes for delivery review. Needs runs:read.",
    inputSchema: {
      projectId: optionalString.describe("Optional Facility project id."),
      state: z.enum(["open", "terminal", "all"]).default("open"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    request: (args) => ({
      method: "GET",
      path: "/v1/outcomes",
      query: {
        projectId: str(args.projectId),
        state: str(args.state),
        limit: Number(args.limit ?? 50),
      },
    }),
  },
  {
    name: "facility_project_health",
    permission: "projects:read",
    description: "Inspect project health signals and readiness. Needs projects:read.",
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/health`,
    }),
  },
  {
    name: "facility_kickstart_preview",
    permission: "projects:kickstart",
    description:
      "Preview remote kickstart files and conflicts for a project repo before opening a PR. Needs projects:kickstart.",
    openWorld: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      repoId: z
        .string()
        .min(1)
        .describe("Facility repo id or owner/name, depending on API configuration."),
    },
    request: (args) => ({
      method: "GET",
      path: `/v1/projects/${pathPart(args.projectId)}/kickstart/preview`,
      query: { repoId: str(args.repoId) },
    }),
  },
];

const writeTools: ToolDefinition[] = [
  {
    name: "facility_trigger_run",
    permission: "runs:trigger",
    description:
      "Propose a platform-native agent run for a project; execution waits for separate human approval. Needs runs:trigger.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      agentName: z.string().min(1).describe("Agent definition name to run."),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Structured operator input payload for the run trigger."),
    },
    summarize: (args) => `Trigger agent ${str(args.agentName)} on project ${str(args.projectId)}.`,
  },
  {
    name: "facility_cancel_run",
    permission: "runs:write",
    description:
      "Propose canceling a queued or active run; execution waits for separate human approval. Needs runs:write.",
    write: true,
    destructive: true,
    idempotent: true,
    inputSchema: { runId: z.string().min(1).describe("Facility run id.") },
    summarize: (args) => `Cancel run ${str(args.runId)}.`,
  },
  {
    name: "facility_steer_run",
    permission: "runs:steer",
    description:
      "Propose an audited steering message for an active run; delivery waits for separate human approval. Needs runs:steer.",
    write: true,
    inputSchema: {
      runId: z.string().min(1).describe("Facility run id."),
      body: z.string().min(1).describe("Steering instruction to inject."),
    },
    summarize: (args) => `Steer run ${str(args.runId)} with a human-authored message.`,
  },
  {
    name: "facility_interrupt_run",
    permission: "runs:steer",
    description:
      "Propose interrupting an active run at its next engine control point; delivery waits for separate human approval. Needs runs:steer.",
    write: true,
    destructive: true,
    idempotent: true,
    inputSchema: { runId: z.string().min(1).describe("Facility run id.") },
    summarize: (args) => `Interrupt active run ${str(args.runId)}.`,
  },
  {
    name: "facility_resume_run",
    permission: "runs:trigger",
    description:
      "Propose resuming a terminal Claude Code run from its durable engine session. Needs runs:trigger.",
    write: true,
    inputSchema: {
      runId: z.string().min(1).describe("Terminal Facility run id."),
      message: optionalString.describe("Optional instruction for the resumed session."),
    },
    summarize: (args) => `Resume terminal run ${str(args.runId)}.`,
  },
  {
    name: "facility_start_conversation",
    permission: "runs:trigger",
    description:
      "Propose starting a durable project conversation with a Claude Code agent. Needs runs:trigger.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      agentDefId: optionalString.describe(
        "Claude Code agent definition id; defaults to the project-owner agent.",
      ),
      title: optionalString.describe("Optional conversation title."),
    },
    summarize: (args) => `Start a durable conversation in project ${str(args.projectId)}.`,
  },
  {
    name: "facility_send_conversation_message",
    permission: "runs:trigger",
    description:
      "Propose sending the next message in a durable conversation; after separate human approval, Facility queues the resulting run. Needs runs:trigger.",
    write: true,
    inputSchema: {
      conversationId: z.string().min(1).describe("Facility conversation id."),
      body: z.string().min(1).describe("Message to send."),
    },
    summarize: (args) => `Send the next message in conversation ${str(args.conversationId)}.`,
  },
  {
    name: "facility_sync_github_issues",
    permission: "repos:write",
    description:
      "Propose refreshing the synchronized GitHub issue cache for every connected project repository. Needs repos:write.",
    write: true,
    idempotent: true,
    openWorld: true,
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    summarize: (args) => `Synchronize GitHub issues for project ${str(args.projectId)}.`,
  },
  {
    name: "facility_trigger_github_issue",
    permission: "runs:trigger",
    description:
      "Propose triggering a project agent from a synchronized GitHub issue. Needs runs:trigger.",
    write: true,
    openWorld: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      number: z.number().int().positive().describe("Synchronized GitHub issue number."),
      agentName: z.string().min(1).describe("Agent definition name or command handle."),
    },
    summarize: (args) =>
      `Trigger ${str(args.agentName)} from GitHub issue #${String(args.number)} in project ${str(args.projectId)}.`,
  },
  {
    name: "facility_create_project",
    permission: "projects:write",
    description:
      "Propose creating a Facility project; creation waits for separate human approval. Needs projects:write.",
    write: true,
    inputSchema: {
      name: z.string().min(1).describe("Project display name."),
      slug: z.string().min(1).describe("Stable project slug."),
      description: optionalString.describe("Optional project description."),
    },
    summarize: (args) => `Create project ${str(args.slug)}.`,
  },
  {
    name: "facility_archive_project",
    permission: "projects:write",
    description: "Archive a Facility project after separate human approval. Needs projects:write.",
    write: true,
    destructive: true,
    idempotent: true,
    inputSchema: { projectId: z.string().min(1).describe("Facility project id.") },
    summarize: (args) => `Archive project ${str(args.projectId)}.`,
  },
  {
    name: "facility_kickstart",
    permission: "projects:kickstart",
    description:
      "Propose opening a governed kickstart PR; creation waits for separate human approval. Needs projects:kickstart.",
    write: true,
    openWorld: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      repoId: z.string().min(1).describe("Facility repo id or owner/name."),
      answers: z
        .record(z.string(), z.unknown())
        .describe("Kickstart answers for rendering the managed assets."),
    },
    summarize: (args) => `Kickstart repo ${str(args.repoId)} for project ${str(args.projectId)}.`,
  },
  {
    name: "facility_upgrade_project",
    permission: "projects:write",
    description:
      "Propose opening a governed upgrade PR; creation waits for separate human approval. Needs projects:write.",
    write: true,
    openWorld: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      repoId: z.string().min(1).describe("Facility repo id or owner/name."),
      toVersion: optionalString.describe("Target Facility system/template version."),
    },
    summarize: (args) =>
      `Upgrade project ${str(args.projectId)}${args.toVersion ? ` to ${str(args.toVersion)}` : ""}.`,
  },
  {
    name: "facility_set_budget",
    permission: "budgets:write",
    description:
      "Propose creating or updating a gateway-enforced spend budget; the change waits for separate human approval. Needs budgets:write.",
    write: true,
    inputSchema: {
      budgetId: optionalString.describe("Existing budget id to update; omit to create."),
      scope: z.enum(["org", "project", "agent_def"]).describe("Budget scope."),
      projectId: optionalString.describe("Project id for project or agent budgets."),
      agentDefId: optionalString.describe("Agent definition id for agent budgets."),
      period: z.enum(["daily", "weekly", "monthly"]).describe("Budget period."),
      limitCents: z
        .number()
        .int()
        .nonnegative()
        .describe("Budget limit in cents (0 freezes all spend)."),
      mode: z.enum(["soft", "hard"]).describe("Soft alert or hard block mode."),
      enabled: z.boolean().default(true).describe("Whether the budget is active."),
    },
    summarize: (args) =>
      `Set ${str(args.period)} ${str(args.scope)} budget to ${String(args.limitCents)} cents.`,
  },
  {
    name: "facility_publish_registry_version",
    permission: "registry:publish",
    description:
      "Propose publishing a draft registry version; activation waits for separate human approval. Needs registry:publish.",
    write: true,
    destructive: true,
    inputSchema: { versionId: z.string().min(1).describe("Registry version id.") },
    summarize: (args) => `Publish registry version ${str(args.versionId)}.`,
  },
  {
    name: "facility_deprecate_registry_version",
    permission: "registry:publish",
    description:
      "Deprecate a registry version after separate human approval. Needs registry:publish.",
    write: true,
    destructive: true,
    idempotent: true,
    inputSchema: { versionId: z.string().min(1).describe("Registry version id.") },
    summarize: (args) => `Deprecate registry version ${str(args.versionId)}.`,
  },
  {
    name: "facility_create_agent",
    permission: "agents:write",
    description:
      "Propose a project agent definition bound to a contract, triggers, and sandbox; creation waits for separate human approval. Needs agents:write.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      name: z.string().min(1).describe("Agent definition name."),
      engine: z.enum(["claude_code", "codex", "byo"]).describe("Execution engine."),
      model: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Model policy/configuration accepted by the API."),
      contractItemId: optionalString.describe("Registry contract item id."),
      contractContent: optionalString.describe(
        "Inline contract content when no registry item exists.",
      ),
      triggers: z
        .array(z.record(z.string(), z.unknown()))
        .default([])
        .describe("Agent trigger definitions."),
      sandboxProfileId: optionalString.describe("Sandbox profile id."),
    },
    summarize: (args) => `Create agent ${str(args.name)} in project ${str(args.projectId)}.`,
  },
  {
    name: "facility_update_agent",
    permission: "agents:write",
    description:
      "Update an agent's execution contract, model, triggers, sandbox, or enabled state after human approval. Needs agents:write.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      agentId: z.string().min(1).describe("Facility agent definition id."),
      name: optionalString,
      engine: z.enum(["claude_code", "codex", "byo"]).optional(),
      model: z.record(z.string(), z.unknown()).optional(),
      contractItemId: optionalString,
      harnessItemId: optionalString,
      triggers: z.array(z.record(z.string(), z.unknown())).optional(),
      sandboxProfileId: optionalString,
      enabled: z.boolean().optional(),
    },
    summarize: (args) => `Update agent ${str(args.agentId)} in project ${str(args.projectId)}.`,
  },
  {
    name: "facility_retire_agent",
    permission: "agents:write",
    description: "Retire an agent definition after separate human approval. Needs agents:write.",
    write: true,
    destructive: true,
    idempotent: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      agentId: z.string().min(1).describe("Facility agent definition id."),
    },
    summarize: (args) => `Retire agent ${str(args.agentId)} from project ${str(args.projectId)}.`,
  },
  {
    name: "facility_ack_issue",
    permission: "issues:write",
    description: "Acknowledge an open watchtower issue after human approval. Needs issues:write.",
    write: true,
    idempotent: true,
    inputSchema: { issueId: z.string().min(1).describe("Facility issue id.") },
    summarize: (args) => `Acknowledge issue ${str(args.issueId)}.`,
  },
  {
    name: "facility_resolve_issue",
    permission: "issues:write",
    description:
      "Resolve an open or acknowledged watchtower issue after human approval. Needs issues:write.",
    write: true,
    idempotent: true,
    inputSchema: { issueId: z.string().min(1).describe("Facility issue id.") },
    summarize: (args) => `Resolve issue ${str(args.issueId)}.`,
  },
  {
    name: "facility_retry_webhook_delivery",
    permission: "integrations:write",
    description:
      "Retry a failed or dead webhook delivery after separate human approval. Needs integrations:write.",
    write: true,
    idempotent: true,
    inputSchema: {
      deliveryId: z.string().min(1).describe("Facility webhook delivery id."),
    },
    summarize: (args) => `Retry webhook delivery ${str(args.deliveryId)}.`,
  },
  {
    name: "facility_create_task",
    permission: "tasks:write",
    description: "Create a governed project task after human approval. Needs tasks:write.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      title: z.string().min(1).describe("Task title."),
      bodyMd: z.string().min(1).describe("Task body in Markdown."),
      status: z.string().min(1).default("draft").describe("Initial task state."),
      kbEntryId: optionalString.describe("Optional KB entry in the same project."),
      wsjf: z.record(z.string(), z.unknown()).default({}).describe("WSJF/value metadata."),
    },
    summarize: (args) => `Create task ${str(args.title)} in project ${str(args.projectId)}.`,
  },
  {
    name: "facility_transition_task",
    permission: "tasks:write",
    description: "Move an existing task to another state after human approval. Needs tasks:write.",
    write: true,
    inputSchema: {
      taskId: z.string().min(1).describe("Facility task id."),
      status: z.string().min(1).describe("Target task state."),
    },
    summarize: (args) => `Transition task ${str(args.taskId)} to ${str(args.status)}.`,
  },
  {
    name: "facility_propose_task",
    permission: "tasks:write",
    description:
      "Submit a task for its separate task-creation approval workflow. The MCP action and external task creation remain independently governed. Needs tasks:write.",
    write: true,
    inputSchema: { taskId: z.string().min(1).describe("Facility task id.") },
    summarize: (args) => `Submit task ${str(args.taskId)} for creation approval.`,
  },
  {
    name: "facility_amend_kb",
    permission: "kb:write",
    description:
      "Create a validated draft KB amendment and bidirectional provenance links after human approval. Needs kb:write.",
    write: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      type: z.string().min(1).describe("KB artifact type."),
      slug: z.string().min(1).describe("Stable artifact slug."),
      bodyMd: z.string().min(1).describe("Artifact body in Markdown."),
      frontmatter: z.record(z.string(), z.unknown()).default({}),
      links: z.array(z.string()).default([]).describe("Parent KB entry ids."),
      evidenceRefs: z.array(z.string()).default([]).describe("Evidence references for review."),
    },
    summarize: (args) => `Amend project ${str(args.projectId)} KB with ${str(args.slug)}.`,
  },
  {
    name: "facility_create_registry_draft",
    permission: "registry:write",
    description:
      "Create a new registry item or next draft version after human approval. Needs registry:write.",
    write: true,
    inputSchema: {
      scope: z.enum(["org", "project"]),
      projectId: optionalString.describe("Required for project scope."),
      kind: z.string().min(1).describe("Registry item kind."),
      name: z.string().min(1).describe("Registry item name."),
      description: optionalString,
      content: z.string().min(1).describe("Draft content."),
    },
    summarize: (args) => `Create ${str(args.kind)} registry draft ${str(args.name)}.`,
  },
  {
    name: "facility_connect_repo",
    permission: "repos:write",
    description:
      "Connect an installed GitHub repository, or create one in the installed organization, after human approval. Needs repos:write.",
    write: true,
    openWorld: true,
    inputSchema: {
      projectId: z.string().min(1).describe("Facility project id."),
      owner: z.string().min(1).describe("GitHub organization with an active App installation."),
      name: z.string().min(1).describe("Repository name."),
      mode: z.enum(["connect", "create"]).default("connect"),
      defaultBranch: z.string().min(1).default("main"),
      private: z.boolean().default(true),
      description: optionalString,
      autoInit: z.boolean().default(true),
    },
    summarize: (args) => `${str(args.mode)} GitHub repo ${str(args.owner)}/${str(args.name)}.`,
  },
];

export const toolDefinitions = [...readTools, ...writeTools];

export function createFacilityMcpServer(options: FacilityMcpOptions): McpServer {
  const server = new McpServer({ name: "@facility/mcp", version: "0.3.0" });
  const client =
    options.client ??
    new FacilityClient({ baseUrl: options.apiUrl, apiKey: options.apiKey, fetch: options.fetch });
  const api = client as ApiClient;

  for (const tool of toolDefinitions) {
    const inputSchema = tool.inputSchema;
    server.registerTool(
      tool.name,
      {
        title: humanizeToolName(tool.name),
        description: tool.description,
        inputSchema,
        outputSchema: toolOutputSchema,
        annotations: tool.write
          ? {
              destructiveHint: tool.destructive ?? false,
              idempotentHint: tool.idempotent ?? false,
              openWorldHint: tool.openWorld ?? false,
              readOnlyHint: false,
            }
          : {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: tool.openWorld ?? false,
              readOnlyHint: true,
            },
      },
      async (args, extra) => {
        try {
          const recordArgs = (args ?? {}) as Args;
          if (tool.write) {
            return jsonResult(await proposeWrite(tool, recordArgs, api, String(extra.requestId)));
          }
          return jsonResult(await dispatchTool(tool, recordArgs, api));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
  // Facility's tool catalog is fixed for the lifetime of a server process.
  // Narrow the high-level SDK's default capability to the contract we keep.
  server.server.registerCapabilities({ tools: { listChanged: false } });

  server.registerResource(
    "facility-me",
    "facility://me",
    { mimeType: "application/json", description: "Current Facility principal and org." },
    async () => ({
      contents: [
        {
          uri: "facility://me",
          mimeType: "application/json",
          text: JSON.stringify(await api.request("GET", "/v1/me"), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "facility-project",
    new ResourceTemplate("facility://projects/{id}", {
      list: async () => {
        const projects = await api.request("GET", "/v1/projects", {
          query: { limit: 200, offset: 0 },
        });
        return {
          resources: projects.map((project) => ({
            uri: `facility://projects/${project.id}`,
            name: project.name,
            description: `${project.slug} · ${project.status}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        id: async (value) => {
          const projects = await api.request("GET", "/v1/projects", {
            query: { limit: 200, offset: 0 },
          });
          return projects
            .filter(
              (project) =>
                project.id.toLowerCase().includes(value.toLowerCase()) ||
                project.slug.toLowerCase().includes(value.toLowerCase()),
            )
            .slice(0, 50)
            .map((project) => project.id);
        },
      },
    }),
    { mimeType: "application/json", description: "Facility project by id." },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            await api.request("GET", `/v1/projects/${pathPart(variables.id)}`),
            null,
            2,
          ),
        },
      ],
    }),
  );
  server.registerResource(
    "facility-run",
    new ResourceTemplate("facility://runs/{id}", {
      list: async () => {
        const runs = await api.request("GET", "/v1/runs", { query: { limit: 50, offset: 0 } });
        return {
          resources: runs.map((run) => ({
            uri: `facility://runs/${run.id}`,
            name: `${run.project.slug} · ${run.id}`,
            description: `${run.status} · ${run.engine} · ${run.mode}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        id: async (value) => {
          const runs = await api.request("GET", "/v1/runs", {
            query: { limit: 50, offset: 0 },
          });
          return runs
            .filter((run) => run.id.toLowerCase().includes(value.toLowerCase()))
            .map((run) => run.id);
        },
      },
    }),
    { mimeType: "application/json", description: "Facility run transcript window by id." },
    async (uri, variables) => {
      const run = await api.request("GET", `/v1/runs/${pathPart(variables.id)}`);
      const events = await api.request("GET", `/v1/runs/${pathPart(variables.id)}/events`, {
        query: { tail: 100 },
      });
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify({ run, events }, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "facility-status",
    {
      description:
        "Build an org-wide Facility status brief from projects, inbox, issues, budgets, and spend.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Summarize Facility org health: live runs, open HITL items, issues, budgets, and spend. Use facility_* read tools and cite concerning changes first.",
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "facility-run-triage",
    {
      description: "Walk through diagnosis for a stuck or failing Facility run.",
      argsSchema: {
        runId: z.string().min(1).optional().describe("Run id to triage, when already known."),
      },
    },
    async ({ runId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Triage ${runId ? `Facility run ${runId}` : "a Facility run"}: fetch the run, inspect recent events, check related inbox proposals and issues, then recommend the next safe operator action.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "facility-cost-review",
    { description: "Review Facility spend and budget pressure for operators." },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Review Facility spend by project/model/agent, compare against budgets, and call out hard-stop risk or abnormal cost movement.",
          },
        },
      ],
    }),
  );

  return server;
}

async function dispatchTool(tool: ToolDefinition, args: Args, api: ApiClient): Promise<unknown> {
  if (tool.name === "facility_get_run") {
    const runId = str(args.runId) ?? "";
    const run: Run = await api.request("GET", `/v1/runs/${pathPart(runId)}`);
    const eventCount = Math.min(Number(args.lastEvents ?? 50), 200);
    const events: RunEvent[] = eventCount
      ? await api.request("GET", `/v1/runs/${pathPart(runId)}/events`, {
          query: { tail: eventCount },
        })
      : [];
    return { ...run, events };
  }
  if (!tool.request) throw new Error(`Direct dispatch is not configured for ${tool.name}`);
  const request = await tool.request(args);
  return (api as ApiClientLike).request(request.method, request.path, {
    query: request.query,
    body: request.body,
    ...(request.responseType ? { responseType: request.responseType } : {}),
  });
}

async function proposeWrite(
  tool: ToolDefinition,
  args: Args,
  api: ApiClient,
  requestId: string,
): Promise<unknown> {
  const cleanArgs = omit(args, ["confirm_token"]);
  const summary = tool.summarize?.(cleanArgs) ?? `Run ${tool.name}.`;
  const proposal = await api.request("POST", "/v1/mcp/tool-proposals", {
    idempotencyKey: `mcp_${createHash("sha256")
      .update(`${tool.name}:${requestId}:${stableJson(cleanArgs)}`)
      .digest("hex")}`,
    body: {
      toolName: tool.name,
      permission: tool.permission,
      args: cleanArgs,
      summary,
      projectId: str(cleanArgs.projectId),
      runId: str(cleanArgs.runId),
    } satisfies McpToolProposalRequest,
  });
  return {
    pending_human_approval: true,
    proposal_id: proposal.id,
    inbox: proposal.id ? `/v1/proposals/${pathPart(proposal.id)}` : "/v1/inbox",
    summary,
    message:
      "Pending human approval. A different principal with hitl:decide must approve this proposal from the HITL inbox; the MCP caller cannot complete it alone.",
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { data: value },
  };
}

function errorResult(error: unknown): CallToolResult {
  const payload =
    error instanceof FacilityApiError
      ? {
          code: error.code ?? `http_${error.status}`,
          message: error.message,
          status: error.status,
          ...(error.details === undefined ? {} : { details: error.details }),
        }
      : {
          code: "tool_failed",
          message: error instanceof Error ? error.message : "Facility tool failed",
        };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: payload }, null, 2) }],
    structuredContent: { error: payload },
  };
}

function humanizeToolName(name: string) {
  return name
    .replace(/^facility_/, "")
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pathPart(value: unknown): string {
  return encodeURIComponent(str(value) ?? "");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function omit(record: Args, keys: string[]): Args {
  const blocked = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !blocked.has(key)));
}
