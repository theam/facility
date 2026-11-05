import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { newId } from "@facility/core";
import {
  githubPullRequests,
  migrate,
  projectRepositories,
  seed,
  stories,
  storyConversations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyMessages,
  storyPlanRevisions,
  storyPlanStates,
  turnEvents,
  turns,
} from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ProjectAttentionService } from "../src/insights/project-attention.js";
import { ProjectBacklogService } from "../src/stories/backlog.js";
import { readStoryDelivery } from "../src/stories/delivery.js";
import { storyPlanDigest } from "../src/stories/plan-state.js";
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
    expect(tools.tools).toHaveLength(49);
    expect(tools.tools.map((tool) => tool.name)).toContain("facility_start_story");
    expect(tools.tools.map((tool) => tool.name)).toContain("facility_list_skills");
    for (const name of [
      "facility_prepare_file_upload",
      "facility_list_input_files",
      "facility_remove_input_file",
      "facility_get_workflow_policy",
      "facility_get_story_workflow",
      "facility_get_delivery_acceptance",
      "facility_request_delivery_acceptance",
      "facility_get_plan",
      "facility_get_story_activity",
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
  it("reads a burst of run activity through authenticated MCP and rejects a mixed cursor", async () => {
    const [original] = await app.facilityDb.select().from(stories).where(eq(stories.id, storyId));
    if (!original) throw Error("Missing story fixture");
    const id = newId("story"),
      conversationId = newId("sess"),
      turnId = newId("turn");
    const scope = { orgId: original.orgId, projectId, storyId: id };
    await app.facilityDb.insert(stories).values({ ...original, id, externalId: id });
    await app.facilityDb
      .insert(storyConversations)
      .values({ ...scope, id: conversationId, nextSeq: 1 });
    await app.facilityDb.insert(turns).values({
      ...scope,
      id: turnId,
      conversationId,
      agentName: "reviewer",
      manifestHash: "fixture",
      manifest: {},
      engine: "codex",
      model: "fixture",
      state: "running",
      triggerType: "ui",
      createdBy: original.createdBy,
    });
    await app.facilityDb.insert(turnEvents).values(
      Array.from({ length: 13 }, (_, i) => ({
        ...scope,
        turnId,
        seq: i + 1,
        type: "engine.item.completed",
        data: { item: { type: "agent_message", text: `Progress ${i + 1}` } },
      })),
    );
    const seen: number[] = [];
    let after = 0;
    for (let n = 0; n < 4; n++) {
      const result = await client.callTool({
        name: "facility_get_story_activity",
        arguments: { projectId, storyId: id, turnId, after, limit: 5 },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text;
      const page = JSON.parse(text ?? "{}");
      expect(page.order).toBe("asc");
      seen.push(...page.items.map((item: { seq: number }) => item.seq));
      if (!page.has_more) break;
      after = page.next_cursor;
    }
    expect(seen).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    const raw = await client.callTool({
      name: "facility_get_story_activity",
      arguments: { projectId, storyId: id, turnId, eventSeq: 2 },
    });
    expect(raw.isError).not.toBe(true);
    const rawText = (raw.content as Array<{ text?: string }>)[0]?.text;
    expect(JSON.parse(rawText ?? "{}")).toMatchObject({
      seq: 2,
      data: { item: { text: "Progress 2" } },
    });
    const absent = await client.callTool({
      name: "facility_get_story_activity",
      arguments: { projectId, storyId: id, turnId, eventSeq: 999 },
    });
    expect(absent.isError).toBe(true);
    const foreignEvent = await client.callTool({
      name: "facility_get_story_activity",
      arguments: { projectId, storyId, turnId, eventSeq: 2 },
    });
    expect(foreignEvent.isError).toBe(true);
    const invalid = await client.callTool({
      name: "facility_get_story_activity",
      arguments: { projectId, storyId: id, turnId, after: 0, before: 5 },
    });
    expect(invalid.isError).toBe(true);
    const wrongStory = await client.callTool({
      name: "facility_get_story_activity",
      arguments: { projectId, storyId, turnId, after: 0 },
    });
    expect(wrongStory.isError).toBe(true);
    const backlog = await client.callTool({
      name: "facility_list_backlog",
      arguments: { projectId, group: "in_progress", sort: "activity", limit: 1 },
    });
    expect(backlog.isError).not.toBe(true);
    const backlogText = (backlog.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    expect(JSON.parse(backlogText ?? "{}")).toMatchObject({
      total: 1,
      groupCounts: { in_progress: 1 },
      items: [
        {
          story: { id },
          activity: { state: "running", agentName: "reviewer" },
          tracking: { group: "in_progress", pendingMessages: 0, wait: null },
        },
      ],
    });
    const otherGroup = await client.callTool({
      name: "facility_list_backlog",
      arguments: { projectId, group: "waiting", sort: "activity" },
    });
    expect(otherGroup.isError).not.toBe(true);
    const otherText = (otherGroup.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    expect(JSON.parse(otherText ?? "{}")).toMatchObject({
      total: 0,
      groupCounts: { in_progress: 1, waiting: 0 },
      items: [],
    });
    const [unchanged] = await app.facilityDb.select().from(turns).where(eq(turns.id, turnId));
    expect(unchanged?.state).toBe("running");
  });

  it("reads the exact source message through the authenticated MCP/API path", async () => {
    const [story] = await app.facilityDb.select().from(stories).where(eq(stories.id, storyId));
    if (!story) throw Error("Missing story fixture");
    const conversationId = newId("sess");
    const messageId = newId("msg");
    const scope = { orgId: story.orgId, projectId, storyId };
    await app.facilityDb
      .insert(storyConversations)
      .values({ ...scope, id: conversationId, nextSeq: 3 });
    await app.facilityDb.insert(storyMessages).values([
      {
        ...scope,
        id: messageId,
        conversationId,
        seq: 1,
        role: "agent",
        body: "Original source scope",
        actor: { type: "system", id: "synthetic-source" },
      },
      {
        ...scope,
        id: newId("msg"),
        conversationId,
        seq: 2,
        role: "agent",
        body: "Newer unrelated response",
        actor: { type: "system", id: "synthetic-source" },
      },
    ]);
    const result = await client.callTool({
      name: "facility_get_conversation",
      arguments: { projectId, storyId, messageId, limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    const page = JSON.parse(text ?? "{}");
    expect(page.focus).toEqual({ messageId, seq: 1 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ id: messageId, body: "Original source scope" });
    expect(text).not.toContain("Newer unrelated response");
  });
  it("reads the identical saved author brief through current and exact-revision MCP requests", async () => {
    const [original] = await app.facilityDb.select().from(stories).where(eq(stories.id, storyId));
    if (!original) throw Error("Missing story fixture");
    const id = newId("story");
    await app.facilityDb.insert(stories).values({ ...original, id, externalId: id });
    const brief = JSON.parse(
      readFileSync(
        new URL("../../../packages/core/test/fixtures/decision-brief.json", import.meta.url),
        "utf8",
      ),
    );
    const markdown = `# Plan\n\n\`\`\`facility-decision\n${JSON.stringify(brief)}\n\`\`\``;
    const scope = { orgId: original.orgId, projectId, storyId: id };
    const input = {
      markdown,
      repositories: [{ repositoryId: "repo-fixture", repository: "example/app" }],
      agents: [
        {
          name: "planner",
          manifestHash: "a".repeat(64),
          engine: "codex" as const,
          model: "fixture",
          repositoryId: "repo-fixture",
          catalogCommitSha: "b".repeat(40),
          observedAt: "2026-11-05T10:00:00Z",
        },
      ],
      sourceMessageId: null,
    };
    const digest = storyPlanDigest(scope, input);
    await app.facilityDb.insert(storyPlanRevisions).values({
      ...scope,
      ...input,
      revision: 1,
      digest,
      proposedBy: { type: "service", id: "fixture-service", name: "Synthetic fixture" },
      source: null,
    });
    await app.facilityDb.insert(storyPlanStates).values({ ...scope, revision: 1 });
    for (const revision of [undefined, 1]) {
      const result = await client.callTool({
        name: "facility_get_plan",
        arguments: { projectId, storyId: id, ...(revision ? { revision } : {}) },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (part) => part.type === "text",
      )?.text;
      const payload = JSON.parse(text ?? "{}");
      expect(revision ? payload : payload.plan).toMatchObject({
        revision: 1,
        digest,
        markdown,
        decisionBrief: { status: "available", brief },
      });
    }
    const grouped = await client.callTool({
      name: "facility_list_attention_stories",
      arguments: { projectId, category: "plans" },
    });
    expect(grouped.isError).not.toBe(true);
    const groupedText = (grouped.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    const groupedPage = JSON.parse(groupedText ?? "{}");
    expect(groupedPage.budget).toMatchObject({ available: true, state: "not_configured" });
    expect(groupedPage.counts.deliveries).toBe(0);
    expect(groupedPage.otherPullRequests).toEqual({ total: 0, limit: 10, offset: 0, items: [] });
    expect(groupedPage.workflowPolicy).toEqual({ available: true, error: null });
    expect(
      groupedPage.items.find((item: { storyId: string }) => item.storyId === id)?.plan,
    ).toMatchObject({ revision: 1, digest, decisionBrief: { status: "available", brief } });
  });
  it("pages other open PRs through the same projection as HTTP without changing story pages", async () => {
    const [original] = await app.facilityDb.select().from(stories).where(eq(stories.id, storyId));
    if (!original) throw Error("Missing story fixture");
    const repositoryId = newId("repo");
    const scope = { orgId: original.orgId, projectId };
    await app.facilityDb.insert(projectRepositories).values({
      id: repositoryId,
      ...scope,
      owner: "example",
      name: `mcp-${repositoryId}`,
      defaultBranch: "main",
    });
    await app.facilityDb.insert(githubPullRequests).values(
      [1, 2, 3].map((number) => ({
        id: newId("ghp"),
        ...scope,
        repositoryId,
        number,
        title: `Other change ${number}`,
        state: "open",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "main",
        htmlUrl: `https://github.com/example/app/pull/${number}`,
        githubUpdatedAt: new Date(`2026-11-0${number}T10:00:00Z`),
      })),
    );
    const result = await client.callTool({
      name: "facility_list_attention_stories",
      arguments: { projectId, category: "pulls", limit: 1, offset: 2, pullOffset: 1 },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    const actual = JSON.parse(text ?? "{}");
    const expected = await new ProjectAttentionService(app.facilityDb).listStories(
      scope.orgId,
      projectId,
      { category: "pulls", limit: 1, offset: 2, pullOffset: 1 },
    );
    expect(actual.otherPullRequests).toEqual(
      JSON.parse(JSON.stringify(expected.otherPullRequests)),
    );
    expect(actual.otherPullRequests.total).toBe(3);
    expect(actual.otherPullRequests.items[0].number).toBe(2);
    expect(actual.items).toEqual([]);

    const manual = newId("story");
    await app.facilityDb.insert(stories).values({ ...original, id: manual, externalId: manual });
    await app.facilityDb.insert(storyDeliveryPullRequests).values([
      { ...scope, storyId: manual, repositoryId, pullNumber: 1, required: true, isPrimary: true },
      { ...scope, storyId: manual, repositoryId, pullNumber: 2, required: false },
    ]);
    for (const repository of [[repositoryId], [`example/mcp-${repositoryId}`], ["foreign-repo"]]) {
      const query = { repository, limit: 2, sort: "activity" as const };
      const response = await client.callTool({
        name: "facility_list_backlog",
        arguments: { projectId, ...query },
      });
      expect(response.isError).not.toBe(true);
      const payload = (response.content as Array<{ type: string; text?: string }>).find(
        (part) => part.type === "text",
      )?.text;
      const actualBacklog = JSON.parse(payload ?? "{}");
      const expectedBacklog = await new ProjectBacklogService(app.facilityDb).list(
        scope.orgId,
        projectId,
        query,
      );
      expect(actualBacklog.items.map((item: { key: string }) => item.key)).toEqual(
        expectedBacklog.items.map((item) => item.key),
      );
      expect(actualBacklog.counts).toEqual(expectedBacklog.counts);
      expect(actualBacklog.groupCounts).toEqual(expectedBacklog.groupCounts);
      expect(actualBacklog.facets.repositories).toContainEqual({
        id: repositoryId,
        name: `example/mcp-${repositoryId}`,
        count: 4,
      });
      expect(actualBacklog.total).toBe(repository[0] === "foreign-repo" ? 0 : 4);
    }
  });
  it("reads the same delivery brief through authenticated MCP and Attention, including optional head drift", async () => {
    const [original] = await app.facilityDb.select().from(stories).where(eq(stories.id, storyId));
    if (!original) throw Error("Missing story");
    const id = newId("story"),
      repositoryId = newId("repo"),
      conversationId = newId("sess"),
      turnId = newId("turn"),
      messageId = newId("msg");
    const scope = { orgId: original.orgId, projectId, storyId: id };
    await app.facilityDb.insert(stories).values({ ...original, id, externalId: id });
    await app.facilityDb.insert(projectRepositories).values({
      id: repositoryId,
      orgId: scope.orgId,
      projectId,
      owner: "example",
      name: repositoryId,
      defaultBranch: "main",
    });
    await app.facilityDb.insert(githubPullRequests).values(
      [1, 2].map((number) => ({
        id: newId("ghp"),
        orgId: scope.orgId,
        projectId,
        repositoryId,
        number,
        title: "Reviewed delivery",
        state: "open",
        headRef: "feature",
        headSha: "b".repeat(40),
        baseRef: "main",
        htmlUrl: `https://github.com/example/app/pull/${number}`,
      })),
    );
    await app.facilityDb.insert(storyDeliveryScopes).values({
      ...scope,
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "user", id: "synthetic" },
    });
    await app.facilityDb.insert(storyDeliveryPullRequests).values(
      [1, 2].map((pullNumber) => ({
        ...scope,
        repositoryId,
        pullNumber,
        required: pullNumber === 1,
        isPrimary: pullNumber === 1,
      })),
    );
    const delivery = await readStoryDelivery(app.facilityDb, scope);
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/core/test/fixtures/delivery-decision-brief.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const envelope = {
      ...fixture,
      subject: {
        scopeRevision: 1,
        candidateRevision: delivery.candidate.revision,
        pullRequests: delivery.pullRequests.map(
          ({ repositoryId, number, headSha, required, primary }) => ({
            repositoryId,
            number,
            headSha,
            required,
            primary,
          }),
        ),
      },
    };
    await app.facilityDb
      .insert(storyConversations)
      .values({ ...scope, id: conversationId, nextSeq: 2 });
    await app.facilityDb.insert(turns).values({
      ...scope,
      id: turnId,
      conversationId,
      agentName: "qa-custom",
      manifestHash: "fixture",
      manifest: {},
      engine: "codex",
      model: "fixture",
      state: "succeeded",
      triggerType: "ui",
      createdBy: original.createdBy,
    });
    await app.facilityDb.insert(storyMessages).values({
      ...scope,
      id: messageId,
      conversationId,
      turnId,
      seq: 1,
      role: "agent",
      actor: { type: "system", id: "fixture" },
      body: `\`\`\`facility-delivery\n${JSON.stringify(envelope)}\n\`\`\``,
      metadata: { content: "final_response", deliveryDecisionBrief: 1 },
    });
    async function call(name: string, args: object) {
      const result = await client.callTool({ name, arguments: { projectId, ...args } });
      expect(result.isError).not.toBe(true);
      return JSON.parse(
        (result.content as Array<{ type: string; text?: string }>).find(
          (part) => part.type === "text",
        )?.text ?? "{}",
      );
    }
    const expected = (await readStoryDelivery(app.facilityDb, scope)).decisionBrief;
    expect(expected).toMatchObject({
      status: "available",
      source: { messageId, turn: { agentName: "qa-custom" } },
    });
    expect((await call("facility_get_delivery", { storyId: id })).decisionBrief).toEqual(expected);
    const attention = await call("facility_list_attention_stories", {
      category: "deliveries",
      limit: 25,
    });
    expect(
      attention.items.find((item: { storyId: string }) => item.storyId === id)?.delivery
        .decisionBrief,
    ).toEqual(expected);
    await app.facilityDb
      .update(githubPullRequests)
      .set({ headSha: "c".repeat(40) })
      .where(
        and(eq(githubPullRequests.repositoryId, repositoryId), eq(githubPullRequests.number, 2)),
      );
    expect((await call("facility_get_delivery", { storyId: id })).decisionBrief).toMatchObject({
      status: "stale",
      reason: "heads_changed",
      source: { messageId },
    });
    const [unchanged] = await app.facilityDb.select().from(turns).where(eq(turns.id, turnId));
    expect(unchanged?.state).toBe("succeeded");
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
          execution: {
            observedAt: expect.any(String),
            decision: null,
            turns: [],
            hasMore: false,
            unavailable: false,
          },
          executionScope: {
            observedAt: expect.any(String),
            planRevision: 0,
            queuedWork: [],
            hasMore: false,
          },
        });
    }
  });
});
