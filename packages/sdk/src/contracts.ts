import type {
  agentDefs,
  apiKeys,
  auditEvents,
  budgets,
  llmRequests,
  orgMembers,
  orgs,
  outcomes,
  platformIssues,
  projects,
  proposalEvents,
  proposals,
  providerCredentials,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runs,
  sandboxProfiles,
  users,
} from "@facility/db";

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Record<string, QueryValue>;
export type RunReceipt = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
  };
} & JsonObject;
export type RunGithubArtifacts = {
  issue?: string;
  pr?: string;
} & JsonObject;

type Serialized<T> = T extends Date
  ? string
  : T extends Date | null
    ? string | null
    : T extends Array<infer U>
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

type ProjectRow = typeof projects.$inferSelect;
type ProjectRepoRow = typeof repos.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type ProposalDecisionRow = typeof proposalEvents.$inferSelect;
type BudgetRow = typeof budgets.$inferSelect;
type RegistryItemRow = typeof registryItems.$inferSelect;
type RegistryVersionRow = typeof registryVersions.$inferSelect;
type OrgMemberRow = typeof orgMembers.$inferSelect;
type UserRow = typeof users.$inferSelect;
type RoleRow = typeof roles.$inferSelect;
type ApiKeyRow = typeof apiKeys.$inferSelect;
type ProviderRow = typeof providerCredentials.$inferSelect;
type AuditEventRow = typeof auditEvents.$inferSelect;
type LlmRequestRow = typeof llmRequests.$inferSelect;
type OrgRow = typeof orgs.$inferSelect;
type AgentDefRow = typeof agentDefs.$inferSelect;
type SandboxProfileRow = typeof sandboxProfiles.$inferSelect;
type PlatformIssueRow = typeof platformIssues.$inferSelect;

export type ProjectStatus = "active" | "archived" | string;
export type RunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting_human"
  | "succeeded"
  | "failed"
  | "canceled"
  | string;
export type ProposalState =
  | "draft"
  | "open"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | string;

export type Org = Serialized<Omit<OrgRow, "settings">> & { settings: unknown };

export type Project = Serialized<Omit<ProjectRow, "settings" | "status">> & {
  settings: JsonObject;
  status: ProjectStatus;
};

export type ProjectRepo = Serialized<Omit<ProjectRepoRow, "fingerprint" | "renderAnswers">> & {
  fingerprint: unknown | null;
  renderAnswers: unknown | null;
};

export type Run = Serialized<
  Omit<RunRow, "trigger" | "sandbox" | "receipt" | "gh" | "createdBy" | "status">
> & {
  status: RunStatus;
  trigger: JsonObject;
  sandbox: JsonObject;
  receipt: RunReceipt | null;
  gh: RunGithubArtifacts;
  createdBy: unknown;
};

export type RunWithProject = Run & { project: Pick<Project, "id" | "name" | "slug"> };

export type RunEvent = Serialized<Omit<RunEventRow, "data">> & {
  data: JsonObject;
};

export type Proposal = Serialized<Omit<ProposalRow, "payload" | "state">> & {
  payload: JsonObject;
  state: ProposalState;
  actionType?: string;
};

export type ProposalDecision = Serialized<Omit<ProposalDecisionRow, "actor" | "data">> & {
  actor: unknown;
  data: unknown;
};

export type ProposalWithEvents = Proposal & { events: ProposalDecision[] };

export type Budget = Serialized<BudgetRow>;

export type RegistryItem = Serialized<RegistryItemRow>;
export type RegistryVersion = Serialized<RegistryVersionRow>;
export type RegistryItemWithVersions = RegistryItem & { versions: RegistryVersion[] };

export type Member = {
  userId: string;
  email: string;
  name?: string | null;
  roleId: string;
  roleName?: string;
};
export type MemberRow = {
  member: Serialized<OrgMemberRow>;
  user: Serialized<UserRow>;
  role: Role;
};

export type Role = Serialized<RoleRow>;

export type ApiKey = Serialized<Omit<ApiKeyRow, "hash">> & {
  secret?: string;
};

export type Provider = Serialized<
  Pick<ProviderRow, "id" | "provider" | "name" | "baseUrl" | "createdAt">
>;

export type AgentDef = Serialized<Omit<AgentDefRow, "model" | "triggers" | "permissions">> & {
  model: JsonObject;
  triggers: JsonObject[];
  permissions: string[];
};

export type SandboxProfile = Serialized<
  Omit<SandboxProfileRow, "setup" | "resources" | "network">
> & {
  setup: JsonObject;
  resources: JsonObject;
  network: JsonObject;
};

export type AuditActor = { type: string; id: string; name?: string };
export type AuditTarget = { type: string; id: string } | null;
export type AuditEvent = Serialized<Omit<AuditEventRow, "actor" | "target" | "payload">> & {
  actor: AuditActor;
  target: AuditTarget;
  payload: unknown;
};

export type SpendRow = { bucket: string; cost_cents: number };

export type LlmRequest = Serialized<LlmRequestRow>;

export type IssueState = "open" | "acked" | "resolved" | string;
export type IssueSeverity = "info" | "warn" | "error" | string;
export type Issue = Serialized<Omit<PlatformIssueRow, "state" | "severity">> & {
  state: IssueState;
  severity: IssueSeverity;
};

type OutcomeRow = typeof outcomes.$inferSelect;
/** PR-level fate row — written at PR-open (platform lane) and PR-close (webhook). */
export type Outcome = Serialized<OutcomeRow>;

export type GithubInstallation = {
  id: string;
  installationId: number;
  accountLogin: string;
  targetType: string;
  suspendedAt: string | null;
};

export type GithubInstallationRepo = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
};

export type GithubInstallationReposResponse = {
  items: GithubInstallationRepo[];
  truncated: boolean;
};

export type GithubIssueLinkedRun = Pick<Run, "id" | "mode" | "status" | "engine"> & {
  pr?: unknown;
};

export type GithubIssue = {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed" | string;
  labels: unknown;
  assignees: unknown;
  author: string | null;
  htmlUrl: string;
  commentsCount: number;
  ghUpdatedAt: string | null;
  linkedRuns: GithubIssueLinkedRun[];
};

export type GithubIssueDetail = GithubIssue & {
  bodyMd: string | null;
  runs: Array<
    Pick<Run, "id" | "mode" | "engine" | "status" | "startedAt" | "endedAt" | "receipt"> & {
      pr?: unknown;
    }
  >;
};

export type GithubIssuePage = { items: GithubIssue[]; nextCursor: string | null };

export type Principal = {
  type: "user" | "key";
  id: string;
  orgId: string;
  userId?: string;
  email?: string;
  name?: string;
  projectId?: string | null;
  permissions: string[];
};

export type Me = {
  principal: Principal;
  org: Org | null;
  permissions: string[];
};

export type CreateProjectRequest = {
  name: string;
  slug: string;
  description?: string;
  settings?: JsonObject;
};
export type UpdateProjectRequest = Partial<
  Pick<Project, "name" | "description" | "status"> & { settings: JsonObject }
>;
export type ConnectProjectRepoRequest = {
  owner: string;
  name: string;
  defaultBranch?: string;
  mode?: "connect" | "create";
  create?: boolean;
  private?: boolean;
  description?: string;
  autoInit?: boolean;
};

export type TriggerRunRequest = {
  mode?: string;
  engine?: string;
  trigger?: JsonObject;
  agentDefId?: string;
  agent?: string;
};
export type SteerRunRequest = { body: string };

export type CreateProposalRequest = {
  projectId?: string;
  runId?: string;
  actionTypeId: string;
  payload: JsonObject;
  contextMd: string;
  expiresAt?: string;
};
export type DecideProposalRequest = { decision: "approve" | "reject"; note?: string };
export type McpToolProposalRequest = {
  toolName: string;
  permission: string;
  args: JsonObject;
  summary: string;
  projectId?: string;
  runId?: string;
};

export type CreateBudgetRequest = {
  scope: string;
  projectId?: string;
  agentDefId?: string;
  period: string;
  limitCents: number;
  mode: string;
  enabled?: boolean;
};
export type UpdateBudgetRequest = Partial<CreateBudgetRequest>;

export type CreateRegistryItemRequest = {
  scope: string;
  projectId?: string;
  kind: string;
  name: string;
  description?: string;
  content: string;
};
export type CreateRegistryVersionRequest = { content: string; changelog?: string };

export type AddMemberRequest = { email: string; roleId: string };
export type UpdateMemberRequest = { roleId: string };
export type CreateRoleRequest = { name: string; description?: string; permissions: string[] };
export type UpdateRoleRequest = { description?: string; permissions?: string[] };
export type CreateApiKeyRequest = { name: string; roleId: string; projectId?: string };
export type CreateProviderRequest = {
  provider: string;
  name: string;
  baseUrl?: string;
  secret: string;
};

export type InboxResponse = {
  items: Proposal[];
  proposals: Proposal[];
  issues: Issue[];
};
export type AuditTail = { items: AuditEvent[]; nextCursor: number | null };
export type LlmRequestPage = { items: LlmRequest[]; nextCursor: string | null };
export type LlmRequestEnvelope = { llmRequest: LlmRequest; envelope: unknown };
export type DoctorCheck = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  ok: boolean;
  message: string;
  remediation?: string;
};
export type DoctorResponse = { ok: boolean; generatedAt: string; checks: DoctorCheck[] };

type Route<Response, Body = never> = { response: Response; body: Body };

export type FacilityGetRoutePath =
  | "/v1/me"
  | "/v1/org"
  | "/v1/projects"
  | `/v1/projects/${string}`
  | `/v1/projects/${string}/repos`
  | `/v1/projects/${string}/issues`
  | `/v1/projects/${string}/issues/${string}`
  | `/v1/projects/${string}/kickstart/preview`
  | `/v1/projects/${string}/agents`
  | `/v1/projects/${string}/runs`
  | "/v1/runs"
  | `/v1/runs/${string}`
  | `/v1/runs/${string}/events`
  | "/v1/inbox"
  | "/v1/issues"
  | "/v1/outcomes"
  | "/v1/github/installations"
  | `/v1/github/installations/${string}/repos`
  | `/v1/proposals/${string}`
  | "/v1/audit"
  | "/v1/audit/verify"
  | "/v1/admin/doctor"
  | "/v1/registry/items"
  | `/v1/registry/items/${string}`
  | "/v1/spend"
  | "/v1/members"
  | "/v1/roles"
  | "/v1/keys"
  | "/v1/providers"
  | "/v1/budgets"
  | `/v1/budgets/${string}`
  | "/v1/llm-requests"
  | `/v1/llm-requests/${string}/envelope`
  | "/v1/sandbox-profiles"
  | "/v1/analytics"
  | "/v1/analytics/overview"
  | `/v1/projects/${string}/health`
  | `/v1/projects/${string}/tasks`
  | `/v1/projects/${string}/virtual-keys`
  | `/v1/projects/${string}/kb/entries`
  | `/v1/projects/${string}/kb/space`
  | `/v1/kb/entries/${string}`;

// A bare `:id` route's `${string}` segment also admits `a/b`, so wrong nested
// paths (e.g. /v1/projects/x/not-a-route) wrongly resolve to the resource type.
// Require the captured id to contain no "/" — otherwise the response is `never`.
type IfLeaf<Id extends string, Then> = Id extends `${string}/${string}` ? never : Then;

export type FacilityGetRouteResponse<Path extends FacilityGetRoutePath> = Path extends "/v1/me"
  ? Me
  : Path extends "/v1/org"
    ? Org | null
    : Path extends "/v1/projects"
      ? Project[]
      : Path extends `/v1/projects/${string}/repos`
        ? ProjectRepo[]
        : Path extends `/v1/projects/${string}/issues`
          ? GithubIssuePage
          : Path extends `/v1/projects/${string}/issues/${string}`
            ? GithubIssueDetail
            : Path extends `/v1/projects/${string}/kickstart/preview`
              ? KickstartPreview
              : Path extends `/v1/projects/${string}/agents`
                ? AgentDef[]
                : Path extends `/v1/projects/${string}/runs`
                  ? Run[]
                  : Path extends `/v1/projects/${string}/health`
                    ? JsonObject
                    : Path extends `/v1/projects/${string}/tasks`
                      ? JsonObject[]
                      : Path extends `/v1/projects/${string}/virtual-keys`
                        ? JsonObject[]
                        : Path extends `/v1/projects/${string}/kb/entries`
                          ? JsonObject[]
                          : Path extends `/v1/projects/${string}/kb/space`
                            ? JsonObject
                            : Path extends `/v1/projects/${infer Id}`
                              ? IfLeaf<Id, Project>
                              : Path extends "/v1/runs"
                                ? RunWithProject[]
                                : Path extends `/v1/runs/${string}/events`
                                  ? RunEvent[]
                                  : Path extends `/v1/runs/${infer Id}`
                                    ? IfLeaf<Id, Run>
                                    : Path extends "/v1/inbox"
                                      ? InboxResponse
                                      : Path extends "/v1/issues"
                                        ? Issue[]
                                        : Path extends "/v1/outcomes"
                                          ? Outcome[]
                                          : Path extends "/v1/github/installations"
                                            ? GithubInstallation[]
                                            : Path extends `/v1/github/installations/${string}/repos`
                                              ? GithubInstallationReposResponse
                                              : Path extends `/v1/proposals/${infer Id}`
                                                ? IfLeaf<Id, ProposalWithEvents>
                                                : Path extends "/v1/audit"
                                                  ? AuditTail
                                                  : Path extends "/v1/audit/verify"
                                                    ? { ok: boolean; firstBreakSeq: number | null }
                                                    : Path extends "/v1/admin/doctor"
                                                      ? DoctorResponse
                                                      : Path extends "/v1/registry/items"
                                                        ? RegistryItem[]
                                                        : Path extends `/v1/registry/items/${infer Id}`
                                                          ? IfLeaf<Id, RegistryItemWithVersions>
                                                          : Path extends "/v1/spend"
                                                            ? SpendRow[]
                                                            : Path extends "/v1/members"
                                                              ? MemberRow[]
                                                              : Path extends "/v1/roles"
                                                                ? Role[]
                                                                : Path extends "/v1/keys"
                                                                  ? ApiKey[]
                                                                  : Path extends "/v1/providers"
                                                                    ? Provider[]
                                                                    : Path extends "/v1/budgets"
                                                                      ? Budget[]
                                                                      : Path extends `/v1/budgets/${infer Id}`
                                                                        ? IfLeaf<Id, Budget>
                                                                        : Path extends "/v1/llm-requests"
                                                                          ? LlmRequestPage
                                                                          : Path extends `/v1/llm-requests/${string}/envelope`
                                                                            ? LlmRequestEnvelope
                                                                            : Path extends "/v1/sandbox-profiles"
                                                                              ? SandboxProfile[]
                                                                              : // Non-core surfaces the API serves as permissive AnyObject; typed
                                                                                // here as JsonObject so clients can call them without a cast.
                                                                                Path extends "/v1/analytics"
                                                                                ? JsonObject[]
                                                                                : Path extends "/v1/analytics/overview"
                                                                                  ? JsonObject
                                                                                  : Path extends `/v1/kb/entries/${string}`
                                                                                    ? JsonObject
                                                                                    : never;

export type FacilityPostRoutes = {
  "/v1/projects": Route<Project, CreateProjectRequest>;
  [path: `/v1/projects/${string}/repos`]: {
    body: ConnectProjectRepoRequest;
    response: ProjectRepo;
  };
  [path: `/v1/projects/${string}/kickstart`]: Route<
    KickstartResult,
    { repoId: string; answers: KickstartAnswers; mode: "pr" }
  >;
  [path: `/v1/projects/${string}/upgrade`]: Route<
    JsonObject,
    { repoId: string; toVersion?: string }
  >;
  [path: `/v1/projects/${string}/runs`]: Route<Run, TriggerRunRequest>;
  [path: `/v1/projects/${string}/issues/sync`]: Route<{ queued: number }, undefined>;
  [path: `/v1/projects/${string}/issues/${string}/trigger`]: Route<Run, { agent: string }>;
  [path: `/v1/runs/${string}/cancel`]: Route<Run, undefined>;
  [path: `/v1/runs/${string}/steer`]: Route<unknown, SteerRunRequest>;
  "/v1/proposals": Route<Proposal, CreateProposalRequest>;
  "/v1/mcp/tool-proposals": Route<Proposal, McpToolProposalRequest>;
  [path: `/v1/proposals/${string}/decide`]: {
    body: DecideProposalRequest;
    response: Proposal;
  };
  [path: `/v1/issues/${string}/ack`]: Route<Issue, undefined>;
  [path: `/v1/issues/${string}/resolve`]: Route<Issue, undefined>;
  "/v1/budgets": Route<Budget, CreateBudgetRequest>;
  "/v1/registry/items": Route<RegistryItemWithVersions, CreateRegistryItemRequest>;
  [path: `/v1/registry/items/${string}/versions`]: {
    body: CreateRegistryVersionRequest;
    response: RegistryVersion;
  };
  [path: `/v1/registry/versions/${string}/publish`]: Route<RegistryVersion, undefined>;
  [path: `/v1/registry/versions/${string}/deprecate`]: {
    body: undefined;
    response: RegistryVersion;
  };
  "/v1/members": Route<Serialized<OrgMemberRow>, AddMemberRequest>;
  "/v1/roles": Route<Role, CreateRoleRequest>;
  "/v1/keys": Route<ApiKey, CreateApiKeyRequest>;
  "/v1/providers": Route<Provider | null, CreateProviderRequest>;
  // Non-core surfaces (KB / tasks / virtual keys / fingerprints / agents /
  // sandbox profiles). The API validates these as permissive AnyObject, so both
  // sides are JsonObject here — enough to call them typed without a cast.
  [path: `/v1/projects/${string}/agents`]: Route<JsonObject, JsonObject>;
  [path: `/v1/projects/${string}/kb/entries`]: Route<JsonObject, JsonObject>;
  [path: `/v1/projects/${string}/kb/validate`]: Route<JsonObject, JsonObject>;
  [path: `/v1/projects/${string}/tasks`]: Route<JsonObject, JsonObject>;
  [path: `/v1/projects/${string}/virtual-keys`]: Route<JsonObject, JsonObject>;
  [path: `/v1/proposals/${string}/execute`]: Route<JsonObject, undefined>;
  [path: `/v1/repos/${string}/fingerprints/adopt`]: Route<JsonObject, JsonObject>;
  [path: `/v1/repos/${string}/fingerprints/verify`]: Route<JsonObject, JsonObject>;
  [path: `/v1/runs/${string}/kb-checkpoint`]: Route<JsonObject, JsonObject>;
  [path: `/v1/tasks/${string}/propose`]: Route<JsonObject, JsonObject>;
  [path: `/v1/tasks/${string}/transition`]: Route<JsonObject, JsonObject>;
  "/v1/sandbox-profiles": Route<SandboxProfile, JsonObject>;
};

export type FacilityPatchRoutes = {
  [path: `/v1/projects/${string}`]: { body: UpdateProjectRequest; response: Project };
  [path: `/v1/budgets/${string}`]: { body: UpdateBudgetRequest; response: Budget };
  [path: `/v1/members/${string}`]: {
    body: UpdateMemberRequest;
    response: Serialized<OrgMemberRow>;
  };
  [path: `/v1/roles/${string}`]: { body: UpdateRoleRequest; response: Role };
  "/v1/org": Route<JsonObject, JsonObject>;
  [path: `/v1/kb/entries/${string}`]: Route<JsonObject, JsonObject>;
  [path: `/v1/sandbox-profiles/${string}`]: Route<JsonObject, JsonObject>;
};

export type FacilityPutRoutes = {
  [path: `/v1/projects/${string}/kb/space`]: Route<JsonObject, JsonObject>;
};

export type FacilityDeleteRoutes = {
  [path: `/v1/projects/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/budgets/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/members/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/roles/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/keys/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/providers/${string}`]: Route<{ ok: boolean }>;
  [path: `/v1/sandbox-profiles/${string}`]: Route<{ ok: boolean }>;
};

export type FacilityRouteMap = {
  GET: never;
  POST: FacilityPostRoutes;
  PATCH: FacilityPatchRoutes;
  PUT: FacilityPutRoutes;
  DELETE: FacilityDeleteRoutes;
};

export type FacilityRouteMethod = keyof FacilityRouteMap;
export type FacilityRoutePath<Method extends FacilityRouteMethod> = Method extends "GET"
  ? FacilityGetRoutePath
  : Extract<keyof FacilityRouteMap[Method], string>;

type FacilityRouteSpec<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
> = Method extends "POST"
  ? Path extends keyof FacilityPostRoutes
    ? FacilityPostRoutes[Path]
    : never
  : Method extends "PATCH"
    ? Path extends keyof FacilityPatchRoutes
      ? FacilityPatchRoutes[Path]
      : never
    : Method extends "PUT"
      ? Path extends keyof FacilityPutRoutes
        ? FacilityPutRoutes[Path]
        : never
      : Method extends "DELETE"
        ? Path extends keyof FacilityDeleteRoutes
          ? FacilityDeleteRoutes[Path]
          : never
        : never;

export type FacilityRouteResponse<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
> = Method extends "GET"
  ? Path extends FacilityGetRoutePath
    ? FacilityGetRouteResponse<Path>
    : never
  : // Extract the response regardless of whether the route carries a body — a
    // `Route<R, Body>` match against `Route<_, never>` would wrongly resolve
    // body-carrying write routes to `never`.
    FacilityRouteSpec<Method, Path> extends { response: infer Response }
    ? Response
    : never;

export type FacilityRouteBody<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
> = Method extends "GET"
  ? never
  : FacilityRouteSpec<Method, Path> extends Route<unknown, infer Body>
    ? Body
    : never;

export type KickstartAnswers = {
  defaultBranch?: string;
  provisionCmd?: string;
  checkCmds?: string[];
  modules?: string[];
  modelTier?: string;
  board?: { org: string; project: string | number } | null;
  execution_lane?: Record<string, "repo" | "platform">;
};

export type KickstartPreview = {
  detection?: JsonObject;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    mode?: string;
    action?: string;
  }>;
  skipped?: string[];
};

export type KickstartResult = {
  branch?: string;
  commitSha?: string;
  pr?: { number?: number; url?: string; html_url?: string; title?: string };
  files?: Array<{ path: string; content?: string; mode?: string }>;
  manifest?: JsonObject;
};
