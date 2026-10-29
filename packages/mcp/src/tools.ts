import {
  DeliveryIntegrationPolicySchema,
  DeliveryNoticePolicySchema,
  ProposeStoryPlanBody,
  RecordDeliveryIntegrationBody,
  ReplaceStoryDeliveryBody,
  RequestConsultationBody,
  RequestDeliveryAcceptanceBody,
  RequestPlanDecisionBody,
  RequestStoryCompletionBody,
} from "@facility/core";
import { FacilityApiError, FacilityClient, type QueryParams } from "@facility/sdk";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
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
  .optional()
  .describe(
    "Agent name from the repository's .agents directory. Omit to use the project's default agent for MCP requests.",
  );

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
    name: "facility_list_skills",
    permission: "projects:read",
    description:
      "List repository-installed skills discovered under .agents/skills and .claude/skills. Needs projects:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/project-skills`,
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
      "Get a story's status, workspace, turns, branch, pull request, artifacts, attention, and ordered evidence timeline. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}`,
  },
  {
    name: "facility_get_delivery",
    permission: "projects:read",
    description:
      "Read the story's declared delivery PR set, exact observed heads, current or older CI/reviews and partial merges. Reads never start agents, refresh GitHub or wake workspaces. Needs projects:read.",
    inputSchema: {
      projectId,
      storyId,
      includeAvailable: z.boolean().default(false),
      q: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/delivery`,
    query: (args) => ({
      include_available: args.includeAvailable === true ? "true" : "false",
      q: stringValue(args.q),
      limit: Number(args.limit ?? 25),
      offset: Number(args.offset ?? 0),
    }),
  },
  {
    name: "facility_set_delivery",
    permission: "projects:write",
    description:
      "Replace a story's delivery PR links from its project's GitHub mirror. Read the current scope revision first; declare completeness explicitly and choose one required primary. With workspaces:execute, saving also authorizes automatic preview updates for this scope revision: the worker may fetch Git commits, change managed workspace code and rebuild/restart the application while retaining data. Without that permission, it only records delivery metadata. It does not accept work, merge PRs or run AI agents. Needs projects:write.",
    inputSchema: {
      projectId,
      storyId,
      expectedRevision: ReplaceStoryDeliveryBody.shape.expected_revision,
      declaredComplete: ReplaceStoryDeliveryBody.shape.declared_complete,
      pullRequests: ReplaceStoryDeliveryBody.shape.pull_requests,
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/delivery`,
    body: (args) =>
      ReplaceStoryDeliveryBody.parse({
        expected_revision: args.expectedRevision,
        declared_complete: args.declaredComplete,
        pull_requests: args.pullRequests,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_get_delivery_integration_policy",
    permission: "projects:read",
    description:
      "Read the project's post-merge integration policy. This does not merge pull requests, run an integration, or wake a workspace. Needs projects:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/delivery-integration`,
  },
  {
    name: "facility_set_delivery_integration_policy",
    permission: "projects:write",
    description:
      "Configure post-merge integration as none, a manual recorded result, or a fixed repository_dispatch to a repository already connected to this project. It never accepts a URL or command and never merges pull requests. Needs projects:write and repos:write.",
    inputSchema: {
      projectId,
      mode: DeliveryIntegrationPolicySchema.shape.mode,
      repository: z.string().min(3).max(240).nullable().default(null),
    },
    method: "PATCH",
    path: (args) => `/v1/projects/${part(args.projectId)}/delivery-integration`,
    body: (args) =>
      DeliveryIntegrationPolicySchema.parse({ mode: args.mode, repository: args.repository }),
    write: true,
  },
  {
    name: "facility_get_story_completion",
    permission: "projects:read",
    description:
      "Read the exact delivery candidate, post-merge integration, source issue, completion operation, compute suspension, retained storage, and next action as separate facts. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/completion`,
  },
  {
    name: "facility_get_delivery_notice_policy",
    permission: "projects:read",
    description:
      "Read whether this project shows actionable delivery notices in Facility. This is an in-app preference and does not configure external messages. Needs projects:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/delivery-notices`,
  },
  {
    name: "facility_set_delivery_notice_policy",
    permission: "projects:write",
    description:
      "Enable or disable actionable delivery notices in Facility's in-app inbox. It never sends Slack, email, or other external messages. Needs projects:write.",
    inputSchema: { projectId, inApp: DeliveryNoticePolicySchema.shape.in_app },
    method: "PATCH",
    path: (args) => `/v1/projects/${part(args.projectId)}/delivery-notices`,
    body: (args) => DeliveryNoticePolicySchema.parse({ in_app: args.inApp }),
    write: true,
  },
  {
    name: "facility_record_delivery_integration",
    permission: "stories:write",
    description:
      "Record a succeeded or failed post-merge integration result for the exact current candidate. Repository dispatch callbacks must provide the exact eventId from the dispatched payload. A result cannot be carried to a different candidate or event and this action does not merge, deploy, close the source issue, or destroy storage. Needs stories:write.",
    inputSchema: {
      projectId,
      storyId,
      candidateRevision: RecordDeliveryIntegrationBody.shape.candidate_revision,
      eventId: RecordDeliveryIntegrationBody.shape.event_id,
      state: RecordDeliveryIntegrationBody.shape.state,
      summary: RecordDeliveryIntegrationBody.shape.summary,
      evidenceUrl: z.string().url().max(2_000).nullable().default(null),
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/integration-result`,
    body: (args) =>
      RecordDeliveryIntegrationBody.parse({
        candidate_revision: args.candidateRevision,
        event_id: args.eventId,
        state: args.state,
        summary: args.summary,
        evidence_url: args.evidenceUrl,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
  },
  {
    name: "facility_request_story_completion",
    permission: "projects:write",
    description:
      "Request durable completion of the exact source GitHub issue after every required PR is merged and the configured integration succeeds. This queues a retryable close and compute suspension; it never merges, archives, or deletes retained storage. Needs projects:write and github:write.",
    inputSchema: {
      projectId,
      storyId,
      candidateRevision: RequestStoryCompletionBody.shape.candidate_revision,
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/complete`,
    body: (args) =>
      RequestStoryCompletionBody.parse({
        candidate_revision: args.candidateRevision,
        confirm: true,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_get_preview_convergence",
    permission: "projects:read",
    description:
      "Read the story preview's desired exact PR generation, current state, latest attempt, deployed generation, last good generation, and retryable failure. This is database-only and never wakes or changes the workspace. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/preview-convergence`,
  },
  {
    name: "facility_retry_preview_convergence",
    permission: "workspaces:execute",
    description:
      "Retry a waiting, failed, or blocked preview convergence for the latest recorded delivery generation. The worker may fetch exact Git commits and rebuild the retained workspace; it never merges pull requests or starts an agent. Needs workspaces:execute.",
    inputSchema: { projectId, storyId, idempotencyKey },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/preview-convergence/retry`,
    body: (args) => ({ idempotency_key: args.idempotencyKey }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_get_workflow_policy",
    permission: "projects:read",
    description:
      "Read the current project plan/execution and delivery acceptance policy. Changes require an interactive Facility settings confirmation; this tool never changes policy. Needs projects:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/workflow-policy`,
  },
  {
    name: "facility_get_story_workflow",
    permission: "projects:read",
    description:
      "Read current plan approval, held native agents and exact delivery acceptance as separate states. Approval can release queued agents under project policy. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/workflow`,
  },
  {
    name: "facility_get_delivery_acceptance",
    permission: "projects:read",
    description:
      "Read current, missing or stale human acceptance of the exact required PR heads and plan/policy revisions. Needs projects:read.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/delivery-acceptance`,
  },
  {
    name: "facility_request_delivery_acceptance",
    permission: "projects:write",
    description:
      "Request an expiring interactive Facility review link for the current exact delivery. Read the candidate and workflow first. This tool cannot record a human acceptance or bypass plan/preview/completion policy. Needs projects:write.",
    inputSchema: {
      projectId,
      storyId,
      candidateRevision: RequestDeliveryAcceptanceBody.shape.expected_candidate_revision,
      expectedPlanRevision: RequestDeliveryAcceptanceBody.shape.expected_plan_revision,
      expectedDecisionRevision: RequestDeliveryAcceptanceBody.shape.expected_decision_revision,
      idempotencyKey,
    },
    method: "POST",
    write: true,
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/delivery-acceptance`,
    body: (args) =>
      RequestDeliveryAcceptanceBody.parse({
        expected_candidate_revision: args.candidateRevision,
        expected_plan_revision: args.expectedPlanRevision,
        expected_decision_revision: args.expectedDecisionRevision,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
  },
  {
    name: "facility_get_plan",
    permission: "projects:read",
    description:
      "Read the current immutable plan, exact repository/agent scope, decision receipts and paged history. Set revision to inspect an earlier plan. Database-only: no agent, GitHub refresh or workspace activity. Needs projects:read.",
    inputSchema: {
      projectId,
      storyId,
      revision: z.number().int().min(1).max(2_147_483_647).optional(),
      beforeRevision: z.number().int().min(1).max(2_147_483_647).optional(),
      beforeDecisionRevision: z.number().int().min(1).max(2_147_483_647).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/plan${args.revision === undefined ? "" : `/revisions/${part(args.revision)}`}`,
    query: (args) =>
      args.revision === undefined
        ? {
            before_revision: numberValue(args.beforeRevision),
            before_decision_revision: numberValue(args.beforeDecisionRevision),
            limit: Number(args.limit ?? 10),
          }
        : {},
  },
  {
    name: "facility_propose_plan",
    permission: "projects:write",
    description:
      "Record a plan revision with server-resolved repository names and configured agent snapshots. Read the current revision first. A source message must belong to this story and match the exact proposed text. Refreshes the authorized agent catalog; records metadata only and never starts execution. Needs projects:write.",
    inputSchema: {
      projectId,
      storyId,
      expectedRevision: ProposeStoryPlanBody.shape.expected_revision,
      markdown: ProposeStoryPlanBody.shape.markdown,
      repositories: ProposeStoryPlanBody.shape.repositories,
      agents: ProposeStoryPlanBody.shape.agents,
      sourceMessageId: ProposeStoryPlanBody.shape.source_message_id,
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/plan`,
    body: (args) =>
      ProposeStoryPlanBody.parse({
        expected_revision: args.expectedRevision,
        markdown: args.markdown,
        repositories: args.repositories,
        agents: args.agents,
        source_message_id: args.sourceMessageId,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_request_plan_decision",
    permission: "projects:write",
    description:
      "Request an approve/reject decision for the exact current plan and decision revision. Returns an expiring Facility review link for interactive confirmation. This tool records a request, never a human approval, and does not start execution. Rejection requires a reason. Needs projects:write.",
    inputSchema: {
      projectId,
      storyId,
      expectedRevision: RequestPlanDecisionBody.shape.expected_revision,
      expectedDecisionRevision: RequestPlanDecisionBody.shape.expected_decision_revision,
      intent: RequestPlanDecisionBody.shape.intent,
      reason: RequestPlanDecisionBody.shape.reason,
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/plan/decisions`,
    body: (args) =>
      RequestPlanDecisionBody.parse({
        expected_revision: args.expectedRevision,
        expected_decision_revision: args.expectedDecisionRevision,
        intent: args.intent,
        reason: args.reason,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
  },
  {
    name: "facility_get_consultation_options",
    permission: "workspaces:execute",
    description:
      "Read the configured agents' API-text consultation capability and exact repository revisions. Uses bounded GitHub reads, without inference or workspace activity. A compatible project provider API key is required; native CLI subscription login is not reused. Needs workspaces:execute.",
    inputSchema: { projectId, storyId },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/consultations/options`,
    openWorld: true,
  },
  {
    name: "facility_get_consultations",
    permission: "projects:read",
    description:
      "Read saved consultation history, immutable source metadata, results and billing status. Omit consultationId to page history, or include it for one result. Reading starts no inference or workspace activity; cost amounts require costs:read. Needs projects:read.",
    inputSchema: {
      projectId,
      storyId,
      consultationId: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/consultations${args.consultationId === undefined ? "" : `/${part(args.consultationId)}`}`,
    query: (args) =>
      args.consultationId === undefined
        ? { limit: Number(args.limit ?? 10), offset: Number(args.offset ?? 0) }
        : {},
  },
  {
    name: "facility_consult_story",
    permission: "workspaces:execute",
    description:
      "Request one charged text consultation using the selected configured agent model and exact source commits from consultation options. It has no tools, native session, shell or workspace access. Stores a separate durable request; never enqueues implementation. Reuse the same idempotency key for retries. Needs workspaces:execute.",
    inputSchema: {
      projectId,
      storyId,
      agent: RequestConsultationBody.shape.agent,
      expectedAgentHash: RequestConsultationBody.shape.expected_agent_hash,
      expectedCatalogSha: RequestConsultationBody.shape.expected_catalog_sha,
      message: RequestConsultationBody.shape.message,
      sources: RequestConsultationBody.shape.sources,
      idempotencyKey,
    },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/consultations`,
    body: (args) =>
      RequestConsultationBody.parse({
        agent: args.agent,
        expected_agent_hash: args.expectedAgentHash,
        expected_catalog_sha: args.expectedCatalogSha,
        message: args.message,
        sources: args.sources,
        idempotency_key: args.idempotencyKey,
      }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
  },
  {
    name: "facility_cancel_consultation",
    permission: "workspaces:execute",
    description:
      "Cancel a queued consultation or request cancellation of an active one. A submitted API request may already be billed; its durable accounting is retained. Does not cancel native implementation turns. Needs workspaces:execute.",
    inputSchema: { projectId, storyId, consultationId: z.string().min(1).max(200), idempotencyKey },
    method: "POST",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/consultations/${part(args.consultationId)}/cancel`,
    body: (args) => ({ idempotency_key: args.idempotencyKey }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
  },
  {
    name: "facility_prepare_consultation_handoff",
    permission: "projects:read",
    description:
      "Prepare draft implementation context from an exact completed consultation, including its result hash and provenance. Returns text only. Starting implementation requires a separate explicit authorized story message; this tool never approves a plan, accepts delivery or enqueues a native turn. Needs projects:read.",
    inputSchema: { projectId, storyId, consultationId: z.string().min(1).max(200) },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/consultations/${part(args.consultationId)}/handoff`,
  },
  {
    name: "facility_start_story",
    permission: "workspaces:execute",
    description:
      "Create or resume one persistent story workspace and queue its first agent turn directly. Omit the title to have Facility generate one from the message. Needs workspaces:execute.",
    inputSchema: {
      projectId,
      provider: z.enum(["github", "manual"]).default("manual"),
      externalId: z.string().min(1).max(240).optional(),
      repositoryId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Repository of a GitHub identity; defaults to the primary repository."),
      title: z.string().min(1).max(500).optional(),
      agent,
      message: z.string().min(1).max(200_000),
      idempotencyKey,
    },
    method: "POST",
    path: (args) => `/v1/projects/${part(args.projectId)}/workspace-stories`,
    body: (args) => ({
      provider: args.provider,
      external_id: args.externalId,
      repository_id: args.repositoryId,
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
    inputSchema: {
      projectId,
      storyId,
      after: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    },
    method: "GET",
    path: (args) =>
      `/v1/projects/${part(args.projectId)}/workspace-stories/${part(args.storyId)}/environment`,
    query: (args) => ({ after: numberValue(args.after), limit: Number(args.limit ?? 100) }),
  },
  {
    name: "facility_get_costs",
    permission: "costs:read",
    description:
      "Read token usage, attributed model cost, pricing status, and recent turn-level records for a project. Needs costs:read.",
    inputSchema: {
      projectId,
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/costs`,
    query: (args) => ({
      from: stringValue(args.from),
      to: stringValue(args.to),
      limit: Number(args.limit ?? 100),
    }),
  },
  {
    name: "facility_get_budget",
    permission: "budgets:read",
    description:
      "Read the project's monthly budget, current spend, remaining amount, and enforcement state. Needs budgets:read.",
    inputSchema: { projectId },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/budget`,
  },
  {
    name: "facility_set_budget",
    permission: "budgets:write",
    description:
      "Set the project monthly budget. Exhausted budgets block new turns. Starting a turn or title reserves a priced estimate against the limit until measured usage replaces it. Needs budgets:write.",
    inputSchema: {
      projectId,
      monthlyLimitCents: z.number().int().min(0),
      warningPercent: z.number().int().min(1).max(100).default(80),
      enabled: z.boolean().default(true),
      idempotencyKey,
    },
    method: "PATCH",
    path: (args) => `/v1/projects/${part(args.projectId)}/budget`,
    body: (args) => ({
      monthly_limit_cents: args.monthlyLimitCents,
      warning_percent: args.warningPercent,
      enabled: args.enabled,
    }),
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
  },
  {
    name: "facility_get_observability",
    permission: "analytics:read",
    description:
      "Read project health, turn outcomes, usage trends, budget state, workspace state, GitHub delivery health, and recent audit events. Needs analytics:read.",
    inputSchema: {
      projectId,
      days: z.number().int().min(1).max(365).default(30),
    },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/observability`,
    query: (args) => ({ days: Number(args.days ?? 30) }),
  },
  {
    name: "facility_list_backlog",
    permission: "projects:read",
    description:
      "Read the unified project backlog: mirrored GitHub issues not yet started, stories in progress, blocked, in review, done, or archived, each with its phase, agent activity, assignees, and links. Supports search, phase, label, assignee, and repository filters with pagination. Needs projects:read.",
    inputSchema: {
      projectId,
      q: z.string().max(200).optional().describe("Ticket number or words to search for."),
      phase: z
        .array(
          z.enum([
            "not_started",
            "in_progress",
            "attention",
            "review",
            "done",
            "archived",
            "open",
            "all",
          ]),
        )
        .optional()
        .describe("Phases to include; defaults to open (everything except done and archived)."),
      label: z.array(z.string().min(1).max(160)).optional(),
      assignee: z
        .array(z.string().min(1).max(200))
        .optional()
        .describe("unassigned, me, user:<id>, or github:<login>."),
      repository: z.array(z.string().min(1).max(200)).optional(),
      sort: z.enum(["priority", "updated", "created"]).default("priority"),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/backlog`,
    query: (args) => ({
      q: stringValue(args.q),
      phase: listValue(args.phase),
      label: listValue(args.label),
      assignee: listValue(args.assignee),
      repository: listValue(args.repository),
      sort: stringValue(args.sort),
      limit: Number(args.limit ?? 50),
      offset: Number(args.offset ?? 0),
    }),
  },
  {
    name: "facility_list_attention",
    permission: "projects:read",
    description:
      "Read what is waiting on a person in a project, newest first: agents waiting for a reply and failed, interrupted, or unstarted runs, each with its story and the action it accepts (reply, retry, dismiss). Resolved notices stay readable with how they were closed. Supports status, kind, and text filters with pagination. Needs projects:read.",
    inputSchema: {
      projectId,
      status: z
        .enum(["open", "resolved", "all"])
        .default("open")
        .describe("Open notices by default; resolved ones keep how they were closed."),
      kind: z
        .array(z.string().min(1).max(80))
        .max(20)
        .optional()
        .describe("Notice kinds such as agent_waiting, turn_error, or runtime_error."),
      q: z.string().max(200).optional().describe("Words in the notice or its story title."),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
    },
    method: "GET",
    path: (args) => `/v1/projects/${part(args.projectId)}/attention`,
    query: (args) => ({
      status: stringValue(args.status),
      kind: listValue(args.kind),
      q: stringValue(args.q),
      limit: Number(args.limit ?? 25),
      offset: Number(args.offset ?? 0),
    }),
  },
  {
    name: "facility_sync_github",
    permission: "github:write",
    description:
      "Reconcile the project's issue, pull-request, and CI mirror from GitHub after missed webhooks. Needs github:write.",
    inputSchema: { projectId, idempotencyKey },
    method: "POST",
    path: (args) => `/v1/projects/${part(args.projectId)}/github/sync`,
    idempotencyKey: (args) => stringValue(args.idempotencyKey),
    write: true,
    openWorld: true,
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
      headers: { "x-facility-surface": "mcp" },
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

/** Repeatable filters travel as one comma-separated query value; the API splits them again. */
function listValue(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((entry) => String(entry).trim()).filter(Boolean);
  return values.length > 0 ? values.join(",") : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
