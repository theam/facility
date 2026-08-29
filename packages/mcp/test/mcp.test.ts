import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { FacilityApiError } from "@facility/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import { canonicalAuthorizationServerUrl, serveHttp } from "../src/http.js";
import { createFacilityMcpServer, toolDefinitions } from "../src/tools.js";

const acceptCredential: typeof fetch = async () =>
  new Response(JSON.stringify({ principal: { type: "key" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  async start() {}

  async send(message: JSONRPCMessage) {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close() {
    this.onclose?.();
  }
}

function linkedTransports() {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

function textPayload(result: unknown) {
  const content =
    result && typeof result === "object" && "content" in result ? result.content : undefined;
  if (!Array.isArray(content)) return "{}";
  const first = content[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? (first.text ?? "{}") : "{}";
}

function requestWithAuthority(options: {
  port: number;
  path: string;
  authority: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: { ...options.headers, host: options.authority },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

async function connect(stub: {
  request: (method: string, path: string, options?: unknown) => Promise<unknown>;
}) {
  const pair = linkedTransports();
  const server = createFacilityMcpServer({
    apiUrl: "http://facility.test",
    apiKey: "fak_test",
    client: stub,
  });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  await server.connect(pair.server);
  await client.connect(pair.client);
  return { client, server };
}

describe("@facility/mcp", () => {
  test("accepts only HTTPS or loopback HTTP authorization-server origins", () => {
    expect(canonicalAuthorizationServerUrl("auth.facility.test")).toBe(
      "https://auth.facility.test",
    );
    expect(canonicalAuthorizationServerUrl("https://auth.facility.test/")).toBe(
      "https://auth.facility.test",
    );
    expect(canonicalAuthorizationServerUrl("http://localhost:3400")).toBe("http://localhost:3400");
    expect(canonicalAuthorizationServerUrl("http://127.0.0.1:3400")).toBe("http://127.0.0.1:3400");
    expect(canonicalAuthorizationServerUrl("http://[::1]:3400")).toBe("http://[::1]:3400");
    for (const invalid of [
      "http://auth.facility.test",
      "https://user:secret@auth.facility.test",
      "https://auth.facility.test/oauth",
      "https://auth.facility.test?tenant=one",
      "https://auth.facility.test#fragment",
    ]) {
      expect(() => canonicalAuthorizationServerUrl(invalid)).toThrow(/MCP_AUTHORIZATION_SERVER/);
    }
  });

  test("accepts HTTP MCP resources only on loopback", () => {
    expect(() =>
      serveHttp({
        apiUrl: "http://facility.test",
        port: 0,
        resourceUrl: "http://mcp.facility.test",
      }),
    ).toThrow("MCP resourceUrl must use HTTPS unless it is a loopback URL");
  });

  test("tools/list exposes the spec tool names and schemas", async () => {
    const { client, server } = await connect({ request: async () => ({ ok: true }) });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(79);
    expect(new Set(result.tools.map((tool) => tool.name)).size).toBe(result.tools.length);
    expect(result.tools.map((tool) => tool.name)).toEqual(toolDefinitions.map((tool) => tool.name));
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    const trigger = result.tools.find((tool) => tool.name === "facility_trigger_run");
    expect(trigger?.description).toContain("Needs runs:trigger");
    expect(trigger?.inputSchema.properties).not.toHaveProperty("confirm_token");
    expect(trigger?.inputSchema.properties).toHaveProperty("projectId");
    expect(trigger?.outputSchema?.properties).toHaveProperty("data");
    expect(trigger?.outputSchema?.properties).toHaveProperty("error");
    expect(trigger?.annotations).toMatchObject({ readOnlyHint: false });
    expect(result.tools.find((tool) => tool.name === "facility_me")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
    expect(result.tools.every((tool) => tool.description?.includes("Needs "))).toBe(true);
    expect(result.tools.map((tool) => tool.name)).not.toContain("facility_decide_proposal");
    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "facility_archive_project",
        "facility_update_agent",
        "facility_retire_agent",
        "facility_deprecate_registry_version",
        "facility_retry_webhook_delivery",
      ]),
    );
    await client.close();
    await server.close();
  });

  test("read tool dispatches through the SDK HTTP client layer", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { principal: { type: "key" }, org: { slug: "tam" }, permissions: ["org:read"] };
      },
    });
    const result = await client.callTool({ name: "facility_me", arguments: {} });
    expect(JSON.parse(textPayload(result))).toMatchObject({
      org: { slug: "tam" },
    });
    expect(calls).toEqual([["GET", "/v1/me", { body: undefined, query: undefined }]]);
    await client.close();
    await server.close();
  });

  test("write tool creates a HITL proposal instead of executing directly", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { id: "prop_1", state: "open" };
      },
    });
    const result = await client.callTool({
      name: "facility_steer_run",
      arguments: { runId: "run_1", body: "continue after tests pass" },
    });
    const payload = JSON.parse(textPayload(result));
    expect(payload.pending_human_approval).toBe(true);
    expect(payload.proposal_id).toBe("prop_1");
    expect(payload.summary).toContain("Steer run run_1");
    expect(calls).toEqual([
      [
        "POST",
        "/v1/mcp/tool-proposals",
        expect.objectContaining({
          body: {
            toolName: "facility_steer_run",
            permission: "runs:steer",
            args: { runId: "run_1", body: "continue after tests pass" },
            summary: "Steer run run_1 with a human-authored message.",
            projectId: undefined,
            runId: "run_1",
          },
        }),
      ],
    ]);
    const proposalOptions = (calls[0] as unknown[])[2] as { idempotencyKey: string };
    expect(proposalOptions.idempotencyKey).toMatch(/^mcp_[a-f0-9]{64}$/);
    await client.close();
    await server.close();
  });

  test("run-event pages expose the API cursor and path parameters are encoded", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return [];
      },
    });
    await client.callTool({
      name: "facility_list_run_events",
      arguments: { runId: "run/../../admin/doctor", afterSeq: 200 },
    });

    expect(calls).toEqual([
      [
        "GET",
        "/v1/runs/run%2F..%2F..%2Fadmin%2Fdoctor/events",
        {
          body: undefined,
          query: { afterSeq: 200, limit: 100 },
        },
      ],
    ]);
    await client.close();
    await server.close();
  });

  test("get run asks the API for the true event tail", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return String(args[1]).endsWith("/events")
          ? [{ seq: 248, type: "result", data: {} }]
          : { id: "run_1", status: "succeeded" };
      },
    });
    const result = await client.callTool({
      name: "facility_get_run",
      arguments: { runId: "run_1", lastEvents: 1 },
    });

    expect(JSON.parse(textPayload(result))).toMatchObject({
      id: "run_1",
      events: [{ seq: 248, type: "result" }],
    });
    expect(calls).toEqual([
      ["GET", "/v1/runs/run_1"],
      ["GET", "/v1/runs/run_1/events", { query: { tail: 1 } }],
    ]);
    await client.close();
    await server.close();
  });

  test("new read tools expose durable conversations, GitHub issues, and raw transcripts", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return args[1] === "/v1/runs/run_1/transcript" ? '{"type":"assistant"}\n' : [];
      },
    });
    await client.callTool({
      name: "facility_list_conversations",
      arguments: { projectId: "proj_1" },
    });
    await client.callTool({
      name: "facility_list_github_issues",
      arguments: { projectId: "proj_1", state: "open" },
    });
    await client.callTool({
      name: "facility_get_github_issue",
      arguments: { projectId: "proj_1", repoId: "repo_1", number: 42 },
    });
    const transcript = await client.callTool({
      name: "facility_run_transcript",
      arguments: { runId: "run_1" },
    });

    expect(JSON.parse(textPayload(transcript))).toBe('{"type":"assistant"}\n');
    expect(calls).toEqual([
      ["GET", "/v1/projects/proj_1/conversations", { body: undefined, query: undefined }],
      [
        "GET",
        "/v1/projects/proj_1/issues",
        {
          body: undefined,
          query: { state: "open", q: undefined, cursor: undefined, limit: 50 },
        },
      ],
      ["GET", "/v1/projects/proj_1/issues/42", { body: undefined, query: { repoId: "repo_1" } }],
      [
        "GET",
        "/v1/runs/run_1/transcript",
        { body: undefined, query: undefined, responseType: "text" },
      ],
    ]);
    await client.close();
    await server.close();
  });

  test("conversation and GitHub mutations remain durable separate-human proposals", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { id: `prop_${calls.length}`, state: "open" };
      },
    });
    const cases = [
      {
        name: "facility_start_conversation",
        arguments: { projectId: "proj_1", title: "Release" },
      },
      {
        name: "facility_send_conversation_message",
        arguments: { conversationId: "evt_thread", body: "Continue" },
      },
      {
        name: "facility_sync_github_issues",
        arguments: { projectId: "proj_1" },
      },
      {
        name: "facility_trigger_github_issue",
        arguments: { projectId: "proj_1", repoId: "repo_1", number: 42, agentName: "builder" },
      },
      { name: "facility_interrupt_run", arguments: { runId: "run_1" } },
      { name: "facility_resume_run", arguments: { runId: "run_1", message: "Continue" } },
    ];
    for (const input of cases) {
      const result = await client.callTool(input);
      expect(JSON.parse(textPayload(result)).pending_human_approval).toBe(true);
    }
    expect(calls).toHaveLength(cases.length);
    expect(calls[3]).toEqual([
      "POST",
      "/v1/mcp/tool-proposals",
      expect.objectContaining({
        body: expect.objectContaining({
          args: expect.objectContaining({ repoId: "repo_1" }),
        }),
      }),
    ]);
    expect(
      calls.every(
        (call) =>
          (call as unknown[])[0] === "POST" && (call as unknown[])[1] === "/v1/mcp/tool-proposals",
      ),
    ).toBe(true);
    await client.close();
    await server.close();
  });

  test("resources are discoverable and readable without guessing ids", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        if (args[1] === "/v1/projects") {
          return [{ id: "proj_1", name: "Control Plane", slug: "control-plane", status: "active" }];
        }
        if (args[1] === "/v1/runs") {
          return [
            {
              id: "run_1",
              status: "running",
              engine: "codex",
              mode: "manual",
              project: { id: "proj_1", name: "Control Plane", slug: "control-plane" },
            },
          ];
        }
        if (args[1] === "/v1/runs/run_1/events") return [];
        if (args[1] === "/v1/runs/run_1") return { id: "run_1", status: "running" };
        return { id: "proj_1", name: "Control Plane" };
      },
    });

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "facility://projects/{id}",
      "facility://runs/{id}",
    ]);
    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toEqual([
      "facility://me",
      "facility://projects/proj_1",
      "facility://runs/run_1",
    ]);
    const read = await client.readResource({ uri: "facility://runs/run_1" });
    const first = read.contents[0];
    expect(JSON.parse(first && "text" in first ? first.text : "{}")).toMatchObject({
      run: { id: "run_1" },
      events: [],
    });
    expect(calls).toContainEqual(["GET", "/v1/runs", { query: { limit: 50, offset: 0 } }]);
    await client.close();
    await server.close();
  });

  test("run triage prompt accepts and preserves an optional run id", async () => {
    const { client, server } = await connect({ request: async () => ({ ok: true }) });
    const prompts = await client.listPrompts();
    const triage = prompts.prompts.find((prompt) => prompt.name === "facility-run-triage");
    expect(triage?.arguments).toContainEqual(
      expect.objectContaining({ name: "runId", required: false }),
    );

    const result = await client.getPrompt({
      name: "facility-run-triage",
      arguments: { runId: "run_42" },
    });
    expect(result.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Facility run run_42"),
    });
    await client.close();
    await server.close();
  });

  test("org-wide run listing uses the paginated global endpoint", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return [];
      },
    });
    await client.callTool({
      name: "facility_list_runs",
      arguments: { status: "running", limit: 20, offset: 40 },
    });
    expect(calls).toEqual([
      ["GET", "/v1/runs", { body: undefined, query: { status: "running", limit: 20, offset: 40 } }],
    ]);
    await client.close();
    await server.close();
  });

  test("tool failures set isError and preserve structured API diagnostics", async () => {
    const { client, server } = await connect({
      request: async () => {
        throw new FacilityApiError("Permission denied", 403, "forbidden", {
          needed: "org:read",
        });
      },
    });
    const result = await client.callTool({ name: "facility_me", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textPayload(result))).toEqual({
      error: {
        code: "forbidden",
        message: "Permission denied",
        status: 403,
        details: { needed: "org:read" },
      },
    });
    await client.close();
    await server.close();
  });

  test("audit and llm request read tools pass pagination filters", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { items: [], nextCursor: null };
      },
    });
    await client.callTool({
      name: "facility_audit_tail",
      arguments: { limit: 10, actor: "key:auditor", action: "mcp.tool.executed", cursor: 12 },
    });
    await client.callTool({
      name: "facility_llm_requests",
      arguments: { projectId: "proj_1", limit: 5, cursor: "2026-07-05T00:00:00.000Z" },
    });
    await client.callTool({
      name: "facility_llm_request_envelope",
      arguments: { requestId: "evt_1" },
    });
    expect(calls).toEqual([
      [
        "GET",
        "/v1/audit",
        {
          body: undefined,
          query: {
            limit: 10,
            actor: "key:auditor",
            action: "mcp.tool.executed",
            cursor: 12,
          },
        },
      ],
      [
        "GET",
        "/v1/llm-requests",
        {
          body: undefined,
          query: {
            projectId: "proj_1",
            from: undefined,
            to: undefined,
            limit: 5,
            cursor: "2026-07-05T00:00:00.000Z",
          },
        },
      ],
      ["GET", "/v1/llm-requests/evt_1/envelope", { body: undefined, query: undefined }],
    ]);
    await client.close();
    await server.close();
  });

  test("same MCP caller cannot self-replay a write into direct execution", async () => {
    const calls: unknown[] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { id: `prop_${calls.length}`, state: "open" };
      },
    });
    await client.callTool({
      name: "facility_steer_run",
      arguments: { runId: "run_1", body: "ship it" },
    });
    await client.callTool({
      name: "facility_steer_run",
      arguments: { runId: "run_1", body: "ship it", confirm_token: "old-self-replay-token" },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => (call as unknown[])[1] === "/v1/mcp/tool-proposals")).toBe(true);
    await client.close();
    await server.close();
  });

  test("streamable HTTP transport returns 401 without bearer API key", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP exposes health and rejects untrusted browser origins", async () => {
    const server = serveHttp({ apiUrl: "http://facility.test", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("x-request-id") ?? "", /\S+/);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await health.json(), {
      ok: true,
      version: "0.3.0",
      transport: "streamable-http",
    });
    const hostile = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer fak_test",
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(hostile.status, 421);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP readiness reflects control-plane health", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ ok: false, api: "down" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("load-balancer probes accept a private authority without exposing MCP traffic", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      allowedHosts: ["mcp.facility.test"],
      fetch: async () => new Response("ok"),
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const privateAuthority = "10.0.1.42:4420";

    for (const path of ["/health", "/healthz"]) {
      const health = await requestWithAuthority({
        port,
        path,
        authority: privateAuthority,
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({
        ok: true,
        version: "0.3.0",
        transport: "streamable-http",
      });
    }

    const readiness = await requestWithAuthority({
      port,
      path: "/readyz",
      authority: privateAuthority,
    });
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toEqual({ ok: true, api: "up" });

    const protectedResponse = await requestWithAuthority({
      port,
      path: "/mcp",
      authority: privateAuthority,
      method: "POST",
      headers: {
        authorization: "Bearer fak_test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(protectedResponse.status).toBe(421);

    const oauthDiscovery = await requestWithAuthority({
      port,
      path: "/.well-known/oauth-protected-resource/mcp",
      authority: privateAuthority,
    });
    expect(oauthDiscovery.status).toBe(421);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP fails closed when credential validation is unavailable", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer fak_uncached",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toEqual({ error: "credential validation unavailable" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP bounds and validates request bodies before protocol parsing", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      maxBodyBytes: 32,
      fetch: acceptCredential,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer fak_test", "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(64) }),
    });
    expect(tooLarge.status).toBe(413);
    const invalid = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer fak_test", "content-type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP rate-limits protocol traffic before allocating MCP servers", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      maxRequestsPerMinute: 1,
      fetch: acceptCredential,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const request = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer fak_test", "content-type": "application/json" },
        body: "{}",
      });
    expect((await request()).status).not.toBe(429);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toEqual({ error: "rate limit exceeded" });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("external HTTP binds require an explicit trusted authority", () => {
    expect(() => serveHttp({ apiUrl: "http://facility.test", port: 0, host: "0.0.0.0" })).toThrow(
      /allowedHosts or resourceUrl/,
    );
  });

  test("trusted proxy hops isolate rate limits by the forwarded client address", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      maxRequestsPerMinute: 1,
      trustedProxyHops: 1,
      fetch: acceptCredential,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const request = (address: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer fak_test",
          "content-type": "application/json",
          "x-forwarded-for": address,
        },
        body: "{}",
      });
    expect((await request("192.0.2.10")).status).not.toBe(429);
    expect((await request("192.0.2.10")).status).toBe(429);
    expect((await request("192.0.2.11")).status).not.toBe(429);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("serves OAuth protected-resource metadata when configured", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      resourceUrl: "https://mcp.facility.test/mcp",
      authorizationServer: "https://auth.facility.test",
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert.equal(body.resource, "https://mcp.facility.test/mcp");
    assert.deepEqual(body.authorization_servers, ["https://auth.facility.test"]);
    const legacyAlias = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
      { redirect: "manual" },
    );
    assert.equal(legacyAlias.status, 308);
    assert.equal(legacyAlias.headers.get("location"), "/.well-known/oauth-protected-resource/mcp");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("advertises resource metadata via WWW-Authenticate on 401 when OAuth configured", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      // Keep the historical origin-only deployment value as an accepted input.
      resourceUrl: "https://mcp.facility.test",
      authorizationServer: "https://auth.facility.test",
      fetch: acceptCredential,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /resource_metadata="https:\/\/mcp\.facility\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    const legacyUnauthenticated = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(legacyUnauthenticated.status, 401);
    assert.equal(legacyUnauthenticated.headers.get("www-authenticate"), "Bearer");
    const legacyAuthenticated = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        authorization: "Bearer fak_legacy",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.notEqual(legacyAuthenticated.status, 401);
    assert.notEqual(legacyAuthenticated.status, 405);
    // Metadata discovery is unconfigured (no authorization server) => 404.
    const bare = serveHttp({ apiUrl: "http://facility.test", port: 0 });
    await once(bare, "listening");
    const barePort = (bare.address() as AddressInfo).port;
    const meta = await fetch(`http://127.0.0.1:${barePort}/.well-known/oauth-protected-resource`);
    assert.equal(meta.status, 404);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  test("validates API-key and OAuth bearers with the control plane before protocol admission", async () => {
    const seen: string[] = [];
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        seen.push(authorization);
        return new Response(null, {
          status: ["Bearer fak_valid", "Bearer header.payload.signature"].includes(authorization)
            ? 200
            : 401,
        });
      },
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer header.payload.signature",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.notEqual(response.status, 401);

    const apiKey = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "bearer fak_valid",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.notEqual(apiKey.status, 401);

    const invalid = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer totally-bogus",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(invalid.status, 401);
    assert.deepEqual(seen, [
      "Bearer header.payload.signature",
      "Bearer fak_valid",
      "Bearer totally-bogus",
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
