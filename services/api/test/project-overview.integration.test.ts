import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  attentionItems,
  createDb,
  githubInstallations,
  githubIssues,
  githubPullRequests,
  migrate,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  turns,
  turnUsage,
  workspaces,
} from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CostBudgetService } from "../src/insights/costs.js";
import { ProjectOverviewService } from "../src/insights/project-overview.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const now = new Date("2026-09-10T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("project overview", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; project overview tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = "org_local";
  const projectId = newId("proj");
  const siblingProjectId = newId("proj");
  const otherOrgId = newId("org");
  const otherProjectId = newId("proj");
  const repositoryId = newId("repo");
  const otherRepositoryId = newId("repo");
  const service = new ProjectOverviewService(db, new CostBudgetService(db));
  const fullAccess = { costs: true, budgets: true };
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const app = await buildApp(config, { rateLimitMax: 10_000 });
  let ownerCookie = "";
  let readerSecret = "";
  const ids = {
    runningStory: newId("story"),
    runningTurn: newId("turn"),
    queuedStory: newId("story"),
    queuedTurn: newId("turn"),
    waitingStory: newId("story"),
    waitingAttention: newId("attn"),
    failedStory: newId("story"),
    failedTurn: newId("turn"),
    failedAttention: newId("attn"),
    resolvedAttention: newId("attn"),
    reviewStory: newId("story"),
    reviewTurn: newId("turn"),
    unpricedTurn: newId("turn"),
    readyStory: newId("story"),
    doneStory: newId("story"),
    deletedStory: newId("story"),
    storyOnlyPull: newId("story"),
    siblingStory: newId("story"),
    otherStory: newId("story"),
  };

  async function story(input: {
    id: string;
    orgId?: string;
    projectId?: string;
    repositoryId?: string | null;
    title: string;
    status: string;
    provider?: "github" | "manual";
    externalId?: string;
    activeAgentName?: string | null;
    pullRequestNumber?: number | null;
    pullRequestUrl?: string | null;
    branch?: string | null;
    updatedAt?: Date;
    deletedAt?: Date | null;
  }) {
    const scope = { orgId: input.orgId ?? orgId, projectId: input.projectId ?? projectId };
    await db.insert(stories).values({
      id: input.id,
      ...scope,
      repositoryId: input.repositoryId === undefined ? repositoryId : input.repositoryId,
      provider: input.provider ?? "manual",
      externalId: input.externalId ?? `manual:${input.id}`,
      title: input.title,
      status: input.status,
      activeAgentName: input.activeAgentName ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestUrl: input.pullRequestUrl ?? null,
      branch: input.branch ?? null,
      createdBy: { type: "user", id: "user_test" },
      updatedAt: input.updatedAt ?? now,
      deletedAt: input.deletedAt ?? null,
    });
    const conversationId = newId("sess");
    await db.insert(storyConversations).values({ id: conversationId, ...scope, storyId: input.id });
    return { conversationId, ...scope };
  }

  async function turn(input: {
    id: string;
    storyId: string;
    conversationId: string;
    orgId: string;
    projectId: string;
    agentName?: string;
    state: string;
    triggerType?: string;
    createdAt?: Date;
    startedAt?: Date | null;
    endedAt?: Date | null;
    scheduledFor?: Date | null;
    error?: string | null;
  }) {
    await db.insert(turns).values({
      id: input.id,
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      conversationId: input.conversationId,
      agentName: input.agentName ?? "builder",
      manifestHash: "hash",
      manifest: {},
      engine: "codex",
      model: "gpt-5.5",
      state: input.state,
      triggerType: input.triggerType ?? "ui",
      createdAt: input.createdAt ?? now,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      scheduledFor: input.scheduledFor ?? null,
      error: input.error ?? null,
      createdBy: { type: "user", id: "user_test" },
    });
  }

  async function usage(input: {
    turnId: string;
    storyId: string;
    agentName: string;
    priced: boolean;
    costCents: number | null;
    createdAt: Date;
    orgId?: string;
    projectId?: string;
  }) {
    await db.insert(turnUsage).values({
      id: newId("evt"),
      orgId: input.orgId ?? orgId,
      projectId: input.projectId ?? projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      agentName: input.agentName,
      engine: "codex",
      model: "gpt-5.5",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: input.costCents,
      priced: input.priced,
      source: input.priced ? "price_book" : "unpriced",
      durationMs: 1000,
      status: "succeeded",
      createdAt: input.createdAt,
    });
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Other tenant",
      slug: `other-tenant-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Overview", slug: `overview-${suffix}`, settings: {} },
      { id: siblingProjectId, orgId, name: "Sibling", slug: `sibling-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other project",
        slug: `other-project-${suffix}`,
        settings: {},
      },
    ]);
    const installationId = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 20_000,
      accountId: 123,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: repositoryId,
        orgId,
        projectId,
        installationId,
        owner: "acme",
        name: `app-${suffix}`,
        defaultBranch: "main",
        role: "primary",
      },
      {
        id: otherRepositoryId,
        orgId: otherOrgId,
        projectId: otherProjectId,
        owner: "elsewhere",
        name: `app-${suffix}`,
        defaultBranch: "main",
        role: "primary",
      },
    ]);

    // A story whose agent is executing right now.
    const running = await story({
      id: ids.runningStory,
      title: "Running story",
      status: "working",
      activeAgentName: "builder",
      updatedAt: minutesAgo(5),
    });
    await turn({
      ...running,
      id: ids.runningTurn,
      storyId: ids.runningStory,
      state: "running",
      createdAt: minutesAgo(12),
      startedAt: minutesAgo(10),
    });
    await db.insert(workspaces).values({
      id: newId("ws"),
      orgId,
      projectId,
      storyId: ids.runningStory,
      provider: "fake",
      volumeRef: "memory://running",
      state: "running",
      lastActivityAt: minutesAgo(1),
    });

    // A story with a queued turn: work is waiting, not executing.
    const queued = await story({
      id: ids.queuedStory,
      title: "Queued story",
      status: "working",
      activeAgentName: "architect",
      updatedAt: minutesAgo(6),
    });
    await turn({
      ...queued,
      id: ids.queuedTurn,
      storyId: ids.queuedStory,
      agentName: "architect",
      state: "queued",
      triggerType: "schedule",
      createdAt: minutesAgo(3),
      scheduledFor: minutesAgo(-30),
    });

    // The agent asked a question: open attention that needs a reply.
    await story({
      id: ids.waitingStory,
      title: "Waiting story",
      status: "attention",
      updatedAt: minutesAgo(20),
    });
    await db.insert(attentionItems).values({
      id: ids.waitingAttention,
      orgId,
      projectId,
      storyId: ids.waitingStory,
      kind: "agent_waiting",
      title: "builder needs a reply",
      detail: "Which database should the migration target?",
      status: "open",
      createdAt: minutesAgo(20),
    });

    // A failed turn with an open retryable notice and an older dismissed one.
    const failed = await story({
      id: ids.failedStory,
      title: "Failed story",
      status: "attention",
      updatedAt: minutesAgo(40),
    });
    await turn({
      ...failed,
      id: ids.failedTurn,
      storyId: ids.failedStory,
      state: "failed",
      createdAt: minutesAgo(60),
      startedAt: minutesAgo(55),
      endedAt: minutesAgo(40),
      error: "Error: fetch failed while cloning",
    });
    await db.insert(attentionItems).values([
      {
        id: ids.failedAttention,
        orgId,
        projectId,
        storyId: ids.failedStory,
        turnId: ids.failedTurn,
        kind: "turn_error",
        title: "builder failed",
        detail: "Error: fetch failed while cloning",
        status: "open",
        createdAt: minutesAgo(40),
      },
      {
        id: ids.resolvedAttention,
        orgId,
        projectId,
        storyId: ids.failedStory,
        kind: "turn_error",
        title: "Old failure",
        detail: "resolved long ago",
        status: "resolved",
        resolution: "dismissed",
        createdAt: minutesAgo(600),
      },
    ]);
    await db.insert(workspaces).values({
      id: newId("ws"),
      orgId,
      projectId,
      storyId: ids.failedStory,
      provider: "fake",
      volumeRef: "memory://failed",
      state: "sleeping",
      lastActivityAt: minutesAgo(40),
    });

    // A delivered story: succeeded turn, open pull request in the mirror with failing checks.
    const review = await story({
      id: ids.reviewStory,
      title: "Review story",
      status: "working",
      provider: "github",
      externalId: "issue:17",
      branch: "facility/review",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/app/pull/42",
      updatedAt: minutesAgo(90),
    });
    await turn({
      ...review,
      id: ids.reviewTurn,
      storyId: ids.reviewStory,
      state: "succeeded",
      createdAt: minutesAgo(130),
      startedAt: minutesAgo(125),
      endedAt: minutesAgo(90),
    });
    await turn({
      ...review,
      id: ids.unpricedTurn,
      storyId: ids.reviewStory,
      agentName: "reviewer",
      state: "succeeded",
      createdAt: minutesAgo(200),
      startedAt: minutesAgo(199),
      endedAt: minutesAgo(190),
    });
    await db.insert(githubPullRequests).values([
      {
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId,
        number: 42,
        title: "Implement review story",
        state: "open",
        headRef: "facility/review",
        headSha: "a".repeat(40),
        baseRef: "main",
        htmlUrl: "https://github.com/acme/app/pull/42",
        ciState: "failure",
        ciFailureNames: ["verify"],
        githubUpdatedAt: minutesAgo(80),
      },
      {
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId,
        number: 43,
        title: "Human-authored change",
        state: "open",
        headRef: "human/change",
        headSha: "b".repeat(40),
        baseRef: "main",
        htmlUrl: "https://github.com/acme/app/pull/43",
        ciState: "success",
        githubUpdatedAt: minutesAgo(10),
      },
      {
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId,
        number: 44,
        title: "Already merged",
        state: "merged",
        headRef: "facility/merged",
        headSha: "c".repeat(40),
        baseRef: "main",
        htmlUrl: "https://github.com/acme/app/pull/44",
        ciState: "success",
        mergedAt: minutesAgo(300),
        githubUpdatedAt: minutesAgo(300),
      },
    ]);
    await db.insert(githubIssues).values([
      {
        id: newId("iss"),
        orgId,
        projectId,
        repositoryId,
        number: 17,
        title: "Review story issue",
        state: "open",
        htmlUrl: "https://github.com/acme/app/issues/17",
      },
      {
        id: newId("iss"),
        orgId,
        projectId,
        repositoryId,
        number: 18,
        title: "Untouched backlog issue",
        state: "open",
        htmlUrl: "https://github.com/acme/app/issues/18",
      },
      {
        id: newId("iss"),
        orgId,
        projectId,
        repositoryId,
        number: 19,
        title: "Closed issue",
        state: "closed",
        htmlUrl: "https://github.com/acme/app/issues/19",
      },
    ]);
    // A story that recorded a pull request the mirror does not know about.
    await story({
      id: ids.storyOnlyPull,
      title: "Story-only pull request",
      status: "review",
      repositoryId: null,
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/acme/other/pull/7",
      updatedAt: minutesAgo(15),
    });

    await story({
      id: ids.readyStory,
      title: "Ready story",
      status: "ready",
      updatedAt: minutesAgo(400),
    });
    await story({
      id: ids.doneStory,
      title: "Done story",
      status: "done",
      pullRequestNumber: 44,
      pullRequestUrl: "https://github.com/acme/app/pull/44",
      updatedAt: minutesAgo(300),
    });
    await story({
      id: ids.deletedStory,
      title: "Deleted story",
      status: "ready",
      updatedAt: minutesAgo(1),
      deletedAt: minutesAgo(1),
    });

    // Spend: two priced turns this month, one unpriced, one turn without any usage row.
    await usage({
      turnId: ids.reviewTurn,
      storyId: ids.reviewStory,
      agentName: "builder",
      priced: true,
      costCents: 250,
      createdAt: minutesAgo(90),
    });
    await usage({
      turnId: ids.failedTurn,
      storyId: ids.failedStory,
      agentName: "builder",
      priced: true,
      costCents: 50,
      createdAt: new Date("2026-09-01T00:30:00Z"),
    });
    await usage({
      turnId: ids.unpricedTurn,
      storyId: ids.reviewStory,
      agentName: "reviewer",
      priced: false,
      costCents: null,
      createdAt: minutesAgo(190),
    });
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId,
      monthlyLimitCents: 1_000,
      warningPercent: 25,
      enabled: true,
      updatedBy: "user_test",
    });

    // Sibling project in the same org and a project in another org: never visible.
    const sibling = await story({
      id: ids.siblingStory,
      projectId: siblingProjectId,
      repositoryId: null,
      title: "Sibling running",
      status: "working",
    });
    await turn({
      ...sibling,
      id: newId("turn"),
      storyId: ids.siblingStory,
      state: "running",
      startedAt: minutesAgo(1),
    });
    const other = await story({
      id: ids.otherStory,
      orgId: otherOrgId,
      projectId: otherProjectId,
      repositoryId: null,
      title: "Other tenant running",
      status: "working",
    });
    await turn({
      ...other,
      id: newId("turn"),
      storyId: ids.otherStory,
      state: "running",
      startedAt: minutesAgo(1),
    });
    await db.insert(attentionItems).values({
      id: newId("attn"),
      orgId: otherOrgId,
      projectId: otherProjectId,
      storyId: ids.otherStory,
      kind: "agent_waiting",
      title: "Other tenant question",
      status: "open",
    });

    const readerRole = newId("role");
    await db.insert(roles).values({
      id: readerRole,
      orgId,
      name: `overview-reader-${suffix}`,
      permissions: ["projects:read"],
    });
    const reader = await generateApiKey("fak");
    readerSecret = reader.secret;
    await db.insert(apiKeys).values({
      id: reader.id,
      orgId,
      name: "overview reader",
      prefix: reader.lookup,
      last4: reader.last4,
      hash: reader.hash,
      scopeType: "project",
      projectId,
      roleId: readerRole,
    });
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    ownerCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("separates executing agents from queued work and open stories without an agent", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.activity.running.map((turn) => turn.storyId)).toEqual([ids.runningStory]);
    expect(overview.activity.running[0]).toMatchObject({
      agentName: "builder",
      state: "running",
      storyTitle: "Running story",
      storyStatus: "working",
    });
    expect(overview.activity.queued.map((turn) => turn.storyId)).toEqual([ids.queuedStory]);
    expect(overview.activity.queued[0]).toMatchObject({
      agentName: "architect",
      triggerType: "schedule",
      startedAt: null,
    });
    // Attention and review stories are open but nothing executes for them.
    const activeStoryIds = [...overview.activity.running, ...overview.activity.queued].map(
      (turn) => turn.storyId,
    );
    expect(activeStoryIds).not.toContain(ids.waitingStory);
    expect(activeStoryIds).not.toContain(ids.reviewStory);
    expect(activeStoryIds).not.toContain(ids.readyStory);
  });

  it("lists only open attention with the action each item accepts", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.attention.openCount).toBe(2);
    expect(overview.attention.items.map((item) => [item.id, item.action])).toEqual([
      [ids.waitingAttention, "reply"],
      [ids.failedAttention, "retry"],
    ]);
    expect(overview.attention.items.map((item) => item.id)).not.toContain(ids.resolvedAttention);
    expect(overview.attention.items[0]).toMatchObject({
      storyTitle: "Waiting story",
      kind: "agent_waiting",
      detail: "Which database should the migration target?",
    });
  });

  it("puts failing pull requests first, links them to stories, and keeps merged ones out", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.review.total).toBe(3);
    expect(overview.review.items.map((item) => item.pullRequest.number)).toEqual([42, 43, 7]);
    expect(overview.review.items[0]).toMatchObject({
      source: "mirror",
      storyId: ids.reviewStory,
      storyTitle: "Review story",
      pullRequest: {
        repository: `acme/app-${suffix}`,
        ciState: "failure",
        ciFailureNames: ["verify"],
        url: "https://github.com/acme/app/pull/42",
      },
    });
    expect(overview.review.items[1]).toMatchObject({ storyId: null, pullRequest: { number: 43 } });
    expect(overview.review.items[2]).toMatchObject({
      source: "story",
      storyId: ids.storyOnlyPull,
      pullRequest: { number: 7, ciState: null },
    });
  });

  it("orders recent results by completion and carries the delivery link and error", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.recent.items.map((item) => item.turnId)).toEqual([
      ids.failedTurn,
      ids.reviewTurn,
      ids.unpricedTurn,
    ]);
    expect(overview.recent.items[0]).toMatchObject({
      state: "failed",
      error: "Error: fetch failed while cloning",
      durationMs: 15 * 60_000,
      pullRequest: null,
    });
    expect(overview.recent.items[1]).toMatchObject({
      state: "succeeded",
      storyTitle: "Review story",
      pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
    });
  });

  it("summarizes the backlog without deleted stories and counts issues without a story", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.backlog.ready.map((story) => story.storyId)).toEqual([ids.readyStory]);
    expect(overview.backlog.counts).toEqual({
      ready: 1,
      working: 3,
      attention: 2,
      review: 1,
      done: 1,
      archived: 0,
    });
    expect(overview.backlog.openIssues).toBe(2);
    expect(overview.backlog.openIssuesWithoutStory).toBe(1);
  });

  it("reports recorded environment states without inspecting providers", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    expect(overview.environments).toMatchObject({
      retained: 2,
      recorded: { running: 1, sleeping: 1, creating: 0, error: 0, deleting: 0 },
    });
    expect(overview.environments.lastActivityAt?.toISOString()).toBe(minutesAgo(1).toISOString());
  });

  it("distinguishes priced, unpriced and unmeasured agent spend in the budget window", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    if (!overview.spend.agents.available) throw new Error("spend must be available");
    expect(overview.spend.agents.month).toMatchObject({
      turns: 3,
      pricedTurns: 2,
      unpricedTurns: 1,
      unmeasuredTurns: 0,
      costCents: 300,
    });
    expect(overview.spend.agents.month.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(overview.spend.agents.lastSevenDays).toMatchObject({
      turns: 2,
      pricedTurns: 1,
      unpricedTurns: 1,
      costCents: 250,
    });
    expect(overview.spend.agents.byAgent).toEqual([
      { agentName: "builder", turns: 2, unpricedTurns: 0, costCents: 300 },
      { agentName: "reviewer", turns: 1, unpricedTurns: 1, costCents: 0 },
    ]);
    if (!overview.spend.budget.available) throw new Error("budget must be available");
    expect(overview.spend.budget).toMatchObject({
      state: "warning",
      monthlyLimitCents: 1_000,
      spentCents: 300,
    });
  });

  it("reports a real zero for a project without any agent turns", async () => {
    const overview = await service.overview(orgId, siblingProjectId, fullAccess, now);
    if (!overview.spend.agents.available) throw new Error("spend must be available");
    expect(overview.spend.agents.month).toMatchObject({
      turns: 0,
      costCents: 0,
      unmeasuredTurns: 0,
    });
    expect(overview.spend.budget).toMatchObject({ available: true, state: "not_configured" });
    expect(overview.activity.running).toHaveLength(1);
    expect(overview.activity.running[0]?.storyTitle).toBe("Sibling running");
  });

  it("never mixes sibling projects or other tenants into the overview", async () => {
    const overview = await service.overview(orgId, projectId, fullAccess, now);
    const titles = [
      ...overview.activity.running,
      ...overview.activity.queued,
      ...overview.attention.items,
      ...overview.recent.items,
    ].map((item) => item.storyTitle);
    expect(titles).not.toContain("Sibling running");
    expect(titles).not.toContain("Other tenant running");
    expect(overview.attention.items.map((item) => item.title)).not.toContain(
      "Other tenant question",
    );
    const other = await service.overview(otherOrgId, otherProjectId, fullAccess, now);
    expect(other.activity.running.map((turn) => turn.storyTitle)).toEqual(["Other tenant running"]);
    expect(other.attention.openCount).toBe(1);
    expect(other.review.items).toHaveLength(0);
  });

  it("serves the overview over HTTP with project scoping and permission-gated spend", async () => {
    const owner = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/overview`,
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.headers["cache-control"]).toBe("no-store");
    const body = owner.json();
    expect(body.activity.running).toHaveLength(1);
    expect(body.spend.agents.available).toBe(true);
    expect(body.spend.budget.available).toBe(true);
    expect(typeof body.generatedAt).toBe("string");

    const reader = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/overview`,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().attention.openCount).toBe(2);
    expect(reader.json().spend).toEqual({
      agents: { available: false, reason: "permission" },
      budget: { available: false, reason: "permission" },
    });

    const scoped = await app.inject({
      method: "GET",
      url: `/v1/projects/${siblingProjectId}/overview`,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(scoped.statusCode).toBe(404);
    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/overview`,
      headers: { cookie: ownerCookie },
    });
    expect(crossTenant.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/overview`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
