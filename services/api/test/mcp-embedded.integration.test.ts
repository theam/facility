import { createServer } from "node:net";
import { newId } from "@facility/core";
import { migrate, seed, stories } from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("embedded MCP control plane", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  let app: Awaited<ReturnType<typeof buildApp>>;
  let client: Client;
  let projectId: string;
  const storyId = newId("story");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    const port = await unusedPort();
    const config: AppConfig = {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, 17).toString("base64"),
      port,
      publicUrl: `http://127.0.0.1:${port}`,
      webUrl: `http://127.0.0.1:${port}`,
      workspaceImage: "facility-runner:dev",
      workspaceDriver: "docker",
      facilityInsecureDev: true,
      logLevel: "silent",
    };
    app = await buildApp(config, { rateLimitMax: 10_000 });
    await app.listen({ port, host: "127.0.0.1" });

    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `embedded-mcp-${Date.now()}@example.com` },
    });
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const roles = await app.inject({ method: "GET", url: "/v1/roles", headers: { cookie } });
    const owner = (roles.json() as Array<{ id: string; name: string }>).find(
      (role) => role.name.toLowerCase() === "owner",
    );
    expect(owner).toBeDefined();
    if (!owner) throw new Error("expected owner role");
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "embedded MCP acceptance", roleId: owner.id },
    });
    const secret = issued.json().secret as string;
    const createdProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        name: "Embedded MCP acceptance",
        slug: `embedded-mcp-${Date.now()}`,
      },
    });
    const project = createdProject.json();
    projectId = project.id;
    await app.facilityDb.insert(stories).values({
      id: storyId,
      orgId: project.orgId,
      projectId,
      provider: "manual",
      externalId: storyId,
      title: "MCP plan read fixture",
      status: "ready",
      createdBy: { type: "service", id: issued.json().id },
    });

    client = new Client({ name: "facility-acceptance", version: "0.12.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it("serves the reduced tool catalog from the API process", async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(44);
    expect(tools.tools.map((tool) => tool.name)).toContain("facility_start_story");
    expect(tools.tools.map((tool) => tool.name)).toContain("facility_list_skills");
    for (const name of [
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
      "facility_get_preview_convergence",
      "facility_retry_preview_convergence",
      "facility_get_delivery_integration_policy",
      "facility_set_delivery_integration_policy",
      "facility_get_story_completion",
      "facility_get_delivery_notice_policy",
      "facility_set_delivery_notice_policy",
      "facility_record_delivery_integration",
      "facility_request_story_completion",
    ])
      expect(tools.tools.map((tool) => tool.name)).toContain(name);
    expect(tools.tools.map((tool) => tool.name).join(" ")).not.toMatch(/confirm/);
    expect(tools.tools.map((tool) => tool.name).join(" ")).not.toMatch(
      /proposal|receipt|registry|hitl/,
    );
  });

  it("executes an authenticated MCP tool through the same control-plane API", async () => {
    const result = await client.callTool({ name: "facility_list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((part) => part.type === "text");
    expect(text?.type === "text" && text.text ? JSON.parse(text.text) : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Embedded MCP acceptance" })]),
    );
  });

  it("reads an empty plan through the authenticated MCP/API path without execution", async () => {
    const result = await client.callTool({
      name: "facility_get_plan",
      arguments: { projectId, storyId },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      storyId,
      projectId,
      plan: null,
      decision: null,
      state: { revision: 0, decisionRevision: 0, status: "none" },
    });
  });
  it("reads workflow policy and acceptance from the same authenticated domain as the UI", async () => {
    for (const name of ["facility_get_story_workflow", "facility_get_delivery_acceptance"]) {
      const result = await client.callTool({ name, arguments: { projectId, storyId } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (part) => part.type === "text",
      )?.text;
      const payload = JSON.parse(text ?? "{}");
      expect(payload).toMatchObject({ projectId, storyId });
      if (name === "facility_get_delivery_acceptance")
        expect(payload).toMatchObject({ required: false, status: "missing", receipt: null });
      else
        expect(payload).toMatchObject({
          acceptance: { required: false, status: "missing" },
          blockedReason: null,
          queuedAgents: [],
        });
    }
  });
});
