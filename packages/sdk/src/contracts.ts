import type { paths as OpenApiPaths } from "./schema.js";

type SegmentMatches<Actual extends string, Spec extends string> = Spec extends `{${string}}`
  ? Actual extends ""
    ? false
    : true
  : Actual extends Spec
    ? true
    : false;

type PathMatches<
  Actual extends string,
  Spec extends string,
> = Actual extends `${infer ActualHead}/${infer ActualTail}`
  ? Spec extends `${infer SpecHead}/${infer SpecTail}`
    ? SegmentMatches<ActualHead, SpecHead> extends true
      ? PathMatches<ActualTail, SpecTail>
      : false
    : false
  : Spec extends `${string}/${string}`
    ? false
    : SegmentMatches<Actual, Spec>;

type ExpandOpenApiPath<Path extends string> = Path extends `${infer Head}{${string}}${infer Tail}`
  ? `${Head}${string}${ExpandOpenApiPath<Tail>}`
  : Path;

export type FacilityOpenApiPath<Path extends string> = {
  [Spec in Extract<keyof OpenApiPaths, string>]: PathMatches<Path, Spec> extends true
    ? Spec
    : never;
}[Extract<keyof OpenApiPaths, string>];

type OpenApiOperation<Method extends string, Path extends string> = {
  [Spec in FacilityOpenApiPath<Path>]: Lowercase<Method> extends keyof OpenApiPaths[Spec]
    ? NonNullable<OpenApiPaths[Spec][Lowercase<Method> & keyof OpenApiPaths[Spec]]>
    : never;
}[FacilityOpenApiPath<Path>];

type JsonContent<Value> = Value extends {
  content: { "application/json": infer Payload };
}
  ? Payload
  : Value extends { content?: never }
    ? undefined
    : unknown;

type SuccessfulResponse<Responses> = Responses extends { 200: infer Success }
  ? Success
  : Responses extends { 201: infer Success }
    ? Success
    : Responses extends { 202: infer Success }
      ? Success
      : Responses extends { 204: infer Success }
        ? Success
        : never;

export type FacilityGeneratedResponse<Method extends string, Path extends string> =
  OpenApiOperation<Method, Path> extends { responses: infer Responses }
    ? JsonContent<SuccessfulResponse<Responses>>
    : never;

export type FacilityGeneratedBody<Method extends string, Path extends string> =
  OpenApiOperation<Method, Path> extends {
    requestBody: { content: { "application/json": infer Body } };
  }
    ? Body
    : undefined;

export type FacilityGeneratedQuery<Method extends string, Path extends string> =
  OpenApiOperation<Method, Path> extends { parameters: { query?: infer Query } }
    ? NonNullable<Query>
    : never;

type ArrayItem<Value> = Value extends readonly (infer Item)[] ? Item : never;

export type FacilityRouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type FacilityRoutePath<Method extends FacilityRouteMethod> = {
  [Spec in Extract<keyof OpenApiPaths, string>]: Lowercase<Method> extends keyof OpenApiPaths[Spec]
    ? ExpandOpenApiPath<Spec>
    : never;
}[Extract<keyof OpenApiPaths, string>];

export type FacilityRouteResponse<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
> = FacilityGeneratedResponse<Method, Path>;

export type FacilityRouteBody<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
> =
  FacilityGeneratedBody<Method, Path> extends undefined
    ? never
    : FacilityGeneratedBody<Method, Path>;

/** Compatibility aliases retained for existing SDK consumers. */
export type FacilityGetRoutePath = FacilityRoutePath<"GET">;
export type FacilityGetRouteResponse<Path extends FacilityGetRoutePath> = FacilityRouteResponse<
  "GET",
  Path
>;

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Record<string, QueryValue>;
export type PageQuery = Pick<FacilityGeneratedQuery<"GET", "/v1/projects">, "limit" | "offset">;

export type Me = FacilityGeneratedResponse<"GET", "/v1/me">;
export type Principal = Me["principal"];
export type Org = NonNullable<FacilityGeneratedResponse<"GET", "/v1/org">>;
export type Project = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}">;
export type ProjectStatus = Project["status"];
export type ProjectRepo = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/repos">
>;

export type Run = FacilityGeneratedResponse<"GET", "/v1/runs/{runId}">;
export type RunStatus = Run["status"];
export type RunReceipt = NonNullable<Run["receipt"]>;
export type RunGithubArtifacts = Run["gh"];
export type RunWithProject = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/runs">>;
export type RunEvent = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/runs/{runId}/events">>;
export type RunDelivery = FacilityGeneratedResponse<"GET", "/v1/runs/{runId}/delivery">;
/** The transcript endpoint returns raw application/x-ndjson text. */
export type RunTranscript = string;

export type Conversation = FacilityGeneratedResponse<
  "POST",
  "/v1/projects/{projectId}/conversations"
>;
export type ConversationStatus = Conversation["status"];
export type ConversationListItem = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/conversations">
>;
export type ConversationDetail = FacilityGeneratedResponse<
  "GET",
  "/v1/conversations/{conversationId}"
>;
export type ConversationMessage = ArrayItem<ConversationDetail["messages"]>;
export type ConversationMessageRole = ConversationMessage["role"];
export type CreateConversationMessageResponse = FacilityGeneratedResponse<
  "POST",
  "/v1/conversations/{conversationId}/messages"
>;

export type Proposal = FacilityGeneratedResponse<"POST", "/v1/proposals">;
export type ProposalState = Proposal["state"];
export type ProposalWithEvents = FacilityGeneratedResponse<"GET", "/v1/proposals/{proposalId}">;
export type ProposalDecision = ArrayItem<ProposalWithEvents["events"]>;
export type ActionType = FacilityGeneratedResponse<"GET", "/v1/action-types/{actionTypeId}">;

export type Budget = FacilityGeneratedResponse<"GET", "/v1/budgets/{budgetId}">;
export type RegistryItem = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/registry/items">>;
export type RegistryItemWithVersions = FacilityGeneratedResponse<
  "GET",
  "/v1/registry/items/{itemId}"
>;
export type RegistryVersion = ArrayItem<RegistryItemWithVersions["versions"]>;

export type MemberRow = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/members">>;
/** User-facing roster projection; writes still return the raw membership row. */
export type Member = {
  userId: string;
  email: string;
  name: string | null;
  roleId: string;
  roleName: string;
};
export type Role = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/roles">>;
export type ApiKey = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/keys">>;
export type CreatedApiKey = FacilityGeneratedResponse<"POST", "/v1/keys">;
export type Provider = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/providers">>;

export type AgentDef = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/agents">
>;
export type AgentStatus = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/agents/status">
>;
export type SandboxProfile = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/sandbox-profiles">>;
export type Task = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/tasks">>;
export type VirtualKey = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/virtual-keys">
>;
export type CreatedVirtualKey = FacilityGeneratedResponse<
  "POST",
  "/v1/projects/{projectId}/virtual-keys"
>;
export type KbSpace = NonNullable<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/kb/space">
>;
export type KbEntry = FacilityGeneratedResponse<"GET", "/v1/kb/entries/{entryId}">;

export type Catalog = FacilityGeneratedResponse<"GET", "/v1/catalog">;
export type CatalogEngine = ArrayItem<Catalog["engines"]>;
export type CatalogModel = ArrayItem<Catalog["models"]>;
export type CatalogTriggerType = ArrayItem<Catalog["triggerTypes"]>;

export type Integration = FacilityGeneratedResponse<"GET", "/v1/integrations/{integrationId}">;
export type IntegrationSecretResult = FacilityGeneratedResponse<"POST", "/v1/integrations">;
export type IntegrationEvent = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/integrations/{integrationId}/events">
>;
export type WebhookDelivery = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/integrations/{integrationId}/deliveries">
>;

export type AuditTail = FacilityGeneratedResponse<"GET", "/v1/audit">;
export type AuditEvent = ArrayItem<AuditTail["items"]>;
export type AuditQuery = FacilityGeneratedQuery<"GET", "/v1/audit">;
export type AuditActor = AuditEvent["actor"];
export type AuditTarget = AuditEvent["target"];
export type SpendRow = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/spend">>;
export type LlmRequestPage = FacilityGeneratedResponse<"GET", "/v1/llm-requests">;
export type LlmRequest = ArrayItem<LlmRequestPage["items"]>;
export type LlmRequestQuery = FacilityGeneratedQuery<"GET", "/v1/llm-requests">;
export type LlmRequestEnvelope = FacilityGeneratedResponse<
  "GET",
  "/v1/llm-requests/{requestId}/envelope"
>;

export type Issue = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/issues">>;
export type IssueState = Issue["state"];
export type IssueSeverity = Issue["severity"];
export type GithubIssuePage = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/issues">;
export type GithubIssue = ArrayItem<GithubIssuePage["items"]>;
export type GithubIssueDetail = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/issues/{number}"
>;
export type GithubIssueLinkedRun = ArrayItem<GithubIssue["linkedRuns"]>;
export type Pipeline = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/pipeline">;
export type PipelineStage = ArrayItem<Pipeline["stages"]>;
export type PipelineStageKey = PipelineStage["key"];
export type PipelineStageKind = PipelineStage["kind"];
export type PipelineStory = ArrayItem<PipelineStage["stories"]>;
export type PipelineStageState = PipelineStory["stageState"];
export type PipelinePullRequest = ArrayItem<PipelineStory["prs"]>;
export type StoryDetail = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/stories/{number}"
>;
export type StoryGithubActivity = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/stories/{number}/github-activity"
>;
export type GithubInstallation = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/github/installations">
>;
export type GithubInstallationReposResponse = FacilityGeneratedResponse<
  "GET",
  "/v1/github/installations/{installationId}/repos"
>;
export type GithubInstallationRepo = ArrayItem<GithubInstallationReposResponse["items"]>;
export type Outcome = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/outcomes">>;

export type AnalyticsRow = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/analytics">>;
export type AnalyticsOverview = FacilityGeneratedResponse<"GET", "/v1/analytics/overview">;
export type InboxResponse = FacilityGeneratedResponse<"GET", "/v1/inbox">;
export type DoctorResponse = FacilityGeneratedResponse<"GET", "/v1/admin/doctor">;
export type DoctorCheck = ArrayItem<DoctorResponse["checks"]>;

export type CreateProjectRequest = FacilityGeneratedBody<"POST", "/v1/projects">;
export type UpdateProjectRequest = FacilityGeneratedBody<"PATCH", "/v1/projects/{projectId}">;
export type ConnectProjectRepoRequest = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/repos"
>;
export type TriggerRunRequest = FacilityGeneratedBody<"POST", "/v1/projects/{projectId}/runs">;
export type SteerRunRequest = FacilityGeneratedBody<"POST", "/v1/runs/{runId}/steer">;
export type ResumeRunRequest = FacilityGeneratedBody<"POST", "/v1/runs/{runId}/resume">;
export type CreateConversationRequest = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/conversations"
>;
export type CreateConversationMessageRequest = FacilityGeneratedBody<
  "POST",
  "/v1/conversations/{conversationId}/messages"
>;
export type CreateProposalRequest = FacilityGeneratedBody<"POST", "/v1/proposals">;
export type DecideProposalRequest = FacilityGeneratedBody<
  "POST",
  "/v1/proposals/{proposalId}/decide"
>;
export type ProposalReviewContext = FacilityGeneratedResponse<
  "POST",
  "/v1/proposals/{proposalId}/review-context"
>;
export type McpToolProposalRequest = FacilityGeneratedBody<"POST", "/v1/mcp/tool-proposals">;
export type CreateBudgetRequest = FacilityGeneratedBody<"POST", "/v1/budgets">;
export type UpdateBudgetRequest = FacilityGeneratedBody<"PATCH", "/v1/budgets/{budgetId}">;
export type CreateRegistryItemRequest = FacilityGeneratedBody<"POST", "/v1/registry/items">;
export type CreateRegistryVersionRequest = FacilityGeneratedBody<
  "POST",
  "/v1/registry/items/{itemId}/versions"
>;
export type AddMemberRequest = FacilityGeneratedBody<"POST", "/v1/members">;
export type UpdateMemberRequest = FacilityGeneratedBody<"PATCH", "/v1/members/{userId}">;
export type CreateRoleRequest = FacilityGeneratedBody<"POST", "/v1/roles">;
export type UpdateRoleRequest = FacilityGeneratedBody<"PATCH", "/v1/roles/{roleId}">;
export type CreateApiKeyRequest = FacilityGeneratedBody<"POST", "/v1/keys">;
export type CreateProviderRequest = FacilityGeneratedBody<"POST", "/v1/providers">;
export type CreateAgentRequest = FacilityGeneratedBody<"POST", "/v1/projects/{projectId}/agents">;
export type UpdateAgentRequest = FacilityGeneratedBody<
  "PATCH",
  "/v1/projects/{projectId}/agents/{id}"
>;
export type CreateSandboxProfileRequest = FacilityGeneratedBody<"POST", "/v1/sandbox-profiles">;
export type UpdateSandboxProfileRequest = FacilityGeneratedBody<
  "PATCH",
  "/v1/sandbox-profiles/{id}"
>;
export type CreateTaskRequest = FacilityGeneratedBody<"POST", "/v1/projects/{projectId}/tasks">;
export type UpdateTaskRequest = FacilityGeneratedBody<
  "PATCH",
  "/v1/projects/{projectId}/tasks/{taskId}"
>;
export type CreateVirtualKeyRequest = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/virtual-keys"
>;
export type UpsertKbSpaceRequest = FacilityGeneratedBody<
  "PUT",
  "/v1/projects/{projectId}/kb/space"
>;
export type CreateKbEntryRequest = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/kb/entries"
>;
export type UpdateKbEntryRequest = FacilityGeneratedBody<"PATCH", "/v1/kb/entries/{entryId}">;
export type CreateIntegrationRequest = FacilityGeneratedBody<"POST", "/v1/integrations">;
export type UpdateIntegrationRequest = FacilityGeneratedBody<
  "PATCH",
  "/v1/integrations/{integrationId}"
>;

export type KickstartPreview = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/kickstart/preview"
>;
export type KickstartResult = FacilityGeneratedResponse<
  "POST",
  "/v1/projects/{projectId}/kickstart"
>;
export type KickstartAnswers = NonNullable<
  FacilityGeneratedBody<"POST", "/v1/projects/{projectId}/kickstart">
>["answers"];
