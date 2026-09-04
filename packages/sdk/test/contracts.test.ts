import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CreateProjectRequest,
  FacilityGeneratedResponse,
  Project,
  WorkspaceStoryBundle,
} from "../src/index.js";
import { type FacilityApiError, FacilityClient } from "../src/index.js";

type CapturedRequest = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
  credentials: RequestCredentials | undefined;
};

function fixture(payload: unknown = { ok: true }, status = 200) {
  const requests: CapturedRequest[] = [];
  const client = new FacilityClient({
    baseUrl: "https://api.facility.test/",
    retryBaseMs: 0,
    fetch: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body,
        credentials: init?.credentials,
      });
      return Response.json(payload, { status });
    },
  });
  return { client, requests };
}

describe("generated 0.12 contract", () => {
  it("keeps the committed declarations current", async () => {
    const openApiUrl = new URL("../openapi.json", import.meta.url);
    const declarationUrl = new URL("../src/schema.d.ts", import.meta.url);
    const source = JSON.parse(await readFile(fileURLToPath(openApiUrl), "utf8"));
    const generated = `${COMMENT_HEADER}${astToString(await openapiTS(source))}`;
    await expect(readFile(fileURLToPath(declarationUrl), "utf8")).resolves.toBe(generated);
  });

  it("exposes projects and persistent story workspace types", () => {
    expectTypeOf<FacilityGeneratedResponse<"GET", "/v1/projects">>().toEqualTypeOf<Project[]>();
    expectTypeOf<WorkspaceStoryBundle["story"]["status"]>().toEqualTypeOf<
      "ready" | "working" | "attention" | "review" | "done" | "archived"
    >();
  });
});

describe("FacilityClient", () => {
  it("builds typed URLs, query strings, credentials, and bearer authentication", async () => {
    const requests: CapturedRequest[] = [];
    const client = new FacilityClient({
      baseUrl: "https://api.facility.test/",
      apiKey: "fak_test",
      headers: { "x-facility-surface": "mcp" },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: init?.body,
          credentials: init?.credentials,
        });
        return Response.json([]);
      },
    });

    await client.get("/v1/projects", { status: "active", limit: 25, offset: 0 });
    expect(requests[0]).toMatchObject({
      url: "https://api.facility.test/v1/projects?status=active&limit=25&offset=0",
      method: "GET",
      credentials: "include",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer fak_test");
    expect(requests[0]?.headers.get("x-facility-surface")).toBe("mcp");
    expect(requests[0]?.headers.get("content-type")).toBeNull();
  });

  it("sends current write bodies and idempotency keys", async () => {
    const { client, requests } = fixture();
    const body = {
      name: "Contract project",
      slug: "contract-project",
    } satisfies CreateProjectRequest;
    await client.post("/v1/projects", body, { idempotencyKey: "project-create-123" });

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toBe(JSON.stringify(body));
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("project-create-123");
  });

  it("supports the explicit workspace deletion body", async () => {
    const { client, requests } = fixture();
    const body = { confirm: true as const, idempotency_key: "delete-story-123" };
    await client.delete("/v1/projects/project-1/workspace-stories/story-1/workspace", body, {
      idempotencyKey: "delete-story-123",
    });
    expect(requests[0]?.body).toBe(JSON.stringify(body));
  });

  it("returns typed API errors", async () => {
    const payload = {
      error: {
        code: "project_access_denied",
        message: "Project access denied",
        details: { projectId: "project-1" },
      },
    };
    const { client } = fixture(payload, 403);
    await expect(client.project("project-1")).rejects.toMatchObject({
      name: "FacilityApiError",
      message: "Project access denied",
      status: 403,
      code: "project_access_denied",
      details: { projectId: "project-1" },
      payload,
    } satisfies Partial<FacilityApiError>);
  });

  it("retries reads and idempotent writes but not unkeyed writes", async () => {
    let reads = 0;
    const read = new FacilityClient({
      baseUrl: "https://api.facility.test",
      retryBaseMs: 0,
      fetch: async () => {
        reads += 1;
        return reads === 1
          ? Response.json({ error: { message: "warming" } }, { status: 503 })
          : Response.json([]);
      },
    });
    await expect(read.projects()).resolves.toEqual([]);
    expect(reads).toBe(2);

    let writes = 0;
    const write = new FacilityClient({
      baseUrl: "https://api.facility.test",
      retryBaseMs: 0,
      fetch: async () => {
        writes += 1;
        return Response.json({ error: { message: "down" } }, { status: 503 });
      },
    });
    await expect(write.post("/v1/projects", { name: "A", slug: "a" })).rejects.toMatchObject({
      status: 503,
    });
    expect(writes).toBe(1);

    await expect(
      write.post(
        "/v1/projects",
        { name: "A", slug: "a" },
        { idempotencyKey: "create-project-123" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(writes).toBe(4);
  });

  it("rejects invalid client retry and timeout settings", () => {
    expect(() => new FacilityClient({ baseUrl: "https://example.test", timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(() => new FacilityClient({ baseUrl: "https://example.test", maxRetries: -1 })).toThrow(
      "maxRetries must be a non-negative integer",
    );
  });
});
