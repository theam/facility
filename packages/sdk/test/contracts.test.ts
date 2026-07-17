import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AnalyticsOverview,
  AnalyticsRow,
  CreateProjectRequest,
  FacilityGeneratedResponse,
  FacilityRouteBody,
  FacilityRouteResponse,
  InboxResponse,
  Issue,
  Me,
  Project,
  QueryParams,
  RunWithProject,
  Task,
  TriggerRunRequest,
} from "../src/index.js";
import { type FacilityApiError, FacilityClient } from "../src/index.js";

type CapturedRequest = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
  credentials: RequestCredentials | undefined;
};

type ClientFixtureOptions = {
  apiKey?: string;
  baseUrl?: string;
  payload?: unknown;
  status?: number;
};

function makeClient(options: ClientFixtureOptions = {}) {
  const requests: CapturedRequest[] = [];
  const payload = options.payload ?? { ok: true };
  const status = options.status ?? 200;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
      credentials: init?.credentials,
    });
    return Response.json(payload, { status });
  };

  return {
    client: new FacilityClient({
      baseUrl: options.baseUrl ?? "https://api.facility.test",
      apiKey: options.apiKey,
      fetch: fetchImpl,
    }),
    requests,
  };
}

function requestAt(requests: CapturedRequest[], index: number) {
  const request = requests[index];
  if (!request) throw new Error(`Expected request at index ${index}`);
  return request;
}

function requestLine(request: CapturedRequest) {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

describe("generated contract integrity", () => {
  it("keeps the committed TypeScript declarations byte-for-byte current", async () => {
    const openApiUrl = new URL("../openapi.json", import.meta.url);
    const declarationUrl = new URL("../src/schema.d.ts", import.meta.url);
    const source = JSON.parse(await readFile(fileURLToPath(openApiUrl), "utf8"));
    const generated = `${COMMENT_HEADER}${astToString(await openapiTS(source))}`;
    await expect(readFile(fileURLToPath(declarationUrl), "utf8")).resolves.toBe(generated);
  });

  it("preserves the complete analytics overview evidence contract", () => {
    expectTypeOf<AnalyticsRow>().toMatchTypeOf<{
      outcomesAssessed: number;
      outcomesAccepted: number;
    }>();
    expectTypeOf<AnalyticsOverview>().toMatchTypeOf<{
      outcomes30d: {
        total: number;
        assessed: number;
        accepted: number;
        merged: number;
        oneShot: number;
      };
      projects: Array<{
        outcomesAssessed: number;
        outcomesAccepted: number;
      }>;
    }>();
  });
});

describe("FacilityClient request behaviour", () => {
  it("builds GET URLs with defined query params and sends credentials without a body", async () => {
    const { client, requests } = makeClient({ payload: [{ id: "project-1" }] });

    const result = await client.get("/v1/projects", {
      status: "active",
      limit: 25,
      offset: 0,
    });

    expect(result).toEqual([{ id: "project-1" }]);
    const request = requestAt(requests, 0);
    expect(request.url).toBe(
      "https://api.facility.test/v1/projects?status=active&limit=25&offset=0",
    );
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.credentials).toBe("include");
    expect(request.headers.get("content-type")).toBeNull();
  });

  it("sets JSON headers and bodies only for methods with request bodies", async () => {
    const { client, requests } = makeClient();
    const createBody = {
      name: "Contract Project",
      slug: "contract-project",
      settings: { visibility: "internal" },
    } satisfies CreateProjectRequest;
    const patchBody = { status: "archived" };

    await client.post("/v1/projects", createBody, { idempotencyKey: "project-create-123" });
    await client.patch("/v1/projects/project-1", patchBody);
    await client.put("/v1/projects/project-1/kb/space", { activeMd: "# Active" });
    await client.delete("/v1/projects/project-1");
    await client.get("/v1/me");

    const post = requestAt(requests, 0);
    expect(post.method).toBe("POST");
    expect(post.body).toBe(JSON.stringify(createBody));
    expect(post.headers.get("content-type")).toBe("application/json");
    expect(post.headers.get("idempotency-key")).toBe("project-create-123");

    const patch = requestAt(requests, 1);
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toBe(JSON.stringify(patchBody));
    expect(patch.headers.get("content-type")).toBe("application/json");

    const put = requestAt(requests, 2);
    expect(put.method).toBe("PUT");
    expect(put.body).toBe(JSON.stringify({ activeMd: "# Active" }));
    expect(put.headers.get("content-type")).toBe("application/json");

    const deleteRequest = requestAt(requests, 3);
    expect(deleteRequest.method).toBe("DELETE");
    expect(deleteRequest.body).toBeUndefined();
    expect(deleteRequest.headers.get("content-type")).toBeNull();

    const get = requestAt(requests, 4);
    expect(get.method).toBe("GET");
    expect(get.body).toBeUndefined();
    expect(get.headers.get("content-type")).toBeNull();
  });

  it("adds bearer authorization only when an api key is configured", async () => {
    const withKey = makeClient({ apiKey: "key_test_123" });
    await withKey.client.me();
    expect(requestAt(withKey.requests, 0).headers.get("authorization")).toBe("Bearer key_test_123");

    const withoutKey = makeClient();
    await withoutKey.client.me();
    expect(requestAt(withoutKey.requests, 0).headers.get("authorization")).toBeNull();
  });

  it("trims a trailing slash from baseUrl before appending paths", async () => {
    const { client, requests } = makeClient({ baseUrl: "https://api.facility.test/" });

    await client.me();

    expect(requestAt(requests, 0).url).toBe("https://api.facility.test/v1/me");
  });

  it("rejects non-2xx responses with the response error message and status", async () => {
    const { client } = makeClient({
      payload: { error: { message: "Project access denied" } },
      status: 403,
    });
    let thrown: unknown;

    try {
      await client.project("project-1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Project access denied");
    expect((thrown as { status?: number }).status).toBe(403);
  });

  it("returns parsed 2xx JSON bodies without wrapping bare arrays", async () => {
    const payload = [{ id: "project-1" }, { id: "project-2" }];
    const { client } = makeClient({ payload });

    await expect(client.projects()).resolves.toEqual(payload);
  });

  it("retries transient reads but never blindly retries writes", async () => {
    let reads = 0;
    const readClient = new FacilityClient({
      baseUrl: "https://api.facility.test",
      retryBaseMs: 0,
      fetch: async () => {
        reads += 1;
        return reads === 1
          ? Response.json({ error: { message: "warming up" } }, { status: 503 })
          : Response.json([{ id: "project-1" }]);
      },
    });
    await expect(readClient.projects()).resolves.toEqual([{ id: "project-1" }]);
    expect(reads).toBe(2);

    let writes = 0;
    const writeClient = new FacilityClient({
      baseUrl: "https://api.facility.test",
      retryBaseMs: 0,
      fetch: async () => {
        writes += 1;
        return Response.json({ error: { message: "unavailable" } }, { status: 503 });
      },
    });
    await expect(writeClient.createProject({ name: "one", slug: "one" })).rejects.toMatchObject({
      status: 503,
    });
    expect(writes).toBe(1);

    let idempotentWrites = 0;
    const retryingWriteClient = new FacilityClient({
      baseUrl: "https://api.facility.test",
      retryBaseMs: 0,
      fetch: async () => {
        idempotentWrites += 1;
        return idempotentWrites === 1
          ? Response.json({ error: { message: "unavailable" } }, { status: 503 })
          : Response.json({ id: "project-1", name: "one", slug: "one" });
      },
    });
    await expect(
      retryingWriteClient.createProject(
        { name: "one", slug: "one" },
        { idempotencyKey: "project-one-2026" },
      ),
    ).resolves.toMatchObject({ id: "project-1" });
    expect(idempotentWrites).toBe(2);
    await expect(
      retryingWriteClient.createProject({ name: "two", slug: "two" }, { idempotencyKey: "short" }),
    ).rejects.toMatchObject({ code: "invalid_idempotency_key", status: 400 });
  });

  it("iterates offset pages without making callers manage cursors", async () => {
    const requests: string[] = [];
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url.search);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(
          offset === 0
            ? [
                { id: "run-1", project: { id: "project-1", name: "One", slug: "one" } },
                { id: "run-2", project: { id: "project-1", name: "One", slug: "one" } },
              ]
            : [{ id: "run-3", project: { id: "project-1", name: "One", slug: "one" } }],
        );
      },
    });

    const ids: string[] = [];
    for await (const run of client.iterateAllRuns({ status: "running", pageSize: 2 })) {
      ids.push(run.id);
    }
    expect(ids).toEqual(["run-1", "run-2", "run-3"]);
    expect(requests).toEqual([
      "?status=running&limit=2&offset=0",
      "?status=running&limit=2&offset=2",
    ]);
    const consumeInvalidPageSize = async () => {
      for await (const _run of client.iterateAllRuns({ pageSize: 201 })) {
        // Validation happens when the async iterator starts.
      }
    };
    await expect(consumeInvalidPageSize()).rejects.toThrow(/at most 200/);
  });

  it("iterates audit and LLM cursor pages without exposing cursor bookkeeping", async () => {
    const requests: string[] = [];
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/v1/audit") {
          return Response.json(
            url.searchParams.has("cursor")
              ? { items: [{ id: "audit-2" }], nextCursor: null }
              : { items: [{ id: "audit-1" }], nextCursor: 41 },
          );
        }
        return Response.json(
          url.searchParams.has("cursor")
            ? { items: [{ id: "llm-2" }], nextCursor: null }
            : { items: [{ id: "llm-1" }], nextCursor: "2026-07-16T10:00:00.000Z" },
        );
      },
    });

    const auditIds: string[] = [];
    for await (const event of client.iterateAudit({ action: "run.finished", pageSize: 250 })) {
      auditIds.push(event.id);
    }
    const llmIds: string[] = [];
    for await (const request of client.iterateLlmRequests({
      projectId: "project-1",
      pageSize: 250,
    })) {
      llmIds.push(request.id);
    }

    expect(auditIds).toEqual(["audit-1", "audit-2"]);
    expect(llmIds).toEqual(["llm-1", "llm-2"]);
    expect(requests).toEqual([
      "/v1/audit?action=run.finished&limit=250",
      "/v1/audit?action=run.finished&limit=250&cursor=41",
      "/v1/llm-requests?projectId=project-1&limit=250",
      "/v1/llm-requests?projectId=project-1&limit=250&cursor=2026-07-16T10%3A00%3A00.000Z",
    ]);
  });

  it("enforces request deadlines and rejects malformed successful responses", async () => {
    const timed = new FacilityClient({
      baseUrl: "https://api.facility.test",
      timeoutMs: 10,
      maxRetries: 0,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    await expect(timed.projects()).rejects.toMatchObject({
      status: 408,
      code: "request_timeout",
    });

    const malformed = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async () => new Response("not json", { status: 200 }),
    });
    await expect(malformed.projects()).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });

  it("reconnects event streams from the last observed event id", async () => {
    const requests: Array<{ url: string; lastEventId: string | null }> = [];
    let attempt = 0;
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      apiKey: "fak_stream",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          lastEventId: new Headers(init?.headers).get("last-event-id"),
        });
        attempt += 1;
        const seq = attempt === 1 ? 4 : 5;
        return new Response(
          `id: ${seq}\r\nevent: run_event\r\ndata: {"seq":${seq},"type":"fixture"}\r\n\r\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const events: unknown[] = [];
    let stream: ReturnType<FacilityClient["stream"]>;
    stream = client.stream(
      "/v1/runs/run_1/stream",
      (event) => {
        events.push(event);
        if ((event.data as { seq?: number }).seq === 5) stream.close();
      },
      { retryMs: 50 },
    );

    await stream.done;

    expect(events).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      url: "https://api.facility.test/v1/runs/run_1/stream",
      lastEventId: null,
    });
    expect(requests[1]).toEqual({
      url: "https://api.facility.test/v1/runs/run_1/stream?afterSeq=4",
      lastEventId: "4",
    });
  });

  it("provides a run-specific typed stream helper", async () => {
    const requests: string[] = [];
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async (input, init) => {
        requests.push(`${String(input)}|${new Headers(init?.headers).get("last-event-id")}`);
        return new Response(
          'id: 8\nevent: run_event\ndata: {"seq":8,"runId":"run_1","type":"result","data":{"status":"succeeded"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let stream: ReturnType<FacilityClient["watchRun"]>;
    stream = client.watchRun(
      "run_1",
      (event) => {
        expect(event.data.runId).toBe("run_1");
        stream.close();
      },
      { afterSeq: 7, reconnect: false },
    );
    await stream.done;
    expect(requests).toEqual(["https://api.facility.test/v1/runs/run_1/stream?afterSeq=7|7"]);
  });

  it("surfaces non-retryable stream failures as typed API errors", async () => {
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "Permission denied",
              details: { needed: "runs:read" },
            },
          },
          { status: 403 },
        ),
    });
    const stream = client.stream("/v1/runs/run_1/stream", () => undefined);

    await expect(stream.done).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      details: { needed: "runs:read" },
    } satisfies Partial<FacilityApiError>);
  });

  it("issues expected methods and paths from representative convenience methods", async () => {
    const { client, requests } = makeClient();
    const createBody = { name: "Contract Project", slug: "contract-project" };
    const triggerBody = {
      mode: "manual",
      trigger: { source: "contract-test" },
    } satisfies TriggerRunRequest;
    const llmQuery: QueryParams = { limit: 10, cursor: "after-1", omitted: undefined };

    await client.me();
    await client.projects();
    await client.createProject(createBody);
    await client.project("project-1");
    await client.triggerRun("project-1", triggerBody);
    await client.run("run-1");
    await client.llmRequests(llmQuery);

    expect(requestLine(requestAt(requests, 0))).toBe("GET /v1/me");
    expect(requestLine(requestAt(requests, 1))).toBe("GET /v1/projects");
    expect(requestLine(requestAt(requests, 2))).toBe("POST /v1/projects");
    expect(requestAt(requests, 2).body).toBe(JSON.stringify(createBody));
    expect(requestLine(requestAt(requests, 3))).toBe("GET /v1/projects/project-1");
    expect(requestLine(requestAt(requests, 4))).toBe("POST /v1/projects/project-1/runs");
    expect(requestAt(requests, 4).body).toBe(JSON.stringify(triggerBody));
    expect(requestLine(requestAt(requests, 5))).toBe("GET /v1/runs/run-1");
    expect(requestLine(requestAt(requests, 6))).toBe(
      "GET /v1/llm-requests?limit=10&cursor=after-1",
    );
  });

  it("covers the interactive, GitHub, catalog, outcome, and integration helpers", async () => {
    const requests: CapturedRequest[] = [];
    const transcript = '{"type":"result","session_id":"session-1"}\n';
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test",
      fetch: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: init?.body,
          credentials: init?.credentials,
        });
        return String(input).endsWith("/transcript")
          ? new Response(transcript, {
              headers: { "content-type": "application/x-ndjson" },
            })
          : Response.json({ ok: true });
      },
    });

    await client.catalog();
    await client.agentStatuses("project-1");
    await client.conversations("project-1");
    await client.conversation("conversation-1");
    await client.createConversation("project-1", { agentDefId: "agent-1", title: "Fix CI" });
    await client.sendConversationMessage("conversation-1", { body: "Continue" });
    await client.githubInstallations();
    await client.githubInstallationRepos(42, { query: "facility" });
    await client.githubIssues("project-1", { state: "open", limit: 20 });
    await client.githubIssue("project-1", 17);
    await client.syncGithubIssues("project-1");
    await client.triggerGithubIssue("project-1", 17, { agent: "builder" });
    await client.outcomes({ projectId: "project-1", state: "terminal", limit: 10 });
    await client.integrationEvents("integration-1", { limit: 25, offset: 50 });
    await client.interruptRun("run-1");
    await client.resumeRun("run-1", { message: "Try the fallback" });
    await expect(client.runTranscript("run-1")).resolves.toBe(transcript);

    expect(requests.map(requestLine)).toEqual([
      "GET /v1/catalog",
      "GET /v1/projects/project-1/agents/status",
      "GET /v1/projects/project-1/conversations",
      "GET /v1/conversations/conversation-1",
      "POST /v1/projects/project-1/conversations",
      "POST /v1/conversations/conversation-1/messages",
      "GET /v1/github/installations",
      "GET /v1/github/installations/42/repos?query=facility",
      "GET /v1/projects/project-1/issues?state=open&limit=20",
      "GET /v1/projects/project-1/issues/17",
      "POST /v1/projects/project-1/issues/sync",
      "POST /v1/projects/project-1/issues/17/trigger",
      "GET /v1/outcomes?projectId=project-1&state=terminal&limit=10",
      "GET /v1/integrations/integration-1/events?limit=25&offset=50",
      "POST /v1/runs/run-1/interrupt",
      "POST /v1/runs/run-1/resume",
      "GET /v1/runs/run-1/transcript",
    ]);
    expect(requestAt(requests, 4).body).toBe(
      JSON.stringify({ agentDefId: "agent-1", title: "Fix CI" }),
    );
    expect(requestAt(requests, 5).body).toBe(JSON.stringify({ body: "Continue" }));
    expect(requestAt(requests, 11).body).toBe(JSON.stringify({ agent: "builder" }));
    expect(requestAt(requests, 15).body).toBe(JSON.stringify({ message: "Try the fallback" }));
  });
});

describe("typed route contracts", () => {
  it("maps GET route responses to the exported resource types", () => {
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/me">>().toEqualTypeOf<Me>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/projects">>().toEqualTypeOf<Project[]>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/runs">>().toEqualTypeOf<RunWithProject[]>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/inbox">>().toEqualTypeOf<InboxResponse>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/issues">>().toEqualTypeOf<Issue[]>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/analytics">>().toEqualTypeOf<AnalyticsRow[]>();
    expectTypeOf<
      FacilityRouteResponse<"POST", "/v1/projects/proj_1/tasks">
    >().toEqualTypeOf<Task>();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/projects/proj_1/health">>().toEqualTypeOf<
      FacilityGeneratedResponse<"GET", "/v1/projects/{projectId}/health">
    >();
  });

  it("resolves a bare :id route but rejects a wrong nested path as never", () => {
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/projects/proj_1">>().toEqualTypeOf<Project>();
    // The broad `/v1/projects/${string}` template admits `a/b`; the id guard
    // makes a wrong nested path resolve to `never` instead of the resource type.
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/projects/proj_1/not-a-route">>().toBeNever();
    expectTypeOf<FacilityRouteResponse<"GET", "/v1/budgets/bud_1/nope">>().toBeNever();
  });

  it("maps route bodies and rejects invalid pairings at compile time", () => {
    expectTypeOf<FacilityRouteBody<"POST", "/v1/projects">>().toEqualTypeOf<CreateProjectRequest>();
    expectTypeOf<FacilityRouteBody<"GET", "/v1/me">>().toEqualTypeOf<never>();

    function acceptsProjectList(_projects: FacilityRouteResponse<"GET", "/v1/projects">) {}

    // @ts-expect-error Me is not assignable to the Project[] response for GET /v1/projects.
    acceptsProjectList({} as Me);
  });
});
