import assert from "node:assert/strict";
import { once } from "node:events";
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

function textPayload(result: unknown) {
  const content =
    result && typeof result === "object" && "content" in result ? result.content : undefined;
  const first = Array.isArray(content)
    ? (content[0] as { type?: string; text?: string } | undefined)
    : undefined;
  return first?.type === "text" ? (first.text ?? "{}") : "{}";
}

describe("@facility/mcp 0.12", () => {
  test("accepts only HTTPS or loopback HTTP authorization-server origins", () => {
    expect(canonicalAuthorizationServerUrl("auth.facility.test")).toBe(
      "https://auth.facility.test",
    );
    expect(canonicalAuthorizationServerUrl("http://localhost:3400")).toBe("http://localhost:3400");
    for (const invalid of [
      "http://auth.facility.test",
      "https://user:secret@auth.facility.test",
      "https://auth.facility.test/oauth",
      "https://auth.facility.test?tenant=one",
    ]) {
      expect(() => canonicalAuthorizationServerUrl(invalid)).toThrow(/MCP_AUTHORIZATION_SERVER/);
    }
  });

  test("exposes exactly the task-oriented story workspace tools", async () => {
    const { client, server } = await connect({ request: async () => ({ ok: true }) });
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "facility_list_projects",
      "facility_list_agents",
      "facility_list_skills",
      "facility_list_stories",
      "facility_get_story",
      "facility_get_delivery",
      "facility_set_delivery",
      "facility_get_delivery_integration_policy",
      "facility_set_delivery_integration_policy",
      "facility_get_story_completion",
      "facility_get_delivery_notice_policy",
      "facility_set_delivery_notice_policy",
      "facility_record_delivery_integration",
      "facility_request_story_completion",
      "facility_get_preview_convergence",
      "facility_retry_preview_convergence",
      "facility_get_workflow_policy",
      "facility_get_story_workflow",
      "facility_get_delivery_acceptance",
      "facility_request_delivery_acceptance",
      "facility_get_plan",
      "facility_propose_plan",
      "facility_request_plan_decision",
      "facility_get_consultation_options",
      "facility_get_consultations",
      "facility_consult_story",
      "facility_cancel_consultation",
      "facility_prepare_consultation_handoff",
      "facility_start_story",
      "facility_send_message",
      "facility_get_conversation",
      "facility_get_environment",
      "facility_get_costs",
      "facility_get_budget",
      "facility_set_budget",
      "facility_get_observability",
      "facility_list_backlog",
      "facility_list_attention",
      "facility_sync_github",
      "facility_open_preview",
      "facility_suspend_story",
      "facility_archive_story",
      "facility_restore_story",
      "facility_delete_workspace",
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(toolDefinitions.map((tool) => tool.name));
    expect(result.tools.every((tool) => tool.description?.includes("Needs "))).toBe(true);
    expect(
      result.tools.find((tool) => tool.name === "facility_list_agents")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "facility_list_skills")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "facility_start_story")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "facility_delete_workspace")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(result.tools.map((tool) => tool.name).join(" ")).not.toMatch(
      /proposal|receipt|registry|run|hitl/,
    );
    await client.close();
    await server.close();
  });

  test("executes story mutations directly with stable idempotency", async () => {
    const calls: unknown[][] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { status: "working", needs_attention: false };
      },
    });
    const result = await client.callTool({
      name: "facility_start_story",
      arguments: {
        projectId: "proj_1",
        provider: "github",
        externalId: "issue:272",
        title: "Persistent story workspaces",
        agent: "builder",
        message: "Implement issue 272",
        idempotencyKey: "issue-272-start",
      },
    });
    expect(JSON.parse(textPayload(result))).toMatchObject({ status: "working" });
    expect(calls).toEqual([
      [
        "POST",
        "/v1/projects/proj_1/workspace-stories",
        {
          query: undefined,
          body: {
            provider: "github",
            external_id: "issue:272",
            title: "Persistent story workspaces",
            agent: "builder",
            message: "Implement issue 272",
            idempotency_key: "issue-272-start",
          },
          idempotencyKey: "issue-272-start",
        },
      ],
    ]);
    expect(calls.flat().join(" ")).not.toContain("tool-proposals");
    await client.close();
    await server.close();
  });

  test("encodes identifiers and maps conversation, environment, preview, and lifecycle calls", async () => {
    const calls: unknown[][] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });
    const scope = { projectId: "proj/../../other", storyId: "story/../../other" };
    await client.callTool({
      name: "facility_get_conversation",
      arguments: { ...scope, after: 12, limit: 25 },
    });
    await client.callTool({
      name: "facility_send_message",
      arguments: {
        ...scope,
        agent: "architect",
        message: "Continue with the same context",
        idempotencyKey: "story-message-13",
      },
    });
    await client.callTool({
      name: "facility_open_preview",
      arguments: { ...scope, service: "web/app" },
    });
    await client.callTool({ name: "facility_suspend_story", arguments: scope });
    expect(calls[0]).toEqual([
      "GET",
      "/v1/projects/proj%2F..%2F..%2Fother/workspace-stories/story%2F..%2F..%2Fother/conversation",
      { query: { after: 12, limit: 25 }, body: undefined, idempotencyKey: undefined },
    ]);
    expect(calls[1]?.[0]).toBe("POST");
    expect(calls[1]?.[2]).toMatchObject({ idempotencyKey: "story-message-13" });
    expect(calls[2]?.[1]).toContain("/preview/web%2Fapp/open");
    expect(calls[3]?.[1]).toMatch(/\/suspend$/);
    await client.close();
    await server.close();
  });

  test("maps delivery policy, notices, integration evidence and completion with stable retries", async () => {
    const calls: unknown[][] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });
    const scope = { projectId: "proj/one", storyId: "story/one" };
    await client.callTool({
      name: "facility_set_delivery_integration_policy",
      arguments: {
        projectId: scope.projectId,
        mode: "repository_dispatch",
        repository: "acme/app",
      },
    });
    await client.callTool({
      name: "facility_set_delivery_notice_policy",
      arguments: { projectId: scope.projectId, inApp: false },
    });
    await client.callTool({ name: "facility_get_story_completion", arguments: scope });
    await client.callTool({
      name: "facility_record_delivery_integration",
      arguments: {
        ...scope,
        candidateRevision: "a".repeat(64),
        state: "succeeded",
        summary: "Integrated",
        evidenceUrl: null,
        idempotencyKey: "integration-result-1",
      },
    });
    await client.callTool({
      name: "facility_request_story_completion",
      arguments: {
        ...scope,
        candidateRevision: "a".repeat(64),
        idempotencyKey: "completion-request-1",
      },
    });
    expect(calls).toEqual([
      [
        "PATCH",
        "/v1/projects/proj%2Fone/delivery-integration",
        {
          query: undefined,
          body: { mode: "repository_dispatch", repository: "acme/app" },
          idempotencyKey: undefined,
        },
      ],
      [
        "PATCH",
        "/v1/projects/proj%2Fone/delivery-notices",
        { query: undefined, body: { in_app: false }, idempotencyKey: undefined },
      ],
      [
        "GET",
        "/v1/projects/proj%2Fone/workspace-stories/story%2Fone/completion",
        { query: undefined, body: undefined, idempotencyKey: undefined },
      ],
      [
        "POST",
        "/v1/projects/proj%2Fone/workspace-stories/story%2Fone/integration-result",
        {
          query: undefined,
          body: {
            candidate_revision: "a".repeat(64),
            event_id: null,
            state: "succeeded",
            summary: "Integrated",
            evidence_url: null,
            idempotency_key: "integration-result-1",
          },
          idempotencyKey: "integration-result-1",
        },
      ],
      [
        "POST",
        "/v1/projects/proj%2Fone/workspace-stories/story%2Fone/complete",
        {
          query: undefined,
          body: {
            candidate_revision: "a".repeat(64),
            confirm: true,
            idempotency_key: "completion-request-1",
          },
          idempotencyKey: "completion-request-1",
        },
      ],
    ]);
    await client.close();
    await server.close();
  });

  test("reads what is waiting on a person with the same filters as the web page", async () => {
    const calls: unknown[][] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { total: 0, items: [] };
      },
    });
    await client.callTool({ name: "facility_list_attention", arguments: { projectId: "proj_1" } });
    await client.callTool({
      name: "facility_list_attention",
      arguments: {
        projectId: "proj_1",
        status: "resolved",
        kind: ["turn_error", "agent_waiting"],
        q: "timed out",
        limit: 10,
        offset: 20,
      },
    });
    expect(calls).toEqual([
      [
        "GET",
        "/v1/projects/proj_1/attention",
        {
          query: { status: "open", kind: undefined, q: undefined, limit: 25, offset: 0 },
          body: undefined,
          idempotencyKey: undefined,
        },
      ],
      [
        "GET",
        "/v1/projects/proj_1/attention",
        {
          query: {
            status: "resolved",
            kind: "turn_error,agent_waiting",
            q: "timed out",
            limit: 10,
            offset: 20,
          },
          body: undefined,
          idempotencyKey: undefined,
        },
      ],
    ]);
    await client.close();
    await server.close();
  });

  test("requires explicit confirmation for the only destructive operation", async () => {
    const calls: unknown[][] = [];
    const { client, server } = await connect({
      request: async (...args) => {
        calls.push(args);
        return { status: "archived", workspace: { state: "destroyed" } };
      },
    });
    const invalid = await client.callTool({
      name: "facility_delete_workspace",
      arguments: {
        projectId: "proj_1",
        storyId: "story_1",
        confirm: false,
        idempotencyKey: "delete-story-1",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(0);

    await client.callTool({
      name: "facility_delete_workspace",
      arguments: {
        projectId: "proj_1",
        storyId: "story_1",
        confirm: true,
        idempotencyKey: "delete-story-1",
      },
    });
    expect(calls).toEqual([
      [
        "DELETE",
        "/v1/projects/proj_1/workspace-stories/story_1/workspace",
        {
          query: undefined,
          body: { confirm: true, idempotency_key: "delete-story-1" },
          idempotencyKey: "delete-story-1",
        },
      ],
    ]);
    await client.close();
    await server.close();
  });

  test("shares delivery validation and forwards read pagination, CAS and idempotency to the API", async () => {
    const requests: Array<{ method: string; path: string; options: unknown }> = [];
    const { client, server } = await connect({
      request: async (method, path, options) => {
        requests.push({ method, path, options });
        return { scope: { revision: 2 } };
      },
    });
    const args = { projectId: "proj_1", storyId: "story/1" };
    await client.callTool({
      name: "facility_get_delivery",
      arguments: {
        ...args,
        includeAvailable: true,
        q: "example/app",
        limit: 10,
        offset: 20,
      },
    });
    expect(requests[0]).toEqual({
      method: "GET",
      path: "/v1/projects/proj_1/workspace-stories/story%2F1/delivery",
      options: {
        query: { include_available: "true", q: "example/app", limit: 10, offset: 20 },
        body: undefined,
        idempotencyKey: undefined,
      },
    });
    const write = {
      ...args,
      expectedRevision: 1,
      declaredComplete: true,
      pullRequests: [{ repository: "example/app", number: 3, primary: true }],
      idempotencyKey: "delivery-retry-1",
    };
    expect(
      (await client.callTool({ name: "facility_set_delivery", arguments: write })).isError,
    ).not.toBe(true);
    expect(requests[1]).toMatchObject({
      method: "POST",
      options: {
        body: {
          expected_revision: 1,
          declared_complete: true,
          pull_requests: [{ repository: "example/app", number: 3, primary: true, required: true }],
          idempotency_key: "delivery-retry-1",
        },
        idempotencyKey: "delivery-retry-1",
      },
    });
    const invalid = await client.callTool({
      name: "facility_set_delivery",
      arguments: {
        ...write,
        pullRequests: [{ repository: "example/app", number: 3, primary: false }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(2);
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "facility_get_delivery")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === "facility_set_delivery")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    await client.close();
    await server.close();
  });

  test("reads and explicitly retries the shared preview convergence projection", async () => {
    const requests: Array<{ method: string; path: string; options: unknown }> = [];
    const { client, server } = await connect({
      request: async (method, path, options) => {
        requests.push({ method, path, options });
        return { state: "pending" };
      },
    });
    const scope = { projectId: "proj_1", storyId: "story/1" };
    await client.callTool({ name: "facility_get_preview_convergence", arguments: scope });
    await client.callTool({
      name: "facility_retry_preview_convergence",
      arguments: { ...scope, idempotencyKey: "preview-retry-1" },
    });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v1/projects/proj_1/workspace-stories/story%2F1/preview-convergence",
        options: { query: undefined, body: undefined, idempotencyKey: undefined },
      },
      {
        method: "POST",
        path: "/v1/projects/proj_1/workspace-stories/story%2F1/preview-convergence/retry",
        options: {
          query: undefined,
          body: { idempotency_key: "preview-retry-1" },
          idempotencyKey: "preview-retry-1",
        },
      },
    ]);
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "facility_get_preview_convergence")?.annotations,
    ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(
      tools.tools.find((tool) => tool.name === "facility_retry_preview_convergence")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    await client.close();
    await server.close();
  });

  test("shares workflow and acceptance reads while exposing only a request for human acceptance", async () => {
    const requests: Array<{ method: string; path: string; options: unknown }> = [];
    const { client, server } = await connect({
      request: async (method, path, options) => {
        requests.push({ method, path, options });
        return { status: "missing" };
      },
    });
    const scope = { projectId: "proj_1", storyId: "story/1" };
    for (const name of [
      "facility_get_workflow_policy",
      "facility_get_story_workflow",
      "facility_get_delivery_acceptance",
    ])
      expect((await client.callTool({ name, arguments: scope })).isError).not.toBe(true);
    expect(requests.map((item) => item.path)).toEqual([
      "/v1/projects/proj_1/workflow-policy",
      "/v1/projects/proj_1/workspace-stories/story%2F1/workflow",
      "/v1/projects/proj_1/workspace-stories/story%2F1/delivery-acceptance",
    ]);
    expect(
      (
        await client.callTool({
          name: "facility_request_delivery_acceptance",
          arguments: {
            ...scope,
            candidateRevision: "a".repeat(64),
            expectedPlanRevision: 2,
            expectedDecisionRevision: 3,
            idempotencyKey: "acceptance-retry-key",
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(requests[3]).toMatchObject({
      method: "POST",
      options: {
        body: {
          expected_candidate_revision: "a".repeat(64),
          expected_plan_revision: 2,
          expected_decision_revision: 3,
          idempotency_key: "acceptance-retry-key",
        },
        idempotencyKey: "acceptance-retry-key",
      },
    });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).join(" ")).not.toMatch(
      /confirm.*accept|confirm.*policy/,
    );
    await client.close();
    await server.close();
  });

  test("records plans and requests decisions without exposing an interactive confirmation tool", async () => {
    const requests: Array<{ method: string; path: string; options: unknown }> = [];
    const { client, server } = await connect({
      request: async (method, path, options) => {
        requests.push({ method, path, options });
        return { request: { confirmationUrl: "https://facility.example/review" } };
      },
    });
    const scope = { projectId: "proj_1", storyId: "story/1" };
    await client.callTool({
      name: "facility_get_plan",
      arguments: { ...scope, beforeRevision: 4, beforeDecisionRevision: 3, limit: 2 },
    });
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/projects/proj_1/workspace-stories/story%2F1/plan",
      options: { query: { before_revision: 4, before_decision_revision: 3, limit: 2 } },
    });
    await client.callTool({ name: "facility_get_plan", arguments: { ...scope, revision: 2 } });
    expect(requests[1]?.path).toBe(
      "/v1/projects/proj_1/workspace-stories/story%2F1/plan/revisions/2",
    );
    const input = {
      ...scope,
      expectedRevision: 2,
      markdown: "  ## Exact plan\n",
      repositories: ["example/app"],
      agents: ["planner"],
      sourceMessageId: "msg_1",
      idempotencyKey: "plan-retry-key",
    };
    expect(
      (await client.callTool({ name: "facility_propose_plan", arguments: input })).isError,
    ).not.toBe(true);
    expect(requests[2]).toMatchObject({
      method: "POST",
      options: {
        body: {
          expected_revision: 2,
          markdown: input.markdown,
          repositories: input.repositories,
          agents: input.agents,
          source_message_id: "msg_1",
          idempotency_key: input.idempotencyKey,
        },
        idempotencyKey: input.idempotencyKey,
      },
    });
    expect(
      (
        await client.callTool({
          name: "facility_propose_plan",
          arguments: { ...input, repositories: ["example/app", "Example/APP"] },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "facility_request_plan_decision",
          arguments: {
            ...scope,
            expectedRevision: 3,
            expectedDecisionRevision: 1,
            intent: "reject",
            idempotencyKey: "decision-retry-key",
          },
        })
      ).isError,
    ).toBe(true);
    expect(requests).toHaveLength(3);
    expect(
      (
        await client.callTool({
          name: "facility_request_plan_decision",
          arguments: {
            ...scope,
            expectedRevision: 3,
            expectedDecisionRevision: 1,
            intent: "reject",
            reason: "Add regression coverage",
            idempotencyKey: "decision-retry-key",
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(requests[3]).toMatchObject({
      method: "POST",
      path: "/v1/projects/proj_1/workspace-stories/story%2F1/plan/decisions",
      options: {
        body: {
          expected_revision: 3,
          expected_decision_revision: 1,
          intent: "reject",
          reason: "Add regression coverage",
          idempotency_key: "decision-retry-key",
        },
        idempotencyKey: "decision-retry-key",
      },
    });
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => /confirm/.test(tool.name))).toBe(false);
    expect(tools.find((tool) => tool.name === "facility_get_plan")?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === "facility_request_plan_decision")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    await client.close();
    await server.close();
  });

  test("preserves structured API diagnostics", async () => {
    const { client, server } = await connect({
      request: async () => {
        throw new FacilityApiError("Permission denied", 403, "forbidden", {
          needed: "projects:read",
        });
      },
    });
    const result = await client.callTool({
      name: "facility_get_story",
      arguments: { projectId: "proj_1", storyId: "story_1" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textPayload(result))).toEqual({
      error: {
        code: "forbidden",
        message: "Permission denied",
        status: 403,
        details: { needed: "projects:read" },
      },
    });
    await client.close();
    await server.close();
  });

  test("publishes project/story resources and a story workflow prompt", async () => {
    const { client, server } = await connect({
      request: async (_method, path) => {
        if (path === "/v1/projects") {
          return [{ id: "proj_1", name: "Facility", status: "active" }];
        }
        return { id: path.split("/").at(-1), status: "working" };
      },
    });
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate)).toEqual([
      "facility://projects/{id}",
      "facility://projects/{projectId}/stories/{storyId}",
    ]);
    const resources = await client.listResources();
    expect(resources.resources).toContainEqual(
      expect.objectContaining({ uri: "facility://projects/proj_1", name: "Facility" }),
    );
    const read = await client.readResource({
      uri: "facility://projects/proj_1/stories/story_1",
    });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toMatchObject({
      id: "story_1",
      status: "working",
    });
    const prompt = await client.getPrompt({
      name: "facility-work-on-story",
      arguments: { projectId: "proj_1", storyId: "story_1" },
    });
    expect(prompt.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("story_1"),
    });
    await client.close();
    await server.close();
  });

  test("accepts HTTP MCP resources only on loopback", () => {
    expect(() =>
      serveHttp({ apiUrl: "http://facility.test", port: 0, resourceUrl: "http://mcp.test" }),
    ).toThrow("MCP resourceUrl must use HTTPS unless it is a loopback URL");
  });

  test("streamable HTTP authenticates before protocol admission", async () => {
    const server = serveHttp({ apiUrl: "http://facility.test", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("streamable HTTP exposes probes and rejects untrusted browser origins", async () => {
    const server = serveHttp({ apiUrl: "http://facility.test", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, transport: "streamable-http" });
    const hostile = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer fak_test",
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    expect(hostile.status).toBe(421);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("readiness fails closed with the control plane", async () => {
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

  test("bounds bodies and rate-limits protocol traffic", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      maxBodyBytes: 32,
      maxRequestsPerMinute: 2,
      fetch: acceptCredential,
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const request = (body: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer fak_test", "content-type": "application/json" },
        body,
      });
    expect((await request(JSON.stringify({ payload: "x".repeat(64) }))).status).toBe(413);
    expect((await request("{")).status).toBe(400);
    const limited = await request("{}");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("external HTTP binds require an explicit trusted authority", () => {
    expect(() => serveHttp({ apiUrl: "http://facility.test", port: 0, host: "0.0.0.0" })).toThrow(
      /allowedHosts or resourceUrl/,
    );
  });

  test("serves OAuth protected-resource metadata when configured", async () => {
    const server = serveHttp({
      apiUrl: "http://facility.test",
      port: 0,
      resourceUrl: "http://127.0.0.1:0",
      authorizationServer: "https://auth.facility.test",
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const metadata = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      authorization_servers: ["https://auth.facility.test"],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
