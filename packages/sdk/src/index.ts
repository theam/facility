import type {
  ActionType,
  AddMemberRequest,
  AgentDef,
  AgentStatus,
  AnalyticsOverview,
  AnalyticsRow,
  ApiKey,
  AuditEvent,
  AuditQuery,
  AuditTail,
  Budget,
  Catalog,
  ConnectProjectRepoRequest,
  Conversation,
  ConversationDetail,
  ConversationListItem,
  CreateAgentRequest,
  CreateApiKeyRequest,
  CreateBudgetRequest,
  CreateConversationMessageRequest,
  CreateConversationMessageResponse,
  CreateConversationRequest,
  CreatedApiKey,
  CreatedVirtualKey,
  CreateIntegrationRequest,
  CreateKbEntryRequest,
  CreateProjectRequest,
  CreateProposalRequest,
  CreateProviderRequest,
  CreateRegistryItemRequest,
  CreateRegistryVersionRequest,
  CreateRoleRequest,
  CreateSandboxProfileRequest,
  CreateTaskRequest,
  CreateVirtualKeyRequest,
  DecideProposalRequest,
  DoctorResponse,
  FacilityGeneratedQuery,
  FacilityGeneratedResponse,
  FacilityRouteBody,
  FacilityRouteMethod,
  FacilityRoutePath,
  FacilityRouteResponse,
  GithubInstallation,
  GithubInstallationReposResponse,
  GithubIssueDetail,
  GithubIssuePage,
  InboxResponse,
  Integration,
  IntegrationEvent,
  IntegrationSecretResult,
  Issue,
  JsonObject,
  KbEntry,
  KbSpace,
  KickstartAnswers,
  KickstartPreview,
  KickstartResult,
  LlmRequest,
  LlmRequestEnvelope,
  LlmRequestPage,
  LlmRequestQuery,
  McpToolProposalRequest,
  Me,
  MemberRow,
  Org,
  Outcome,
  PageQuery,
  Pipeline,
  Project,
  ProjectRepo,
  Proposal,
  ProposalReviewContext,
  ProposalWithEvents,
  Provider,
  QueryParams,
  RegistryItem,
  RegistryItemWithVersions,
  RegistryVersion,
  ResumeRunRequest,
  Role,
  Run,
  RunDelivery,
  RunEvent,
  RunTranscript,
  RunWithProject,
  SandboxProfile,
  SpendRow,
  SteerRunRequest,
  StoryDetail,
  StoryGithubActivity,
  Task,
  TriggerRunRequest,
  UpdateAgentRequest,
  UpdateBudgetRequest,
  UpdateIntegrationRequest,
  UpdateKbEntryRequest,
  UpdateMemberRequest,
  UpdateProjectRequest,
  UpdateRoleRequest,
  UpdateSandboxProfileRequest,
  UpdateTaskRequest,
  UpsertKbSpaceRequest,
  VirtualKey,
  WebhookDelivery,
} from "./contracts.js";

export type * from "./contracts.js";
export { FACILITY_V1_ROUTES, type FacilityV1Route } from "./routes.js";
export type {
  components as FacilityOpenApiComponents,
  paths as FacilityOpenApiPaths,
} from "./schema.js";

type RouteOptions<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>> = {
  body?: FacilityRouteBody<Method, Path>;
  query?: FacilityGeneratedQuery<Method, Path>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  responseType?: "json" | "text";
};

export type FacilityWriteOptions = { idempotencyKey?: string; signal?: AbortSignal };
export type FacilityTriggerGithubIssueOptions = FacilityWriteOptions & {
  query?: FacilityGeneratedQuery<"POST", "/v1/projects/{projectId}/issues/{number}/trigger">;
};

export type FacilityClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
};

export type FacilityStreamEvent<Data = unknown> = { event: string; data: Data; id?: string };
export type FacilityStreamOptions = {
  query?: QueryParams;
  signal?: AbortSignal;
  reconnect?: boolean;
  retryMs?: number;
  maxRetryMs?: number;
  onError?: (error: unknown) => void;
};
export type FacilityEventStream = {
  signal: AbortSignal;
  close: () => void;
  done: Promise<void>;
};
export type FacilityRunStreamEvent = FacilityStreamEvent<RunEvent>;
export type FacilityRunStreamOptions = Omit<FacilityStreamOptions, "query"> & {
  afterSeq?: number;
};
export type FacilityPaginationOptions = {
  pageSize?: number;
  offset?: number;
  signal?: AbortSignal;
};
export type FacilityAuditIterationOptions = Omit<AuditQuery, "limit"> &
  Pick<FacilityPaginationOptions, "pageSize" | "signal">;
export type FacilityLlmRequestIterationOptions = Omit<LlmRequestQuery, "limit"> &
  Pick<FacilityPaginationOptions, "pageSize" | "signal">;

export class FacilityApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = "FacilityApiError";
  }
}

export class FacilityClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: FacilityClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs, 30_000, "timeoutMs");
    this.maxRetries = nonNegativeInteger(options.maxRetries, 2, "maxRetries");
    this.retryBaseMs = nonNegativeInteger(options.retryBaseMs, 250, "retryBaseMs");
  }

  request<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>>(
    method: Method,
    path: Path,
    options: RouteOptions<Method, Path> = {},
  ): Promise<FacilityRouteResponse<Method, Path>> {
    return this.send(method, path, options);
  }

  get<Path extends FacilityRoutePath<"GET">>(
    path: Path,
    query?: FacilityGeneratedQuery<"GET", Path>,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.send<undefined, FacilityRouteResponse<"GET", Path>>("GET", path, {
      query,
      ...options,
    });
  }

  post<Path extends FacilityRoutePath<"POST">>(
    path: Path,
    body?: FacilityRouteBody<"POST", Path>,
    options: FacilityWriteOptions = {},
  ) {
    return this.send<FacilityRouteBody<"POST", Path>, FacilityRouteResponse<"POST", Path>>(
      "POST",
      path,
      { body, ...options },
    );
  }

  patch<Path extends FacilityRoutePath<"PATCH">>(
    path: Path,
    body: FacilityRouteBody<"PATCH", Path>,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.send<FacilityRouteBody<"PATCH", Path>, FacilityRouteResponse<"PATCH", Path>>(
      "PATCH",
      path,
      { body, ...options },
    );
  }

  put<Path extends FacilityRoutePath<"PUT">>(
    path: Path,
    body: FacilityRouteBody<"PUT", Path>,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.send<FacilityRouteBody<"PUT", Path>, FacilityRouteResponse<"PUT", Path>>(
      "PUT",
      path,
      { body, ...options },
    );
  }

  delete<Path extends FacilityRoutePath<"DELETE">>(
    path: Path,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.send<undefined, FacilityRouteResponse<"DELETE", Path>>("DELETE", path, options);
  }

  stream<Data = unknown, Path extends string = string>(
    path: Path,
    onEvent: (event: FacilityStreamEvent<Data>) => void,
    options: FacilityStreamOptions = {},
  ): FacilityEventStream {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const done = this.consumeStream(path, onEvent, options, controller.signal).finally(() => {
      options.signal?.removeEventListener("abort", abortFromCaller);
    });
    return { signal: controller.signal, close: () => controller.abort(), done };
  }

  watchRun(
    runId: string,
    onEvent: (event: FacilityRunStreamEvent) => void,
    options: FacilityRunStreamOptions = {},
  ): FacilityEventStream {
    const { afterSeq, ...streamOptions } = options;
    return this.stream<RunEvent>(`/v1/runs/${runId}/stream`, onEvent, {
      ...streamOptions,
      query: { afterSeq },
    });
  }

  async *paginate<T>(
    loadPage: (page: {
      limit: number;
      offset: number;
      signal?: AbortSignal;
    }) => Promise<readonly T[]>,
    options: FacilityPaginationOptions = {},
  ): AsyncGenerator<T, void, void> {
    const limit = boundedPageSize(options.pageSize);
    let offset = nonNegativeInteger(options.offset, 0, "offset");
    while (!options.signal?.aborted) {
      const page = await loadPage({ limit, offset, signal: options.signal });
      for (const item of page) yield item;
      if (page.length < limit) return;
      offset += page.length;
    }
  }

  iterateAllRuns(
    query: { status?: string } & FacilityPaginationOptions = {},
  ): AsyncGenerator<RunWithProject, void, void> {
    const { status, ...pagination } = query;
    return this.paginate(
      ({ limit, offset, signal }) => this.get("/v1/runs", { status, limit, offset }, { signal }),
      pagination,
    );
  }

  iterateProjectRuns(
    projectId: string,
    query: { status?: string } & FacilityPaginationOptions = {},
  ): AsyncGenerator<Run, void, void> {
    const { status, ...pagination } = query;
    return this.paginate(
      ({ limit, offset, signal }) =>
        this.get(`/v1/projects/${projectId}/runs`, { status, limit, offset }, { signal }),
      pagination,
    );
  }

  async *iterateAudit(
    options: FacilityAuditIterationOptions = {},
  ): AsyncGenerator<AuditEvent, void, void> {
    const { pageSize, signal, cursor: initialCursor, ...query } = options;
    const limit = boundedPageSize(pageSize, 500);
    let cursor = initialCursor;
    while (!signal?.aborted) {
      const page = await this.get("/v1/audit", { ...query, limit, cursor }, { signal });
      for (const item of page.items) yield item;
      if (page.nextCursor === null) return;
      if (page.nextCursor === cursor) {
        throw new FacilityApiError(
          "Audit pagination returned a repeated cursor",
          200,
          "invalid_response",
        );
      }
      cursor = page.nextCursor;
    }
  }

  async *iterateLlmRequests(
    options: FacilityLlmRequestIterationOptions = {},
  ): AsyncGenerator<LlmRequest, void, void> {
    const { pageSize, signal, cursor: initialCursor, ...query } = options;
    const limit = boundedPageSize(pageSize, 500);
    let cursor = initialCursor;
    while (!signal?.aborted) {
      const page = await this.get("/v1/llm-requests", { ...query, limit, cursor }, { signal });
      for (const item of page.items) yield item;
      if (page.nextCursor === null) return;
      if (page.nextCursor === cursor) {
        throw new FacilityApiError(
          "LLM request pagination returned a repeated cursor",
          200,
          "invalid_response",
        );
      }
      cursor = page.nextCursor;
    }
  }

  me(): Promise<Me> {
    return this.get("/v1/me");
  }

  org(): Promise<Org | null> {
    return this.get("/v1/org");
  }

  updateOrg(body: { name?: string; settings?: JsonObject }): Promise<Org> {
    return this.patch("/v1/org", body);
  }

  members(query?: PageQuery): Promise<MemberRow[]> {
    return this.get("/v1/members", query);
  }

  addMember(body: AddMemberRequest, options?: FacilityWriteOptions): Promise<MemberRow["member"]> {
    return this.post("/v1/members", body, options);
  }

  updateMember(userId: string, body: UpdateMemberRequest): Promise<MemberRow["member"]> {
    return this.patch(`/v1/members/${userId}`, body);
  }

  removeMember(userId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/members/${userId}`);
  }

  roles(query?: PageQuery): Promise<Role[]> {
    return this.get("/v1/roles", query);
  }

  createRole(body: CreateRoleRequest, options?: FacilityWriteOptions): Promise<Role> {
    return this.post("/v1/roles", body, options);
  }

  updateRole(roleId: string, body: UpdateRoleRequest): Promise<Role> {
    return this.patch(`/v1/roles/${roleId}`, body);
  }

  deleteRole(roleId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/roles/${roleId}`);
  }

  apiKeys(query?: PageQuery): Promise<ApiKey[]> {
    return this.get("/v1/keys", query);
  }

  createApiKey(body: CreateApiKeyRequest, options?: FacilityWriteOptions): Promise<CreatedApiKey> {
    return this.post("/v1/keys", body, options);
  }

  revokeApiKey(keyId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/keys/${keyId}`);
  }

  projects(query?: FacilityGeneratedQuery<"GET", "/v1/projects">): Promise<Project[]> {
    return this.get("/v1/projects", query);
  }

  createProject(body: CreateProjectRequest, options?: FacilityWriteOptions): Promise<Project> {
    return this.post("/v1/projects", body, options);
  }

  project(projectId: string): Promise<Project> {
    return this.get(`/v1/projects/${projectId}`);
  }

  updateProject(projectId: string, body: UpdateProjectRequest): Promise<Project> {
    return this.patch(`/v1/projects/${projectId}`, body);
  }

  archiveProject(projectId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/projects/${projectId}`);
  }

  projectHealth(projectId: string): Promise<JsonObject> {
    return this.get(`/v1/projects/${projectId}/health`);
  }

  catalog(): Promise<Catalog> {
    return this.get("/v1/catalog");
  }

  githubInstallations(): Promise<GithubInstallation[]> {
    return this.get("/v1/github/installations");
  }

  githubInstallationRepos(
    installationId: number,
    query?: FacilityGeneratedQuery<"GET", "/v1/github/installations/{installationId}/repos">,
  ): Promise<GithubInstallationReposResponse> {
    return this.get(`/v1/github/installations/${installationId}/repos`, query);
  }

  projectRepos(projectId: string, query?: PageQuery): Promise<ProjectRepo[]> {
    return this.get(`/v1/projects/${projectId}/repos`, query);
  }

  connectProjectRepo(
    projectId: string,
    body: ConnectProjectRepoRequest,
    options?: FacilityWriteOptions,
  ): Promise<ProjectRepo> {
    return this.post(`/v1/projects/${projectId}/repos`, body, options);
  }

  disconnectProjectRepo(projectId: string, repoId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/projects/${projectId}/repos/${repoId}`);
  }

  verifyRepoFingerprints(
    repoId: string,
    options?: FacilityWriteOptions,
  ): Promise<FacilityGeneratedResponse<"POST", "/v1/repos/{repoId}/fingerprints/verify">> {
    return this.post(`/v1/repos/${repoId}/fingerprints/verify`, undefined, options);
  }

  adoptRepoFingerprints(
    repoId: string,
    options?: FacilityWriteOptions,
  ): Promise<FacilityGeneratedResponse<"POST", "/v1/repos/{repoId}/fingerprints/adopt">> {
    return this.post(`/v1/repos/${repoId}/fingerprints/adopt`, undefined, options);
  }

  kickstartPreview(projectId: string, repoId: string): Promise<KickstartPreview> {
    return this.get(`/v1/projects/${projectId}/kickstart/preview`, { repoId });
  }

  kickstartProject(
    projectId: string,
    repoId: string,
    answers: KickstartAnswers,
    options?: FacilityWriteOptions,
  ): Promise<KickstartResult> {
    return this.post(
      `/v1/projects/${projectId}/kickstart`,
      { repoId, answers, mode: "pr" },
      options,
    );
  }

  upgradeProject(
    projectId: string,
    repoId: string,
    toVersion?: string,
    options?: FacilityWriteOptions,
  ): Promise<JsonObject> {
    return this.post(`/v1/projects/${projectId}/upgrade`, { repoId, toVersion }, options);
  }

  runs(
    projectId: string,
    query?: { status?: string; limit?: number; offset?: number },
  ): Promise<Run[]> {
    return this.get(`/v1/projects/${projectId}/runs`, query);
  }

  allRuns(query?: { status?: string; limit?: number; offset?: number }): Promise<RunWithProject[]> {
    return this.get("/v1/runs", query);
  }

  triggerRun(
    projectId: string,
    body: TriggerRunRequest,
    options?: FacilityWriteOptions,
  ): Promise<Run> {
    return this.post(`/v1/projects/${projectId}/runs`, body, options);
  }

  run(runId: string): Promise<Run> {
    return this.get(`/v1/runs/${runId}`);
  }

  runEvents(
    runId: string,
    query?: FacilityGeneratedQuery<"GET", "/v1/runs/{runId}/events">,
  ): Promise<RunEvent[]> {
    return this.get(`/v1/runs/${runId}/events`, query);
  }

  runTranscript(runId: string): Promise<RunTranscript> {
    return this.send<undefined, RunTranscript>("GET", `/v1/runs/${runId}/transcript`, {
      responseType: "text",
    });
  }

  runDelivery(runId: string): Promise<RunDelivery> {
    return this.get(`/v1/runs/${runId}/delivery`);
  }

  retryRunDelivery(runId: string, options?: FacilityWriteOptions): Promise<RunDelivery> {
    return this.post(`/v1/runs/${runId}/delivery/retry`, undefined, options);
  }

  cancelRun(runId: string, options?: FacilityWriteOptions): Promise<Run> {
    return this.post(`/v1/runs/${runId}/cancel`, undefined, options);
  }

  steerRun(runId: string, body: SteerRunRequest, options?: FacilityWriteOptions): Promise<unknown> {
    return this.post(`/v1/runs/${runId}/steer`, body, options);
  }

  interruptRun(runId: string, options?: FacilityWriteOptions): Promise<{ ok: boolean }> {
    return this.post(`/v1/runs/${runId}/interrupt`, undefined, options);
  }

  resumeRun(
    runId: string,
    body: ResumeRunRequest = {},
    options?: FacilityWriteOptions,
  ): Promise<Run> {
    return this.post(`/v1/runs/${runId}/resume`, body, options);
  }

  inbox(query?: FacilityGeneratedQuery<"GET", "/v1/inbox">): Promise<InboxResponse> {
    return this.get("/v1/inbox", query);
  }

  actionTypes(query?: PageQuery): Promise<ActionType[]> {
    return this.get("/v1/action-types", query);
  }

  actionType(actionTypeId: string): Promise<ActionType> {
    return this.get(`/v1/action-types/${actionTypeId}`);
  }

  proposal(proposalId: string): Promise<ProposalWithEvents> {
    return this.get(`/v1/proposals/${proposalId}`);
  }

  createProposal(body: CreateProposalRequest, options?: FacilityWriteOptions): Promise<Proposal> {
    return this.post("/v1/proposals", body, options);
  }

  createMcpToolProposal(
    body: McpToolProposalRequest,
    options?: FacilityWriteOptions,
  ): Promise<Proposal> {
    return this.post("/v1/mcp/tool-proposals", body, options);
  }

  decideProposal(
    proposalId: string,
    body: DecideProposalRequest,
    options?: FacilityWriteOptions,
  ): Promise<Proposal> {
    return this.post(`/v1/proposals/${proposalId}/decide`, body, options);
  }

  proposalReviewContext(
    proposalId: string,
    options?: FacilityWriteOptions,
  ): Promise<ProposalReviewContext> {
    return this.post(`/v1/proposals/${proposalId}/review-context`, undefined, options);
  }

  executeProposal(proposalId: string, options?: FacilityWriteOptions): Promise<JsonObject> {
    return this.post(`/v1/proposals/${proposalId}/execute`, undefined, options);
  }

  issues(query?: FacilityGeneratedQuery<"GET", "/v1/issues">): Promise<Issue[]> {
    return this.get("/v1/issues", query);
  }

  githubIssues(
    projectId: string,
    query?: FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/issues">,
  ): Promise<GithubIssuePage> {
    return this.get(`/v1/projects/${projectId}/issues`, query);
  }

  githubIssue(
    projectId: string,
    number: number,
    query?: FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/issues/{number}">,
  ): Promise<GithubIssueDetail> {
    return this.get(`/v1/projects/${projectId}/issues/${number}`, query);
  }

  pipeline(projectId: string): Promise<Pipeline> {
    return this.get(`/v1/projects/${projectId}/pipeline`);
  }

  story(
    projectId: string,
    number: number,
    query?: FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/stories/{number}">,
  ): Promise<StoryDetail> {
    return this.get(`/v1/projects/${projectId}/stories/${number}`, query);
  }

  storyGithubActivity(
    projectId: string,
    number: number,
    query?: FacilityGeneratedQuery<
      "GET",
      "/v1/projects/{projectId}/stories/{number}/github-activity"
    >,
  ): Promise<StoryGithubActivity> {
    return this.get(`/v1/projects/${projectId}/stories/${number}/github-activity`, query);
  }

  syncGithubIssues(
    projectId: string,
    options?: FacilityWriteOptions,
  ): Promise<FacilityGeneratedResponse<"POST", "/v1/projects/{projectId}/issues/sync">> {
    return this.post(`/v1/projects/${projectId}/issues/sync`, undefined, options);
  }

  triggerGithubIssue(
    projectId: string,
    number: number,
    body: FacilityRouteBody<"POST", `/v1/projects/${string}/issues/${string}/trigger`>,
    options: FacilityTriggerGithubIssueOptions = {},
  ): Promise<
    FacilityGeneratedResponse<"POST", "/v1/projects/{projectId}/issues/{number}/trigger">
  > {
    const { query, ...writeOptions } = options;
    return this.request("POST", `/v1/projects/${projectId}/issues/${number}/trigger`, {
      body,
      query,
      ...writeOptions,
    });
  }

  outcomes(query?: FacilityGeneratedQuery<"GET", "/v1/outcomes">): Promise<Outcome[]> {
    return this.get("/v1/outcomes", query);
  }

  acknowledgeIssue(issueId: string, options?: FacilityWriteOptions): Promise<Issue> {
    return this.post(`/v1/issues/${issueId}/ack`, undefined, options);
  }

  resolveIssue(issueId: string, options?: FacilityWriteOptions): Promise<Issue> {
    return this.post(`/v1/issues/${issueId}/resolve`, undefined, options);
  }

  audit(query?: AuditQuery): Promise<AuditTail> {
    return this.get("/v1/audit", query);
  }

  verifyAudit(): Promise<{ ok: boolean; firstBreakSeq: number | null }> {
    return this.get("/v1/audit/verify");
  }

  registryItems(
    query?: FacilityGeneratedQuery<"GET", "/v1/registry/items">,
  ): Promise<RegistryItem[]> {
    return this.get("/v1/registry/items", query);
  }

  registryItem(itemId: string): Promise<RegistryItemWithVersions> {
    return this.get(`/v1/registry/items/${itemId}`);
  }

  createRegistryItem(
    body: CreateRegistryItemRequest,
    options?: FacilityWriteOptions,
  ): Promise<RegistryItemWithVersions> {
    return this.post("/v1/registry/items", body, options);
  }

  createRegistryVersion(
    itemId: string,
    body: CreateRegistryVersionRequest,
    options?: FacilityWriteOptions,
  ): Promise<RegistryVersion> {
    return this.post(`/v1/registry/items/${itemId}/versions`, body, options);
  }

  publishRegistryVersion(
    versionId: string,
    options?: FacilityWriteOptions,
  ): Promise<RegistryVersion> {
    return this.post(`/v1/registry/versions/${versionId}/publish`, undefined, options);
  }

  deprecateRegistryVersion(
    versionId: string,
    options?: FacilityWriteOptions,
  ): Promise<RegistryVersion> {
    return this.post(`/v1/registry/versions/${versionId}/deprecate`, undefined, options);
  }

  spend(query?: FacilityGeneratedQuery<"GET", "/v1/spend">): Promise<SpendRow[]> {
    return this.get("/v1/spend", query);
  }

  providers(query?: PageQuery): Promise<Provider[]> {
    return this.get("/v1/providers", query);
  }

  createProvider(
    body: CreateProviderRequest,
    options?: FacilityWriteOptions,
  ): Promise<Provider | null> {
    return this.post("/v1/providers", body, options);
  }

  deleteProvider(providerId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/providers/${providerId}`);
  }

  budgets(query?: PageQuery): Promise<Budget[]> {
    return this.get("/v1/budgets", query);
  }

  budget(budgetId: string): Promise<Budget> {
    return this.get(`/v1/budgets/${budgetId}`);
  }

  createBudget(body: CreateBudgetRequest, options?: FacilityWriteOptions): Promise<Budget> {
    return this.post("/v1/budgets", body, options);
  }

  updateBudget(budgetId: string, body: UpdateBudgetRequest): Promise<Budget> {
    return this.patch(`/v1/budgets/${budgetId}`, body);
  }

  deleteBudget(budgetId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/budgets/${budgetId}`);
  }

  agents(projectId: string, query?: PageQuery): Promise<AgentDef[]> {
    return this.get(`/v1/projects/${projectId}/agents`, query);
  }

  agentStatuses(projectId: string): Promise<AgentStatus[]> {
    return this.get(`/v1/projects/${projectId}/agents/status`);
  }

  createAgent(
    projectId: string,
    body: CreateAgentRequest,
    options?: FacilityWriteOptions,
  ): Promise<AgentDef> {
    return this.post(`/v1/projects/${projectId}/agents`, body, options);
  }

  updateAgent(projectId: string, agentId: string, body: UpdateAgentRequest): Promise<AgentDef> {
    return this.patch(`/v1/projects/${projectId}/agents/${agentId}`, body);
  }

  deleteAgent(projectId: string, agentId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/projects/${projectId}/agents/${agentId}`);
  }

  conversations(projectId: string): Promise<ConversationListItem[]> {
    return this.get(`/v1/projects/${projectId}/conversations`);
  }

  conversation(conversationId: string): Promise<ConversationDetail> {
    return this.get(`/v1/conversations/${conversationId}`);
  }

  createConversation(
    projectId: string,
    body: CreateConversationRequest,
    options?: FacilityWriteOptions,
  ): Promise<Conversation> {
    return this.post(`/v1/projects/${projectId}/conversations`, body, options);
  }

  sendConversationMessage(
    conversationId: string,
    body: CreateConversationMessageRequest,
    options?: FacilityWriteOptions,
  ): Promise<CreateConversationMessageResponse> {
    return this.post(`/v1/conversations/${conversationId}/messages`, body, options);
  }

  tasks(projectId: string, query?: PageQuery): Promise<Task[]> {
    return this.get(`/v1/projects/${projectId}/tasks`, query);
  }

  createTask(
    projectId: string,
    body: CreateTaskRequest,
    options?: FacilityWriteOptions,
  ): Promise<Task> {
    return this.post(`/v1/projects/${projectId}/tasks`, body, options);
  }

  updateTask(projectId: string, taskId: string, body: UpdateTaskRequest): Promise<Task> {
    return this.patch(`/v1/projects/${projectId}/tasks/${taskId}`, body);
  }

  deleteTask(projectId: string, taskId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/projects/${projectId}/tasks/${taskId}`);
  }

  transitionTask(taskId: string, status: string, options?: FacilityWriteOptions): Promise<Task> {
    return this.post(`/v1/tasks/${taskId}/transition`, { status }, options);
  }

  proposeTask(taskId: string, options?: FacilityWriteOptions): Promise<Proposal> {
    return this.post(`/v1/tasks/${taskId}/propose`, undefined, options);
  }

  virtualKeys(projectId: string, query?: PageQuery): Promise<VirtualKey[]> {
    return this.get(`/v1/projects/${projectId}/virtual-keys`, query);
  }

  createVirtualKey(
    projectId: string,
    body: CreateVirtualKeyRequest,
    options?: FacilityWriteOptions,
  ): Promise<CreatedVirtualKey> {
    return this.post(`/v1/projects/${projectId}/virtual-keys`, body, options);
  }

  revokeVirtualKey(projectId: string, keyId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/projects/${projectId}/virtual-keys/${keyId}`);
  }

  kbSpace(projectId: string): Promise<KbSpace | null> {
    return this.get(`/v1/projects/${projectId}/kb/space`);
  }

  upsertKbSpace(projectId: string, body: UpsertKbSpaceRequest): Promise<KbSpace> {
    return this.put(`/v1/projects/${projectId}/kb/space`, body);
  }

  kbEntries(
    projectId: string,
    query?: FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/kb/entries">,
  ): Promise<KbEntry[]> {
    return this.get(`/v1/projects/${projectId}/kb/entries`, query);
  }

  kbEntry(entryId: string): Promise<KbEntry> {
    return this.get(`/v1/kb/entries/${entryId}`);
  }

  createKbEntry(
    projectId: string,
    body: CreateKbEntryRequest,
    options?: FacilityWriteOptions,
  ): Promise<KbEntry> {
    // This convenience method never sets `dry=1`, so the API's generated
    // union is narrowed to the persisted-entry branch.
    return this.post(`/v1/projects/${projectId}/kb/entries`, body, options) as Promise<KbEntry>;
  }

  updateKbEntry(entryId: string, body: UpdateKbEntryRequest): Promise<KbEntry> {
    return this.patch(`/v1/kb/entries/${entryId}`, body);
  }

  validateKb(projectId: string, options?: FacilityWriteOptions): Promise<JsonObject> {
    return this.post(`/v1/projects/${projectId}/kb/validate`, undefined, options);
  }

  sandboxProfiles(query?: PageQuery): Promise<SandboxProfile[]> {
    return this.get("/v1/sandbox-profiles", query);
  }

  createSandboxProfile(
    body: CreateSandboxProfileRequest,
    options?: FacilityWriteOptions,
  ): Promise<SandboxProfile> {
    return this.post("/v1/sandbox-profiles", body, options);
  }

  updateSandboxProfile(
    profileId: string,
    body: UpdateSandboxProfileRequest,
  ): Promise<SandboxProfile> {
    return this.patch(`/v1/sandbox-profiles/${profileId}`, body);
  }

  deleteSandboxProfile(profileId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/sandbox-profiles/${profileId}`);
  }

  integrations(query?: FacilityGeneratedQuery<"GET", "/v1/integrations">): Promise<Integration[]> {
    return this.get("/v1/integrations", query);
  }

  integration(integrationId: string): Promise<Integration> {
    return this.get(`/v1/integrations/${integrationId}`);
  }

  createIntegration(
    body: CreateIntegrationRequest,
    options?: FacilityWriteOptions,
  ): Promise<IntegrationSecretResult> {
    return this.post("/v1/integrations", body, options);
  }

  updateIntegration(integrationId: string, body: UpdateIntegrationRequest): Promise<Integration> {
    return this.patch(`/v1/integrations/${integrationId}`, body);
  }

  rotateIntegrationSecret(
    integrationId: string,
    secret?: string,
    options?: FacilityWriteOptions,
  ): Promise<IntegrationSecretResult> {
    return this.post(`/v1/integrations/${integrationId}/rotate-secret`, { secret }, options);
  }

  integrationDeliveries(
    integrationId: string,
    query?: FacilityGeneratedQuery<"GET", "/v1/integrations/{integrationId}/deliveries">,
  ): Promise<WebhookDelivery[]> {
    return this.get(`/v1/integrations/${integrationId}/deliveries`, query);
  }

  integrationEvents(
    integrationId: string,
    query?: FacilityGeneratedQuery<"GET", "/v1/integrations/{integrationId}/events">,
  ): Promise<IntegrationEvent[]> {
    return this.get(`/v1/integrations/${integrationId}/events`, query);
  }

  retryWebhookDelivery(
    deliveryId: string,
    options?: FacilityWriteOptions,
  ): Promise<WebhookDelivery> {
    return this.post(`/v1/webhook-deliveries/${deliveryId}/retry`, undefined, options);
  }

  deleteIntegration(integrationId: string): Promise<{ ok: boolean }> {
    return this.delete(`/v1/integrations/${integrationId}`);
  }

  llmRequests(query?: LlmRequestQuery): Promise<LlmRequestPage> {
    return this.get("/v1/llm-requests", query);
  }

  llmRequestEnvelope(requestId: string): Promise<LlmRequestEnvelope> {
    return this.get(`/v1/llm-requests/${requestId}/envelope`);
  }

  analytics(query?: FacilityGeneratedQuery<"GET", "/v1/analytics">): Promise<AnalyticsRow[]> {
    return this.get("/v1/analytics", query);
  }

  analyticsOverview(
    query?: FacilityGeneratedQuery<"GET", "/v1/analytics/overview">,
  ): Promise<AnalyticsOverview> {
    return this.get("/v1/analytics/overview", query);
  }

  doctor(): Promise<DoctorResponse> {
    return this.get("/v1/admin/doctor");
  }

  private async send<Body, Response>(
    method: FacilityRouteMethod,
    path: string,
    options: {
      body?: Body;
      query?: QueryParams;
      idempotencyKey?: string;
      signal?: AbortSignal;
      responseType?: "json" | "text";
    } = {},
  ): Promise<Response> {
    if (
      options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length < 8 || options.idempotencyKey.length > 200)
    ) {
      throw new FacilityApiError(
        "Idempotency key must contain between 8 and 200 characters",
        400,
        "invalid_idempotency_key",
      );
    }
    let response: globalThis.Response | undefined;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        response = await this.fetchImpl(this.url(path, options.query), {
          method,
          headers: this.headers(options.body !== undefined, options.idempotencyKey),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          credentials: "include",
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (
          isRetryableMethod(method, options.idempotencyKey) &&
          attempt < this.maxRetries &&
          !timeoutSignal.aborted
        ) {
          await abortableDelay(this.retryBaseMs * 2 ** attempt, signal);
          continue;
        }
        if (signal.aborted) {
          throw new FacilityApiError(
            `Facility request timed out after ${this.timeoutMs}ms`,
            408,
            "request_timeout",
          );
        }
        throw new FacilityApiError(
          `Could not reach Facility at ${new URL(this.baseUrl).origin}`,
          503,
          "network_error",
          undefined,
          error,
        );
      }
      if (
        isRetryableMethod(method, options.idempotencyKey) &&
        attempt < this.maxRetries &&
        [429, 502, 503, 504].includes(response.status)
      ) {
        await response.body?.cancel().catch(() => undefined);
        await abortableDelay(responseRetryDelay(response, attempt, this.retryBaseMs), signal);
        continue;
      }
      break;
    }
    if (!response) {
      throw new FacilityApiError(
        "Facility request failed before receiving a response",
        503,
        "network_error",
      );
    }
    const text = await response.text();
    if (response.ok && options.responseType === "text") return text as Response;
    let payload: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        if (response.ok) {
          throw new FacilityApiError(
            "Facility returned an invalid JSON response",
            response.status,
            "invalid_response",
          );
        }
      }
    }
    if (!response.ok) {
      throw new FacilityApiError(
        payload?.error?.message ?? `Facility request failed: ${response.status}`,
        response.status,
        payload?.error?.code,
        payload?.error?.details,
        payload,
      );
    }
    return payload as Response;
  }

  private async consumeStream<Data>(
    path: string,
    onEvent: (event: FacilityStreamEvent<Data>) => void,
    options: FacilityStreamOptions,
    signal: AbortSignal,
  ) {
    const reconnect = options.reconnect ?? true;
    const initialRetryMs = Math.max(50, options.retryMs ?? 500);
    const maxRetryMs = Math.max(initialRetryMs, options.maxRetryMs ?? 10_000);
    let retryMs = initialRetryMs;
    let cursor = numericCursor(options.query?.afterSeq);
    while (!signal.aborted) {
      try {
        const query = { ...options.query, afterSeq: cursor ?? options.query?.afterSeq };
        const response = await this.fetchImpl(this.url(path, query), {
          headers: {
            ...this.headers(false),
            ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }),
          },
          credentials: "include",
          signal,
        });
        if (!response.ok) {
          const error = await apiError(response);
          if (!reconnect || (response.status < 500 && response.status !== 429)) throw error;
          options.onError?.(error);
          await abortableDelay(retryMs, signal);
          retryMs = Math.min(retryMs * 2, maxRetryMs);
          continue;
        }
        if (!response.body) throw new Error("Facility stream response had no body");
        retryMs = initialRetryMs;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replaceAll("\r\n", "\n");
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) cursor = dispatchSseChunk<Data>(chunk, cursor, onEvent);
        }
        if (buffer.trim()) cursor = dispatchSseChunk<Data>(buffer, cursor, onEvent);
        if (!reconnect || signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        if (
          !reconnect ||
          error instanceof FacilityApiError ||
          error instanceof FacilityStreamConsumerError
        ) {
          throw error;
        }
        options.onError?.(error);
      }
      await abortableDelay(retryMs, signal);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    }
  }

  private headers(hasBody: boolean, idempotencyKey?: string) {
    return {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    };
  }

  private url(path: string, query?: QueryParams) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }
}

function dispatchSseChunk<Data>(
  chunk: string,
  previousCursor: number | undefined,
  onEvent: (event: FacilityStreamEvent<Data>) => void,
) {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value || "message";
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return previousCursor;
  const dataText = data.join("\n");
  let parsed: unknown = dataText;
  try {
    parsed = JSON.parse(dataText);
  } catch {
    // SSE permits arbitrary text; JSON is Facility's convention, not a parser invariant.
  }
  try {
    onEvent({ event, data: parsed as Data, id });
  } catch (error) {
    throw new FacilityStreamConsumerError(error);
  }
  const idCursor = numericCursor(id);
  if (idCursor !== undefined) return idCursor;
  const dataCursor =
    parsed && typeof parsed === "object"
      ? numericCursor((parsed as { seq?: unknown }).seq)
      : undefined;
  return dataCursor ?? previousCursor;
}

function numericCursor(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function apiError(response: Response) {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | undefined;
  return new FacilityApiError(
    payload?.error?.message ?? `Facility request failed: ${response.status}`,
    response.status,
    payload?.error?.code,
    payload?.error?.details,
    payload,
  );
}

class FacilityStreamConsumerError extends Error {
  constructor(public readonly cause: unknown) {
    super("Facility stream consumer failed");
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function responseRetryDelay(response: Response, attempt: number, baseMs: number) {
  const value = response.headers.get("retry-after");
  if (value && /^\d+$/.test(value)) return Math.min(Number(value) * 1_000, 30_000);
  if (value) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 30_000));
  }
  return baseMs * 2 ** attempt;
}

function isRetryableMethod(method: FacilityRouteMethod, idempotencyKey?: string) {
  return method === "GET" || (method === "POST" && Boolean(idempotencyKey));
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return resolved;
}

function boundedPageSize(value: number | undefined, maximum = 200) {
  const resolved = positiveInteger(value, 100, "pageSize");
  if (resolved > maximum) throw new TypeError(`pageSize must be at most ${maximum}`);
  return resolved;
}
