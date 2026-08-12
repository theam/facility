import type {
  AnalyticsOverview,
  AuditEvent,
  ConnectProjectRepoRequest,
  CreateProjectRequest,
  FacilityGeneratedQuery,
  FacilityRouteBody,
  FacilityRouteMethod,
  FacilityRoutePath,
  FacilityRouteResponse,
  Issue,
  KickstartAnswers,
  Pipeline,
  Proposal,
  SpendRow,
} from "@facility/sdk";
import { FacilityClient } from "@facility/sdk";
import { cookies } from "next/headers";

export type {
  AgentDef,
  AgentStatus,
  ApiKey,
  AuditEvent,
  Budget,
  Catalog,
  ConnectProjectRepoRequest,
  CreateProjectRequest,
  Integration,
  IntegrationEvent,
  Issue,
  KickstartAnswers,
  KickstartPreview,
  KickstartResult,
  LlmRequest,
  LlmRequestPage,
  Me,
  Member,
  MemberRow,
  Outcome,
  Pipeline,
  PipelinePullRequest,
  PipelineStage,
  PipelineStageKey,
  PipelineStageKind,
  PipelineStageState,
  PipelineStory,
  Project,
  ProjectRepo,
  Proposal,
  Provider,
  RegistryItem,
  RegistryItemWithVersions,
  RegistryVersion,
  Role,
  Run,
  RunEvent,
  SpendRow,
  StoryDetail,
  StoryGithubActivity,
} from "@facility/sdk";

/**
 * Server-side client for the control plane. The fetch wrapper stays here so
 * Next can forward the session cookie; domain contracts live in @facility/sdk.
 */

export const SESSION_COOKIE = "facility_session";

function facilityApiUrl() {
  // Called from request-time server code (after `cookies()`), so a promoted
  // standalone image reads the deployment's runtime environment.
  return process.env.FACILITY_API_URL ?? "http://localhost:4400";
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; offline: boolean; message: string };

async function apiFetch<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>>(
  method: Method,
  path: Path,
  options: {
    body?: FacilityRouteBody<Method, Path>;
    query?: FacilityGeneratedQuery<Method, Path>;
  } = {},
): Promise<ApiResult<FacilityRouteResponse<Method, Path>>> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE);
  const client = new FacilityClient({
    baseUrl: facilityApiUrl(),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (session) headers.set("cookie", `${SESSION_COOKIE}=${session.value}`);
      return fetch(input, { ...init, headers, cache: "no-store" });
    },
  });
  try {
    const data = await client.request(method, path, options);
    return { ok: true, data };
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 0;
    return {
      ok: false,
      status,
      offline: status === 0,
      message: error instanceof Error ? error.message : "control plane unreachable",
    };
  }
}

function queryFromParams<
  Method extends FacilityRouteMethod,
  Path extends FacilityRoutePath<Method>,
>(params = ""): FacilityGeneratedQuery<Method, Path> {
  const query = new URLSearchParams(params.startsWith("?") ? params.slice(1) : params);
  return Object.fromEntries(query.entries()) as FacilityGeneratedQuery<Method, Path>;
}

// The control plane returns bare arrays for list endpoints (and {bucket,
// cost_cents} rows for spend). This client mirrors those shapes exactly.
export const api = {
  me: () => apiFetch("GET", "/v1/me"),
  projects: () => apiFetch("GET", "/v1/projects"),
  createProject: (body: CreateProjectRequest) => apiFetch("POST", "/v1/projects", { body }),
  project: (id: string) => apiFetch("GET", `/v1/projects/${id}`),
  projectRepos: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/repos`),
  connectProjectRepo: (projectId: string, body: ConnectProjectRepoRequest) =>
    apiFetch("POST", `/v1/projects/${projectId}/repos`, { body }),
  kickstartPreview: (projectId: string, repoId: string) =>
    apiFetch("GET", `/v1/projects/${projectId}/kickstart/preview`, { query: { repoId } }),
  kickstart: (projectId: string, body: { repoId: string; answers: KickstartAnswers; mode: "pr" }) =>
    apiFetch("POST", `/v1/projects/${projectId}/kickstart`, { body }),
  projectAgents: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/agents`),
  agentsStatus: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/agents/status`),
  catalog: () => apiFetch("GET", "/v1/catalog"),
  integrations: () => apiFetch("GET", "/v1/integrations"),
  integrationEvents: (integrationId: string) =>
    apiFetch("GET", `/v1/integrations/${integrationId}/events`),
  projectHealth: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/health`),
  updateProject: (projectId: string, body: Record<string, unknown>) =>
    apiFetch("PATCH", `/v1/projects/${projectId}`, {
      body: body as FacilityRouteBody<"PATCH", `/v1/projects/${string}`>,
    }),
  runs: (projectId: string, params = "") =>
    apiFetch("GET", `/v1/projects/${projectId}/runs`, { query: queryFromParams(params) }),
  allRuns: (params = "") => apiFetch("GET", "/v1/runs", { query: queryFromParams(params) }),
  run: (id: string) => apiFetch("GET", `/v1/runs/${id}`),
  runEvents: (id: string, afterSeq = 0, limit = 500) =>
    apiFetch("GET", `/v1/runs/${id}/events`, { query: { afterSeq, limit } }),
  recentRunEvents: (id: string, tail = 20) =>
    apiFetch("GET", `/v1/runs/${id}/events`, { query: { tail, limit: tail } }),
  // GET /v1/inbox returns { items, proposals, issues } — unwrap to the
  // proposals array both consumers expect (guarded so a bare array also works).
  inbox: async (): Promise<ApiResult<Proposal[]>> => {
    const res = await apiFetch("GET", "/v1/inbox", { query: { state: "open" } });
    if (!res.ok) return res;
    const d = res.data;
    return { ok: true, data: Array.isArray(d) ? d : (d.proposals ?? d.items ?? []) };
  },
  // Full inbox: proposals (human gates) AND platform issues (watchtower alerts),
  // so the inbox can surface both instead of silently dropping issues.
  inboxFull: async (): Promise<ApiResult<{ proposals: Proposal[]; issues: Issue[] }>> => {
    const res = await apiFetch("GET", "/v1/inbox", { query: { state: "open" } });
    if (!res.ok) return res;
    const d = res.data;
    if (Array.isArray(d)) return { ok: true, data: { proposals: d, issues: [] } };
    return {
      ok: true,
      data: { proposals: d.proposals ?? d.items ?? [], issues: d.issues ?? [] },
    };
  },
  // Every state, not just open — story timelines render decided gates too.
  inboxAll: async (): Promise<ApiResult<Proposal[]>> => {
    const res = await apiFetch("GET", "/v1/inbox", { query: {} });
    if (!res.ok) return res;
    const d = res.data;
    return { ok: true, data: Array.isArray(d) ? d : (d.proposals ?? d.items ?? []) };
  },
  pipeline: (projectId: string): Promise<ApiResult<Pipeline>> =>
    apiFetch("GET", `/v1/projects/${projectId}/pipeline`),
  story: (
    projectId: string,
    number: number,
    query: FacilityGeneratedQuery<"GET", "/v1/projects/{projectId}/stories/{number}">,
  ) => apiFetch("GET", `/v1/projects/${projectId}/stories/${number}`, { query }),
  storyGithubActivity: (
    projectId: string,
    number: number,
    query: FacilityGeneratedQuery<
      "GET",
      "/v1/projects/{projectId}/stories/{number}/github-activity"
    >,
  ) => apiFetch("GET", `/v1/projects/${projectId}/stories/${number}/github-activity`, { query }),
  proposal: (id: string) => apiFetch("GET", `/v1/proposals/${id}`),
  outcomes: (params = "") => apiFetch("GET", "/v1/outcomes", { query: queryFromParams(params) }),
  auditVerify: () => apiFetch("GET", "/v1/audit/verify"),
  audit: async (params = ""): Promise<ApiResult<AuditEvent[]>> => {
    const res = await apiFetch("GET", "/v1/audit", { query: queryFromParams(params) });
    if (!res.ok) return res;
    return { ok: true, data: Array.isArray(res.data) ? res.data : res.data.items };
  },
  auditPage: async (
    params = "",
  ): Promise<ApiResult<{ items: AuditEvent[]; nextCursor: number | null }>> => {
    const res = await apiFetch("GET", "/v1/audit", { query: queryFromParams(params) });
    if (!res.ok) return res;
    return {
      ok: true,
      data: Array.isArray(res.data) ? { items: res.data, nextCursor: null } : res.data,
    };
  },
  registry: (params = "") =>
    apiFetch("GET", "/v1/registry/items", { query: queryFromParams(params) }),
  registryItem: (id: string) => apiFetch("GET", `/v1/registry/items/${id}`),
  kbSpace: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/kb/space`),
  kbEntries: (projectId: string) =>
    apiFetch("GET", `/v1/projects/${projectId}/kb/entries`, {
      // Server default is 100 (max 200) — take the max so the nav doesn't
      // silently truncate mid-size KBs; pagination is the follow-up.
      query: { limit: 200 } as never,
    }),
  kbDecisions: (projectId: string, activeOnly = false) =>
    apiFetch("GET", `/v1/projects/${projectId}/kb/decisions`, {
      query: (activeOnly ? { active: 1 } : {}) as never,
    }),
  kbEntry: (entryId: string) => apiFetch("GET", `/v1/kb/entries/${entryId}`),
  kbNeighborhood: (entryId: string) => apiFetch("GET", `/v1/kb/entries/${entryId}/neighborhood`),
  kbSearch: (projectId: string, q: string, type?: string) =>
    apiFetch("GET", `/v1/projects/${projectId}/kb/search`, {
      query: { q, ...(type ? { type } : {}) } as never,
    }),
  spend: (params = "") => apiFetch("GET", "/v1/spend", { query: queryFromParams(params) }),
  llmRequests: (params = "") =>
    apiFetch("GET", "/v1/llm-requests", { query: queryFromParams(params) }),
  sandboxProfiles: () => apiFetch("GET", "/v1/sandbox-profiles"),
  members: () => apiFetch("GET", "/v1/members"),
  roles: () => apiFetch("GET", "/v1/roles"),
  keys: () => apiFetch("GET", "/v1/keys"),
  providers: () => apiFetch("GET", "/v1/providers"),
  budgets: () => apiFetch("GET", "/v1/budgets"),
  analyticsOverview: (): Promise<ApiResult<AnalyticsOverview>> =>
    apiFetch("GET", "/v1/analytics/overview"),
};

/**
 * Escape hatch for endpoints landing in this same release train (issue mirror,
 * repo discovery) whose SDK contracts don't exist yet. Every caller carries a
 * TODO(sdk) and migrates to the typed client once the route map regenerates.
 */
export async function untypedApi<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE);
  try {
    const res = await fetch(`${facilityApiUrl()}${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(session ? { cookie: `${SESSION_COOKIE}=${session.value}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return {
        ok: false,
        status: res.status,
        offline: false,
        message: detail?.error?.message ?? `${res.status} ${res.statusText}`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      offline: true,
      message: error instanceof Error ? error.message : "control plane unreachable",
    };
  }
}

/** Sum + descending groups from the spend endpoint's raw rows. */
export function summarizeSpend(rows: SpendRow[]): {
  totalCents: number;
  groups: Array<{ key: string; cents: number }>;
} {
  const groups = rows
    .map((r) => ({ key: r.bucket, cents: r.cost_cents }))
    .sort((a, b) => b.cents - a.cents);
  return { totalCents: groups.reduce((sum, g) => sum + g.cents, 0), groups };
}
