import { generateApiKey, newId } from "@facility/core";
import {
  agentDefs,
  apiKeys,
  conversations,
  createDb,
  migrate,
  projects,
  registryItems,
  seed,
} from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility";
const masterKey = Buffer.alloc(32, 10).toString("base64");

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("conversation scoping", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; conversation tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4404,
    publicUrl: "http://localhost:4404",
    sandboxApiUrl: "http://localhost:4404",
    sandboxGatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  const orgId = "org_dev_the_agile_monkeys";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("hides bare conversation ids from another project-scoped key", async () => {
    const projectA = await insertProject("Conversation Scope A");
    const projectB = await insertProject("Conversation Scope B");
    const agent = await insertAgent(projectA.id);
    const conversation = (
      await db
        .insert(conversations)
        .values({
          id: newId("evt"),
          orgId,
          projectId: projectA.id,
          agentDefId: agent.id,
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const key = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: key.id,
      orgId,
      name: "conversation scoped key",
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      scopeType: "project",
      projectId: projectB.id,
      roleId: "role_bundled_owner",
    });

    const scoped = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversation?.id}`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(scoped.statusCode).toBe(404);
  });

  async function insertProject(name: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name,
          slug: name.toLowerCase().replaceAll(" ", "-") + suffix,
          settings: {},
        })
        .returning()
    )[0];
    if (!project) throw new Error("project fixture missing");
    return project;
  }

  async function insertAgent(projectId: string) {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("reg"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `conversation-scope-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("contract fixture missing");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: "project-owner",
          engine: "claude_code",
          model: {},
          contractItemId: contract.id,
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent fixture missing");
    return agent;
  }
});
