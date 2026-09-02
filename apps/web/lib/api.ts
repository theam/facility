import type {
  ConnectProjectRepoRequest,
  CreateProjectRequest,
  FacilityGeneratedQuery,
  FacilityRouteBody,
  FacilityRouteMethod,
  FacilityRoutePath,
  FacilityRouteResponse,
  StoryAgent,
  StoryEnvironment,
  StoryMessage,
  WorkspaceStory,
  WorkspaceStoryBundle,
} from "@facility/sdk";
import { FacilityClient } from "@facility/sdk";
import { cookies } from "next/headers";

export type {
  ApiKey,
  ConnectProjectRepoRequest,
  CreateProjectRequest,
  KickstartAnswers,
  KickstartPreview,
  KickstartResult,
  Me,
  Member,
  MemberRow,
  Project,
  ProjectRepo,
  Role,
  StoryAgent,
  StoryEnvironment,
  StoryMessage,
  StoryWorkspace,
  WorkspaceStory,
  WorkspaceStoryBundle,
} from "@facility/sdk";

export const SESSION_COOKIE = "facility_session";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; offline: boolean; message: string };

function facilityApiUrl() {
  return process.env.FACILITY_API_URL ?? "http://localhost:4400";
}

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

function typed<T>(result: Promise<ApiResult<unknown>>): Promise<ApiResult<T>> {
  return result as Promise<ApiResult<T>>;
}

export const api = {
  me: () => apiFetch("GET", "/v1/me"),
  projects: () => apiFetch("GET", "/v1/projects"),
  createProject: (body: CreateProjectRequest) => apiFetch("POST", "/v1/projects", { body }),
  project: (id: string) => apiFetch("GET", `/v1/projects/${id}`),
  projectRepos: (projectId: string) => apiFetch("GET", `/v1/projects/${projectId}/repos`),
  connectProjectRepo: (projectId: string, body: ConnectProjectRepoRequest) =>
    apiFetch("POST", `/v1/projects/${projectId}/repos`, { body }),
  storyAgents: (projectId: string) =>
    typed<{ agents: StoryAgent[] }>(
      apiFetch("GET", `/v1/projects/${encodeURIComponent(projectId)}/story-agents`),
    ),
  workspaceStories: (projectId: string, status?: WorkspaceStory["status"]) =>
    typed<{ stories: WorkspaceStory[] }>(
      apiFetch("GET", `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories`, {
        query: status ? { status } : {},
      }),
    ),
  workspaceStory: (projectId: string, storyId: string) =>
    typed<WorkspaceStoryBundle>(
      apiFetch(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}`,
      ),
    ),
  workspaceStoryConversation: (projectId: string, storyId: string) =>
    typed<{ messages: StoryMessage[] }>(
      apiFetch(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/conversation`,
        { query: { limit: 200 } },
      ),
    ),
  workspaceStoryEnvironment: (projectId: string, storyId: string) =>
    typed<StoryEnvironment>(
      apiFetch(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/environment`,
      ),
    ),
  members: () => apiFetch("GET", "/v1/members"),
  roles: () => apiFetch("GET", "/v1/roles"),
  keys: () => apiFetch("GET", "/v1/keys"),
};
