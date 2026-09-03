import { createServer } from "node:net";
import { migrate, seed } from "@facility/db";
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
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        name: "Embedded MCP acceptance",
        slug: `embedded-mcp-${Date.now()}`,
      },
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
    expect(tools.tools).toHaveLength(19);
    expect(tools.tools.map((tool) => tool.name)).toContain("facility_start_story");
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
});
