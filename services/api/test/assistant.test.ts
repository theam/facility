import { newId } from "@facility/core";
import {
  agentDefs,
  conversationMessages,
  conversations,
  createDb,
  migrate,
  projects,
  registryItems,
  runs,
  seed,
  virtualKeys,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AssistantModelDriver, AssistantModelTurn } from "../src/assistant/loop.js";
import { ASSISTANT_TOOLS } from "../src/assistant/tools.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
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

function textTurn(text: string): AssistantModelTurn {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  } as unknown as AssistantModelTurn;
}

function toolTurn(name: string, input: Record<string, unknown>): AssistantModelTurn {
  return {
    content: [{ type: "tool_use", id: `toolu_${Date.now()}`, name, input }],
    stopReason: "tool_use",
  } as unknown as AssistantModelTurn;
}

describe("assistant ask endpoint", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; assistant tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4406,
    publicUrl: "http://localhost:4406",
    sandboxApiUrl: "http://localhost:4406",
    sandboxGatewayUrl: "http://localhost:4410",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  const orgId = "org_dev_the_agile_monkeys";
  let cookie = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: "assistant-tester@example.test" },
    });
    const setCookie = login.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = raw?.split(";")[0] ?? "";
    expect(cookie).toContain("facility_session=");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("forwards repository identity through issue read and update tools", () => {
    const getIssue = ASSISTANT_TOOLS.find((tool) => tool.name === "get_issue");
    const proposeUpdate = ASSISTANT_TOOLS.find((tool) => tool.name === "propose_issue_update");
    expect(getIssue?.inputSchema).toMatchObject({
      properties: { number: { type: "integer" }, repoId: { type: "string" } },
      required: ["number"],
      additionalProperties: false,
    });
    expect(
      getIssue?.toRequest({ number: 7, repoId: "repo_two" }, { projectId: "project" }),
    ).toMatchObject({
      path: "/v1/projects/project/issues/7",
      query: { repoId: "repo_two" },
    });
    expect(
      proposeUpdate?.toRequest(
        { issueNumber: 7, repoId: "repo_two", title: "Title", bodyMd: "Body", reason: "S001" },
        { projectId: "project" },
      ).body,
    ).toMatchObject({ payload: { issueNumber: 7, repoId: "repo_two" } });
  });

  it("rejects unauthenticated asks", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${newId("proj")}/ask`,
      payload: { body: "hello" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s an unknown project", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${newId("proj")}/ask`,
      headers: { cookie },
      payload: { body: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("denies an inline project-owner that also exposes /builder before creating a run", async () => {
    const project = await insertProject("Assistant Builder Alias Guard");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, project.id));
    await insertOwnerAgent(project.id, [{ type: "command", handle: "/builder" }]);
    const before = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.projectId, project.id));

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "attempt the inline bypass" },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "builder_plan_required",
    );
    const after = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, project.id));
    expect(after).toHaveLength(before.length);
  });

  it("runs a stubbed turn end to end: tool call, reply, revoked key, idle thread", async () => {
    const project = await insertProject("Assistant Happy Path");
    await insertOwnerAgent(project.id);
    const calls: string[] = [];
    let step = 0;
    setDriver(async ({ tools, onTextDelta }) => {
      step += 1;
      if (step === 1) {
        expect(tools.map((tool) => tool.name)).toContain("get_pipeline");
        return toolTurn("kb_space", {});
      }
      onTextDelta("The project is ");
      onTextDelta("on track.");
      return textTurn("The project is on track.");
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "how are we doing?" },
    });
    expect(response.statusCode).toBe(200);
    const ask = response.json() as { conversationId: string; runId: string };
    const run = await waitForTerminal(ask.runId);
    expect(run.status).toBe("succeeded");
    expect(calls).toEqual([]);

    // The executor releases the thread AFTER the run turns terminal
    // (finishConversationTurn runs last) — wait for the release too.
    const thread = await waitForIdleThread(ask.conversationId);
    expect(thread?.status).toBe("idle");
    expect(thread?.kind).toBe("assistant");

    const messages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, ask.conversationId))
      .orderBy(conversationMessages.seq);
    expect(messages.at(-1)?.role).toBe("agent");
    expect(messages.at(-1)?.body).toContain("on track");

    const keys = await db.select().from(virtualKeys).where(eq(virtualKeys.runId, ask.runId));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.expiresAt).toBeNull();
    expect(keys[0]?.revokedAt).not.toBeNull();

    const result = await app.inject({
      method: "GET",
      url: `/v1/runs/${ask.runId}/result`,
      headers: { cookie },
    });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { answer: string | null }).answer).toContain("on track");
  });

  it("continues beyond the former tool-iteration cap until the model finishes", async () => {
    const project = await insertProject("Assistant Unbounded Loop");
    await insertOwnerAgent(project.id);
    let primaryCalls = 0;
    setDriver(async ({ tools }) => {
      if (tools.length === 0) return textTurn("Unbounded tool session");
      primaryCalls += 1;
      return primaryCalls <= 13
        ? toolTurn("kb_space", {})
        : textTurn("Finished after thirteen tool rounds.");
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "keep working until done" },
    });
    expect(response.statusCode).toBe(200);
    const ask = response.json() as { conversationId: string; runId: string };
    const run = await waitForTerminal(ask.runId);
    expect(run.status).toBe("succeeded");
    await waitForIdleThread(ask.conversationId);
    expect(primaryCalls).toBe(14);
  });

  it("409s a second ask while a turn is in flight, and heals a stale lock", async () => {
    const project = await insertProject("Assistant Claim");
    await insertOwnerAgent(project.id);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDriver(async () => {
      await gate;
      return textTurn("done waiting");
    });

    const first = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "first" },
    });
    expect(first.statusCode).toBe(200);
    const ask = first.json() as { conversationId: string; runId: string };

    const second = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "second", conversationId: ask.conversationId },
    });
    expect(second.statusCode).toBe(409);

    release?.();
    await waitForTerminal(ask.runId);

    // Stale lock: force running with a terminal pinned run — ask must self-heal.
    await db
      .update(conversations)
      .set({ status: "running" })
      .where(eq(conversations.id, ask.conversationId));
    setDriver(async () => textTurn("healed"));
    const third = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "third", conversationId: ask.conversationId },
    });
    expect(third.statusCode).toBe(200);
    await waitForTerminal((third.json() as { runId: string }).runId);
  });

  it("keeps assistant threads off the sandbox message route", async () => {
    const project = await insertProject("Assistant Route Guard");
    await insertOwnerAgent(project.id);
    setDriver(async () => textTurn("ok"));
    const ask = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/ask`,
      headers: { cookie },
      payload: { body: "seed thread" },
    });
    const { conversationId, runId } = ask.json() as { conversationId: string; runId: string };
    await waitForTerminal(runId);
    const sandboxSend = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { cookie },
      payload: { body: "should be rejected" },
    });
    expect(sandboxSend.statusCode).toBe(409);
    expect((sandboxSend.json() as { error: { code: string } }).error.code).toBe("assistant_thread");
  });

  function setDriver(driver: AssistantModelDriver) {
    (app as unknown as { assistantModelDriver?: AssistantModelDriver }).assistantModelDriver =
      driver;
  }

  async function waitForIdleThread(conversationId: string) {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const row = (
        await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)))
          .limit(1)
      )[0];
      if (row && row.status === "idle") return row;
      if (Date.now() > deadline) {
        throw new Error(`conversation ${conversationId} not released: ${row?.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitForTerminal(runId: string) {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const row = (
        await db
          .select()
          .from(runs)
          .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
          .limit(1)
      )[0];
      if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`run ${runId} did not finish: ${row?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

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

  async function insertOwnerAgent(projectId: string, triggers: unknown[] = []) {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `assistant-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
          model: { model: "claude-sonnet-5" },
          contractItemId: contract.id,
          triggers,
          permissions: ["kb:read", "kb:write", "tasks:read", "tasks:write", "runs:read"],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent fixture missing");
    return agent;
  }
});
