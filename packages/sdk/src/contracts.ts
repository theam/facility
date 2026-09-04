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
export type WorkspaceStory = {
  id: string;
  provider: "github" | "manual" | "schedule";
  externalId: string;
  title: string;
  status: "ready" | "working" | "attention" | "review" | "done" | "archived";
  activeAgentName: string | null;
  branch: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
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
export type WorkspaceStoryBundle = {
  story: WorkspaceStory;
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
  events: Array<{
    turn_id: string;
    seq: number;
    type: string;
    data: Record<string, unknown>;
    created_at: string;
  }>;
  timeline: Array<{
    id: string;
    source: "facility" | "workspace" | "github" | "agent" | "artifact";
    type: string;
    turn_id: string | null;
    data: Record<string, unknown>;
    occurred_at: string;
    observed_at: string;
  }>;
  status: WorkspaceStory["status"];
  needs_attention: boolean;
  next_operations: string[];
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
export type ProjectPipeline = FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/pipeline">;
export type PipelineItem = ArrayItem<ProjectPipeline["stages"]["backlog"]>;
export type PipelinePullRequest = ArrayItem<PipelineItem["pullRequests"]>;
