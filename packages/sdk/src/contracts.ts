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

type MatchingOpenApiPaths<Path extends string> = {
  [Spec in Extract<keyof OpenApiPaths, string>]: PathMatches<Path, Spec> extends true
    ? Spec
    : never;
}[Extract<keyof OpenApiPaths, string>];

type ParameterCount<
  Path extends string,
  Count extends unknown[] = [],
> = Path extends `${infer Head}/${infer Tail}`
  ? ParameterCount<Tail, Head extends `{${string}}` ? [...Count, unknown] : Count>
  : Path extends `{${string}}`
    ? [...Count, unknown]["length"]
    : Count["length"];

type PathsWithParameterCount<Matches extends string, Count extends number> = Matches extends string
  ? ParameterCount<Matches> extends Count
    ? Matches
    : never
  : never;

// Counting avoids comparing every route pair when the generic client accepts
// the full route union. A matching literal has fewer parameters than /{id}.
type MostSpecificPaths<Matches extends string, Count extends unknown[] = []> = [Matches] extends [
  never,
]
  ? never
  : Count["length"] extends 8
    ? Matches
    : [PathsWithParameterCount<Matches, Count["length"]>] extends [never]
      ? MostSpecificPaths<Matches, [...Count, unknown]>
      : PathsWithParameterCount<Matches, Count["length"]>;

/** A literal endpoint such as /options takes precedence over /{consultationId}. */
export type FacilityOpenApiPath<Path extends string> = Path extends keyof OpenApiPaths
  ? Path
  : MostSpecificPaths<MatchingOpenApiPaths<Path>>;

type OpenApiOperation<Method extends string, Path extends string> = {
  [Spec in FacilityOpenApiPath<Path>]: Lowercase<Method> extends keyof OpenApiPaths[Spec]
    ? NonNullable<OpenApiPaths[Spec][Lowercase<Method> & keyof OpenApiPaths[Spec]]>
    : never;
}[FacilityOpenApiPath<Path>];

type JsonContent<Value> = Value extends { content: { "application/json": infer Payload } }
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
    : unknown;

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

export type FacilityRouteMethod = "GET" | "POST" | "PATCH" | "DELETE";
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

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Record<string, QueryValue>;
export type PageQuery = { limit?: number; offset?: number };

export type Me = FacilityGeneratedResponse<"GET", "/v1/me">;
export type Principal = Me["principal"];
export type Org = FacilityGeneratedResponse<"GET", "/v1/org">;
export type Project = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}">;
export type ProjectRepo = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/repos">
>;
export type MemberRow = ArrayItem<FacilityGeneratedResponse<"GET", "/v1/members">>;
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
export type GithubInstallation = ArrayItem<
  FacilityGeneratedResponse<"GET", "/v1/github/installations">
>;
export type GithubInstallationReposResponse = FacilityGeneratedResponse<
  "GET",
  "/v1/github/installations/{installationId}/repos"
>;
export type GithubInstallationRepo = ArrayItem<GithubInstallationReposResponse["items"]>;

export type CreateProjectRequest = FacilityGeneratedBody<"POST", "/v1/projects">;
export type UpdateProjectRequest = FacilityGeneratedBody<"PATCH", "/v1/projects/{projectId}">;
export type ConnectProjectRepoRequest = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/repos"
>;
export type AddMemberRequest = FacilityGeneratedBody<"POST", "/v1/members">;
export type UpdateMemberRequest = FacilityGeneratedBody<"PATCH", "/v1/members/{userId}">;
export type CreateRoleRequest = FacilityGeneratedBody<"POST", "/v1/roles">;
export type UpdateRoleRequest = FacilityGeneratedBody<"PATCH", "/v1/roles/{roleId}">;
export type CreateApiKeyRequest = FacilityGeneratedBody<"POST", "/v1/keys">;
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

export type StoryAgent = {
  name: string;
  description: string;
  engine: "claude_code" | "codex";
  model: string;
  enabled: boolean;
  options: {
    reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  };
  triggers: Array<
    Record<string, unknown> & { type: "manual" | "mcp" | "ui" | "github" | "schedule" }
  >;
  file: string;
  prompt: string;
  hash: string;
  commit_sha: string;
  synced_at: string;
  schedule_status: {
    schedules: Array<{
      name: string;
      cron: string;
      timezone: string;
      enabled: boolean;
      next_run_at: string;
      last_scheduled_at: string | null;
    }>;
    last_result: { state: string; at: string; error: string | null } | null;
  };
};
export type ProjectSkill = {
  name: string;
  description: string;
  path: string;
  directory: ".agents" | ".claude";
  hash: string;
  commit_sha: string;
  synced_at: string;
};
export type StoryTitleSource =
  | "user"
  | "github"
  | "schedule"
  | "pending"
  | "generated"
  | "fallback";
export type StoryAssignee = {
  kind: "user" | "github";
  subject: string;
  source: "facility" | "github";
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
};
export type WorkspaceStory = {
  id: string;
  provider: "github" | "manual" | "schedule";
  externalId: string;
  title: string;
  titleSource: StoryTitleSource;
  status: "ready" | "working" | "attention" | "review" | "done" | "archived";
  activeAgentName: string | null;
  branch: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  assignees?: StoryAssignee[];
};
export type StoryWorkspace = {
  id: string;
  provider: "docker" | "vercel" | "fake";
  state: "creating" | "running" | "sleeping" | "error" | "deleting" | "destroyed";
  volumeRef: string;
  setupChecksum: string | null;
  environment: {
    image?: string;
    ports?: Array<{
      service: string;
      port: number;
      protocol?: "http" | "https";
      websocket?: boolean;
    }>;
    resources?: { cpu: number; memoryMb: number };
  };
  endpoints: Array<{ service: string; port: number; protocol?: string; url: string }>;
  error: string | null;
  lastActivityAt: string;
  destroyedAt: string | null;
};
export type StoryDelivery = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/delivery"
>;
export type ReplaceStoryDelivery = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/delivery"
>;
export type StoryPreviewConvergence = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/preview-convergence"
>;
export type StoryCompletion = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/completion"
>;
export type DeliveryIntegrationPolicy = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/delivery-integration"
>;
export type DeliveryNoticePolicy = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/delivery-notices"
>;
export type StoryPlans = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/plan"
>;
export type StoryPlan = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/plan/revisions/{revision}"
>;
export type PlanDecisionReview = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/plan/decisions/{requestId}"
>;
export type StoryPlanRepositories = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/plan/repositories"
>;
export type StoryConsultations = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/consultations"
>;
export type StoryConsultation = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/consultations/{consultationId}"
>;
export type StoryConsultationOptions = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/consultations/options"
>;
export type StoryConsultationHandoff = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/consultations/{consultationId}/handoff"
>;
export type RequestStoryConsultation = FacilityGeneratedBody<
  "POST",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/consultations"
>;
export type WorkspaceStoryBundle = {
  /** Absent on older servers; an absent register never means a complete PR set. */
  delivery?: StoryDelivery;
  /** Absent on older servers; null until a complete exact delivery generation is observed. */
  previewConvergence?: StoryPreviewConvergence | null;
  /** Absent on older servers. Review, merge, integration and retention remain separate. */
  completion?: StoryCompletion;
  /** Absent on older servers. Missing metadata never implies an approved plan. */
  plans?: StoryPlans;
  story: WorkspaceStory;
  assignees: StoryAssignee[];
  workspace: StoryWorkspace | null;
  conversation: { id: string; summary: string | null } | null;
  turns: Array<{
    id: string;
    agentName: string;
    engine: string;
    model: string;
    state: string;
    error: string | null;
    createdAt: string;
  }>;
  artifacts: Array<{ id: string; kind: string; label: string; uri: string }>;
  attention: Array<{
    id: string;
    turnId: string | null;
    kind: string;
    title: string;
    detail: string | null;
    status: "open" | "resolved";
    resolution: string | null;
    resolvedBy: { type?: string; id?: string } | null;
    resolvedAt: string | null;
    createdAt: string;
  }>;
  /** Recent turn events; omitted when the bundle is requested with `evidence=none`. */
  events?: Array<{
    turn_id: string;
    seq: number;
    type: string;
    data: Record<string, unknown>;
    created_at: string;
  }>;
  /** Composed recent timeline; omitted when the bundle is requested with `evidence=none`. */
  timeline?: Array<StoryTimelineEntry>;
  status: WorkspaceStory["status"];
  needs_attention: boolean;
  next_operations: string[];
};
export type StoryTimelineEntry = {
  id: string;
  source: "facility" | "workspace" | "github" | "agent" | "artifact";
  type: string;
  turn_id: string | null;
  data: Record<string, unknown>;
  occurred_at: string;
  observed_at: string;
};
export type StoryTimelinePage = {
  entries: StoryTimelineEntry[];
  has_more: boolean;
  next_cursor: string | null;
};
export type StoryMessageAuthor = {
  kind: "user" | "github" | "service" | "schedule" | "system" | "agent";
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};
export type StoryTurnSummary = {
  id: string;
  agentName: string;
  engine: string;
  model: string;
  state: "queued" | "running" | "succeeded" | "failed" | "canceled" | (string & {});
  error: string | null;
  triggerType: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};
export type StoryMessageContent = {
  /**
   * `final_response`: the agent's final response recorded separately from its
   * progress messages. `combined_transcript`: an older agent message recorded
   * before that separation existed; progress and response may be mixed and are
   * shown as stored. `text`: a human or system message.
   */
  kind: "final_response" | "combined_transcript" | "text";
  progressMessages: number | null;
  reportedModel: string | null;
};
export type StoryMessage = {
  id: string;
  seq: number;
  role: "user" | "agent" | "system";
  body: string;
  actor: { type?: string; id?: string } | null;
  turnId: string | null;
  requestedAgentName: string | null;
  createdAt: string;
  author: StoryMessageAuthor;
  turn: StoryTurnSummary | null;
  content: StoryMessageContent;
};
export type StoryConversationPage = {
  /** The contiguous page in the requested order. */
  messages: StoryMessage[];
  /**
   * Older messages that complete a run present on this page (newest-first
   * pages only). They appear again on the page that reaches them; merge by id.
   */
  related: StoryMessage[];
  has_more: boolean;
  /** Pass as `before` (newest-first pages) or `after` (oldest-first pages). */
  next_cursor: number | null;
};
export type StoryActivityItem = {
  seq: number;
  turn_id: string;
  type: string;
  kind:
    | "message"
    | "reasoning"
    | "tool"
    | "command"
    | "file_change"
    | "result"
    | "lifecycle"
    | "error"
    | "session"
    | "other";
  title: string;
  text: string | null;
  truncated: boolean;
  size_bytes: number;
  created_at: string;
};
export type StoryTurnActivityPage = {
  turn: StoryTurnSummary;
  items: StoryActivityItem[];
  has_more: boolean;
  next_cursor: number | null;
};
export type StoryTurnEvent = {
  turn_id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
};
export type StoryEnvironment = {
  workspace: StoryWorkspace;
  inspection: {
    state: StoryWorkspace["state"];
    computeRef?: string;
    volumeRef: string;
    endpoints: StoryWorkspace["endpoints"];
  };
  metrics: {
    create_time_ms: number | null;
    wake_time_ms: number | null;
    active_compute: boolean;
    retained_storage: boolean;
    provider_errors: number;
    usage: Record<string, unknown>;
    cost: {
      currency: string;
      active_compute_cents: number | null;
      retained_storage_cents: number | null;
      status: string;
    };
  };
  events: Array<{ seq: number; type: string; data: Record<string, unknown>; createdAt: string }>;
  next_cursor: number;
  has_more: boolean;
};

export type ProjectBudget = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/budget">;
export type ProjectObservability = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/observability"
>;
export type UsageSummary = ProjectObservability["usage"];
export type ProjectOverview = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/overview">;
export type OverviewActiveTurn = ArrayItem<ProjectOverview["activity"]["running"]>;
export type OverviewAttentionItem = ArrayItem<ProjectOverview["attention"]["items"]>;
export type OverviewReviewItem = ArrayItem<ProjectOverview["review"]["items"]>;
export type OverviewRecentTurn = ArrayItem<ProjectOverview["recent"]["items"]>;
export type OverviewBacklogStory = ArrayItem<ProjectOverview["backlog"]["ready"]>;
export type ProjectAttention = FacilityGeneratedResponse<
  "GET",
  "/v1/projects/{projectId}/attention"
>;
export type AttentionNotice = ArrayItem<ProjectAttention["items"]>;
export type AttentionQuery = FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/attention">;
export type ProjectBacklog = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/backlog">;
export type BacklogItem = ArrayItem<ProjectBacklog["items"]>;
export type BacklogPhase = BacklogItem["phase"];
export type BacklogPerson = ArrayItem<BacklogItem["assignees"]>;
export type BacklogQuery = FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/backlog">;

export type StoryWorkflowPolicyState = FacilityGeneratedResponse<
  "get",
  "/v1/projects/{projectId}/workflow-policy"
>;
export type WorkflowPolicyReview = FacilityGeneratedResponse<
  "post",
  "/v1/projects/{projectId}/workflow-policy/review"
>;
export type StoryWorkflowStatus = FacilityGeneratedResponse<
  "get",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/workflow"
>;
export type StoryDeliveryAcceptance = FacilityGeneratedResponse<
  "get",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/delivery-acceptance"
>;
export type DeliveryAcceptanceRequest = FacilityGeneratedResponse<
  "post",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/delivery-acceptance"
>;
export type DeliveryAcceptanceReview = FacilityGeneratedResponse<
  "get",
  "/v1/projects/{projectId}/workspace-stories/{storyId}/delivery-acceptance/{requestId}"
>;
