import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  attentionItems,
  createDb,
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
  storyDeliveryPullRequests,
  storyPlanDecisions,
  storyPlanRequests,
  storyPlanRevisions,
  storyPlanStates,
  turns,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ProjectAttentionService } from "../src/insights/project-attention.js";
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

const now = new Date("2026-09-25T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const open = { status: "open" as const, limit: 25, offset: 0 };

describe("project attention list", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; project attention tests skipped", () =>
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
  const service = new ProjectAttentionService(db);
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
  let noReadSecret = "";
  const ids = {
    checkoutStory: newId("story"),
    billingStory: newId("story"),
    billingTurn: newId("turn"),
    waiting: newId("attn"),
    failed: newId("attn"),
    runtime: newId("attn"),
    dismissed: newId("attn"),
  };
  const planStory = newId("story");
  const approvedStory = newId("story");
  const rejectedStory = newId("story");
  const revisedStory = newId("story");
  const brief = JSON.parse(
    readFileSync(
      new URL("../../../packages/core/test/fixtures/decision-brief.json", import.meta.url),
      "utf8",
    ),
  );

  async function plan(storyId: string, revision = 1, scope = { orgId, projectId }) {
    await db.insert(storyPlanRevisions).values({
      ...scope,
      storyId,
      revision,
      digest: String(revision).repeat(64),
      markdown: `# Plan\n\n\`\`\`facility-decision\n${JSON.stringify(brief)}\n\`\`\``,
      repositories: [{ repositoryId: "repo-fixture", repository: "example/app" }],
      agents: [
        {
          name: "planner",
          manifestHash: "a".repeat(64),
          engine: "codex",
          model: "fixture",
          repositoryId: "repo-fixture",
          catalogCommitSha: "b".repeat(40),
          observedAt: now.toISOString(),
        },
      ],
      proposedBy: { type: "service", id: "fixture", name: null },
      proposedAt: minutesAgo(90 - revision),
    });
    if (revision === 1) await db.insert(storyPlanStates).values({ ...scope, storyId, revision });
    else
      await db
        .update(storyPlanStates)
        .set({ revision })
        .where(eq(storyPlanStates.storyId, storyId));
  }

  async function decide(storyId: string, intent: "approve" | "reject") {
    const requestId = newId("dreq");
    const target = {
      orgId,
      projectId,
      storyId,
      planRevision: 1,
      planDigest: "1".repeat(64),
      intent,
      reason: intent === "reject" ? "Reduce scope" : null,
    };
    await db.insert(storyPlanRequests).values({
      ...target,
      id: requestId,
      decisionRevision: 0,
      requestedBy: { type: "user", id: "user_test", name: null },
      requestedAt: minutesAgo(50),
      expiresAt: now,
    });
    await db.insert(storyPlanDecisions).values({
      ...target,
      id: newId("dec"),
      requestId,
      decisionRevision: 1,
      confirmedBy: { type: "user", id: "user_test", name: null },
    });
    await db
      .update(storyPlanStates)
      .set({ decisionRevision: 1 })
      .where(eq(storyPlanStates.storyId, storyId));
  }

  const longDetail = "x".repeat(3_000);

  async function story(input: { id: string; orgId?: string; projectId?: string; title: string }) {
    const scope = { orgId: input.orgId ?? orgId, projectId: input.projectId ?? projectId };
    await db.insert(stories).values({
      id: input.id,
      ...scope,
      provider: "manual",
      externalId: `manual:${input.id}`,
      title: input.title,
      status: "attention",
      createdBy: { type: "user", id: "user_test" },
    });
    const conversationId = newId("sess");
    await db.insert(storyConversations).values({ id: conversationId, ...scope, storyId: input.id });
    return { conversationId, ...scope };
  }

  async function key(name: string, permissions: string[], scopedProjectId: string) {
    const roleId = newId("role");
    await db.insert(roles).values({ id: roleId, orgId, name: `${name}-${suffix}`, permissions });
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      name,
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId: scopedProjectId,
      roleId,
    });
    return generated.secret;
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
      { id: projectId, orgId, name: "Attention", slug: `attention-${suffix}`, settings: {} },
      { id: siblingProjectId, orgId, name: "Sibling", slug: `sibling-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other project",
        slug: `other-project-${suffix}`,
        settings: {},
      },
    ]);

    await story({ id: ids.checkoutStory, title: "Checkout flow" });
    const billing = await story({ id: ids.billingStory, title: "Billing export" });
    await db.insert(turns).values({
      id: ids.billingTurn,
      ...billing,
      storyId: ids.billingStory,
      agentName: "builder",
      manifestHash: "hash",
      manifest: {},
      engine: "codex",
      model: "gpt-5.5",
      state: "failed",
      triggerType: "ui",
      error: "Error: 401 unauthorized",
      createdBy: { type: "user", id: "user_test" },
    });
    await db.insert(attentionItems).values([
      {
        id: ids.waiting,
        orgId,
        projectId,
        storyId: ids.checkoutStory,
        kind: "agent_waiting",
        title: "builder needs a reply",
        detail: "Which database should the migration target?",
        status: "open",
        createdAt: minutesAgo(10),
      },
      {
        id: ids.failed,
        orgId,
        projectId,
        storyId: ids.billingStory,
        turnId: ids.billingTurn,
        kind: "turn_error",
        title: "builder failed",
        detail: "Error: 401 unauthorized (100% of retries used)",
        status: "open",
        createdAt: minutesAgo(30),
      },
      {
        id: ids.runtime,
        orgId,
        projectId,
        storyId: ids.billingStory,
        kind: "runtime_error",
        title: "Environment stopped",
        detail: longDetail,
        status: "open",
        createdAt: minutesAgo(60),
      },
      {
        id: ids.dismissed,
        orgId,
        projectId,
        storyId: ids.checkoutStory,
        kind: "turn_error",
        title: "builder failed earlier",
        detail: "Error: timeout",
        status: "resolved",
        resolution: "dismissed",
        resolvedBy: { type: "user", id: "user_test" },
        resolvedAt: minutesAgo(5),
        createdAt: minutesAgo(120),
      },
    ]);

    // A sibling project in the same org and a project in another org: never visible.
    const siblingStory = newId("story");
    await story({ id: siblingStory, projectId: siblingProjectId, title: "Sibling story" });
    const otherStory = newId("story");
    await story({
      id: otherStory,
      orgId: otherOrgId,
      projectId: otherProjectId,
      title: "Other tenant story",
    });
    await db.insert(attentionItems).values([
      {
        id: newId("attn"),
        orgId,
        projectId: siblingProjectId,
        storyId: siblingStory,
        kind: "agent_waiting",
        title: "Sibling question",
        status: "open",
        createdAt: minutesAgo(1),
      },
      {
        id: newId("attn"),
        orgId: otherOrgId,
        projectId: otherProjectId,
        storyId: otherStory,
        kind: "agent_waiting",
        title: "Other tenant question",
        status: "open",
        createdAt: minutesAgo(1),
      },
    ]);

    for (const [id, title] of [
      [planStory, "Plan without a notice"],
      [approvedStory, "Approved plan"],
      [rejectedStory, "Rejected plan"],
      [revisedStory, "Revised plan"],
    ] as const) {
      await story({ id, title });
      await plan(id);
    }
    await decide(approvedStory, "approve");
    await decide(rejectedStory, "reject");
    await decide(revisedStory, "approve");
    await plan(revisedStory, 2);
    await plan(ids.billingStory);
    await plan(siblingStory, 1, { orgId, projectId: siblingProjectId });
    await plan(otherStory, 1, { orgId: otherOrgId, projectId: otherProjectId });

    readerSecret = await key("attention reader", ["projects:read"], projectId);
    noReadSecret = await key("attention cost viewer", ["costs:read"], projectId);
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    ownerCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("lists open notices newest first with the action each accepts", async () => {
    const page = await service.list(orgId, projectId, open, now);
    expect(page.items.map((item) => [item.id, item.action])).toEqual([
      [ids.waiting, "reply"],
      [ids.failed, "retry"],
      [ids.runtime, "dismiss"],
    ]);
    expect(page.total).toBe(3);
    expect(page.counts).toEqual({ open: 3, resolved: 1 });
    expect(page.facets.kinds).toEqual([
      { kind: "agent_waiting", count: 1 },
      { kind: "runtime_error", count: 1 },
      { kind: "turn_error", count: 1 },
    ]);
    expect(page.items[0]).toMatchObject({
      storyId: ids.checkoutStory,
      storyTitle: "Checkout flow",
      storyStatus: "attention",
      status: "open",
      resolution: null,
      resolvedAt: null,
    });
    // Large details are cut to an excerpt; the story keeps the full text.
    expect(page.items[2]?.detail).toHaveLength(1_000);
  });

  it("keeps resolved notices readable without offering actions on them", async () => {
    const resolved = await service.list(orgId, projectId, { ...open, status: "resolved" }, now);
    expect(resolved.items).toHaveLength(1);
    expect(resolved.items[0]).toMatchObject({
      id: ids.dismissed,
      status: "resolved",
      resolution: "dismissed",
      action: null,
    });
    expect(resolved.items[0]?.resolvedAt).toEqual(minutesAgo(5));
    expect(resolved.total).toBe(1);

    const all = await service.list(orgId, projectId, { ...open, status: "all" }, now);
    expect(all.items.map((item) => item.id)).toEqual([
      ids.waiting,
      ids.failed,
      ids.runtime,
      ids.dismissed,
    ]);
    expect(all.total).toBe(4);
  });

  it.each([
    "review_cycle_ready",
    "review_cycle_decision",
  ])("projects %s as a human notice without advertising a retry", async (kind) => {
    const id = newId("attn");
    const detail = "The recorded candidate requires a human decision before further correction.";
    await db.insert(attentionItems).values({
      id,
      orgId,
      projectId,
      storyId: ids.billingStory,
      turnId: ids.billingTurn,
      kind,
      title: "Delivery review needs a human decision",
      detail,
      status: "open",
      createdAt: now,
    });
    try {
      const page = await service.list(orgId, projectId, { ...open, kind: [kind] }, now);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id,
        kind,
        detail,
        turnId: ids.billingTurn,
        action: "dismiss",
      });
      const sibling = await service.list(orgId, siblingProjectId, { ...open, kind: [kind] }, now);
      expect(sibling.items).toHaveLength(0);
    } finally {
      await db.delete(attentionItems).where(eq(attentionItems.id, id));
    }
  });

  it("filters by kind while the kind facets still show every kind", async () => {
    const failed = await service.list(orgId, projectId, { ...open, kind: ["turn_error"] }, now);
    expect(failed.items.map((item) => item.id)).toEqual([ids.failed]);
    expect(failed.counts).toEqual({ open: 1, resolved: 1 });
    expect(failed.facets.kinds.map((facet) => facet.kind)).toEqual([
      "agent_waiting",
      "runtime_error",
      "turn_error",
    ]);
  });

  it("searches notice text and story titles, treating wildcards literally", async () => {
    const byDetail = await service.list(orgId, projectId, { ...open, q: "migration" }, now);
    expect(byDetail.items.map((item) => item.id)).toEqual([ids.waiting]);
    const byStory = await service.list(orgId, projectId, { ...open, q: "billing" }, now);
    expect(byStory.items.map((item) => item.id)).toEqual([ids.failed, ids.runtime]);
    const byTitle = await service.list(orgId, projectId, { ...open, q: "ENVIRONMENT" }, now);
    expect(byTitle.items.map((item) => item.id)).toEqual([ids.runtime]);
    // "%" and "_" are search text, not SQL wildcards that would match everything.
    const percent = await service.list(orgId, projectId, { ...open, q: "%" }, now);
    expect(percent.items.map((item) => item.id)).toEqual([ids.failed]);
    const underscore = await service.list(orgId, projectId, { ...open, q: "_" }, now);
    expect(underscore.items).toEqual([]);
    expect(underscore.counts).toEqual({ open: 0, resolved: 0 });
  });

  it("paginates over the whole filtered set", async () => {
    const first = await service.list(orgId, projectId, { ...open, limit: 2 }, now);
    expect(first.items.map((item) => item.id)).toEqual([ids.waiting, ids.failed]);
    expect(first.total).toBe(3);
    const second = await service.list(orgId, projectId, { ...open, limit: 2, offset: 2 }, now);
    expect(second.items.map((item) => item.id)).toEqual([ids.runtime]);
  });

  it("never mixes sibling projects or other tenants into the list", async () => {
    const page = await service.list(orgId, projectId, { ...open, status: "all" }, now);
    const titles = page.items.map((item) => item.title);
    expect(titles).not.toContain("Sibling question");
    expect(titles).not.toContain("Other tenant question");
    const other = await service.list(otherOrgId, otherProjectId, open, now);
    expect(other.items.map((item) => item.title)).toEqual(["Other tenant question"]);
    // The right project id under the wrong org sees nothing.
    const crossed = await service.list(otherOrgId, projectId, { ...open, status: "all" }, now);
    expect(crossed.items).toEqual([]);
    expect(crossed.counts).toEqual({ open: 0, resolved: 0 });
  });

  it("serves the list over HTTP with project scoping, permissions and validation", async () => {
    const owner = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/attention?kind=turn_error,runtime_error&limit=1`,
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.headers["cache-control"]).toBe("no-store");
    const body = owner.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([ids.failed]);
    expect(body).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(typeof body.generatedAt).toBe("string");

    const reader = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/attention?status=resolved`,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().items.map((item: { id: string }) => item.id)).toEqual([ids.dismissed]);

    const scoped = await app.inject({
      method: "GET",
      url: `/v1/projects/${siblingProjectId}/attention`,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(scoped.statusCode).toBe(404);
    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/attention`,
      headers: { cookie: ownerCookie },
    });
    expect(crossTenant.statusCode).toBe(404);
    const forbidden = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/attention`,
      headers: { authorization: `Bearer ${noReadSecret}` },
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/attention`,
    });
    expect(anonymous.statusCode).toBe(401);

    for (const query of ["status=pending", "limit=0", "limit=101", "offset=-1"]) {
      const malformed = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/attention?${query}`,
        headers: { cookie: ownerCookie },
      });
      expect(malformed.statusCode, query).toBe(400);
    }
  });
  it("pages whole stories with pending plans even when no notice exists", async () => {
    const query = { category: "all" as const, limit: 1, offset: 0 };
    const first = await service.listStories(orgId, projectId, query, now);
    expect(first.counts).toEqual({ stories: 4, plans: 3, notices: 3, deliveries: 0 });
    expect(first.total).toBe(4);
    const pages = await Promise.all(
      [0, 1, 2, 3].map((offset) =>
        service.listStories(orgId, projectId, { ...query, offset }, now),
      ),
    );
    const items = pages.flatMap((page) => page.items);
    expect(new Set(items.map((item) => item.storyId)).size).toBe(4);
    expect(items.at(-1)?.storyId).toBe(ids.checkoutStory);
    const billing = items.find((item) => item.storyId === ids.billingStory);
    if (!billing) throw new Error("Billing story missing");
    expect(billing.noticeCount).toBe(2);
    expect(billing.noticeKinds).toEqual([
      { kind: "runtime_error", count: 1 },
      { kind: "turn_error", count: 1 },
    ]);
    expect(billing.plan).toMatchObject({
      revision: 1,
      digest: "1".repeat(64),
      decisionBrief: { status: "available", brief },
    });
    expect(items.find((item) => item.storyId === planStory)?.noticeCount).toBe(0);
    expect(items.find((item) => item.storyId === revisedStory)?.plan?.revision).toBe(2);
    expect(items.map((item) => item.storyId)).not.toContain(approvedStory);
    expect(items.map((item) => item.storyId)).not.toContain(rejectedStory);
    const beyond = await service.listStories(orgId, projectId, { ...query, offset: 100 }, now);
    expect(beyond.items).toEqual([]);
    expect(beyond.counts).toEqual(first.counts);
  });

  it("filters matching stories without discarding their other notices or plan", async () => {
    const query = { category: "all" as const, limit: 10, offset: 0 };
    const found = await service.listStories(orgId, projectId, { ...query, q: "%" }, now);
    expect(found.counts).toEqual({ stories: 1, plans: 1, notices: 2, deliveries: 0 });
    expect(found.items[0]?.noticeKinds).toHaveLength(2);
    expect((await service.listStories(orgId, projectId, { ...query, q: "_" }, now)).total).toBe(0);
    expect(
      (await service.listStories(orgId, projectId, { ...query, category: "plans" }, now)).counts,
    ).toEqual({ stories: 3, plans: 3, notices: 2, deliveries: 0 });
    expect(
      (await service.listStories(orgId, projectId, { ...query, category: "notices" }, now)).counts,
    ).toEqual({ stories: 2, plans: 1, notices: 3, deliveries: 0 });
    expect((await service.listStories(otherOrgId, projectId, query, now)).counts).toEqual({
      stories: 0,
      plans: 0,
      notices: 0,
      deliveries: 0,
    });
    const other = await service.listStories(otherOrgId, otherProjectId, query, now);
    expect(other.counts).toEqual({ stories: 1, plans: 1, notices: 1, deliveries: 0 });
  });

  it("serves grouped reads with the same permission boundary and no cost data", async () => {
    const url = `/v1/projects/${projectId}/attention/stories`;
    const reader = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(reader.statusCode, reader.body).toBe(200);
    expect(reader.headers["cache-control"]).toBe("no-store");
    const expected = await service.listStories(orgId, projectId, {
      category: "all",
      limit: 10,
      offset: 0,
    });
    expect(reader.json().items).toEqual(JSON.parse(JSON.stringify(expected.items)));
    expect(reader.json()).not.toHaveProperty("spend");
    for (const [target, headers, code] of [
      [url, {}, 401],
      [url, { authorization: `Bearer ${noReadSecret}` }, 403],
      [
        `/v1/projects/${siblingProjectId}/attention/stories`,
        { authorization: `Bearer ${readerSecret}` },
        404,
      ],
      [`/v1/projects/${otherProjectId}/attention/stories`, { cookie: ownerCookie }, 404],
    ] as const) {
      const response = await app.inject({ method: "GET", url: target, headers });
      expect(response.statusCode).toBe(code);
    }
    for (const query of [
      "category=urgent",
      "limit=26",
      "offset=-1",
      "pullOffset=-1",
      "pullOffset=1.5",
      "limit=0",
    ]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${url}?${query}`,
            headers: { cookie: ownerCookie },
          })
        ).statusCode,
      ).toBe(400);
    }
  });
  it("shows a project budget once and omits its state and figures without budget permission", async () => {
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, enabled: true, monthlyLimitCents: 0 });
    const url = `/v1/projects/${projectId}/attention/stories`;
    const owner = await app.inject({ url, headers: { cookie: ownerCookie } });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().budget).toMatchObject({
      available: true,
      state: "exceeded",
      spentCents: 0,
      monthlyLimitCents: 0,
    });
    expect(owner.json().items.every((item: Record<string, unknown>) => !("budget" in item))).toBe(
      true,
    );
    const reader = await app.inject({ url, headers: { authorization: `Bearer ${readerSecret}` } });
    expect(reader.json().budget).toEqual({ available: false, reason: "permission" });
    expect(reader.json().counts).toEqual(owner.json().counts);
    await db
      .update(projectBudgets)
      .set({ enabled: false })
      .where(eq(projectBudgets.projectId, projectId));
    expect((await app.inject({ url, headers: { cookie: ownerCookie } })).json().budget.state).toBe(
      "disabled",
    );
  });

  it("covers every other open PR without hiding historical links or duplicating active deliveries", async () => {
    const repositoryId = newId("repo");
    const scope = { orgId, projectId };
    await db.insert(projectRepositories).values({
      id: repositoryId,
      ...scope,
      owner: "example",
      name: `inventory-${suffix}`,
      defaultBranch: "main",
    });
    const repository = `example/inventory-${suffix}`;
    const head = "a".repeat(40);
    await db.insert(githubPullRequests).values(
      Array.from({ length: 27 }, (_, i) => ({
        id: newId("ghp"),
        ...scope,
        repositoryId,
        number: i + 1,
        title: i === 0 ? "100% literal_review" : `Inventory change ${i + 1}`,
        state: i < 25 ? "open" : i === 25 ? "closed" : "merged",
        draft: i === 1,
        headRef: "feature",
        headSha: head,
        baseRef: "main",
        htmlUrl: `https://github.com/${repository}/pull/${i + 1}`,
        syncedAt: now,
        githubUpdatedAt: minutesAgo(100 - i),
        ciState: i === 2 ? "success" : null,
        ciHeadSha: i === 2 ? "b".repeat(40) : null,
      })),
    );
    const linked = new Map<string, string>();
    for (const [status, number] of [
      ["working", 25],
      ["done", 24],
      ["archived", 23],
      ["deleted", 22],
      ["source", 21],
    ] as const) {
      const id = newId("story");
      linked.set(status, id);
      await story({ id, title: `Associated ${status}` });
      await db
        .update(stories)
        .set({
          status: status === "done" || status === "archived" ? status : "working",
          ...(status === "deleted" ? { deletedAt: now } : {}),
          ...(status === "source"
            ? { provider: "github", repositoryId, externalId: `pull-request:${number}` }
            : {}),
        })
        .where(eq(stories.id, id));
      if (status !== "source")
        await db.insert(storyDeliveryPullRequests).values({
          ...scope,
          storyId: id,
          repositoryId,
          pullNumber: number,
          required: true,
          isPrimary: true,
        });
    }
    // Same PR numbers in another project and tenant may not leak into this inventory.
    for (const [tenant, project] of [
      [orgId, siblingProjectId],
      [otherOrgId, otherProjectId],
    ] as const) {
      const repo = newId("repo");
      await db.insert(projectRepositories).values({
        id: repo,
        orgId: tenant,
        projectId: project,
        owner: "example",
        name: `outside-${project}`,
        defaultBranch: "main",
      });
      await db.insert(githubPullRequests).values({
        id: newId("ghp"),
        orgId: tenant,
        projectId: project,
        repositoryId: repo,
        number: 1,
        title: "Outside secret PR",
        state: "open",
        headRef: "feature",
        headSha: head,
        baseRef: "main",
        htmlUrl: "https://github.com/example/outside/pull/1",
      });
    }
    const query = { category: "all" as const, limit: 10, offset: 0 };
    const pages = await Promise.all(
      [0, 10, 20].map((pullOffset) =>
        service.listStories(orgId, projectId, { ...query, pullOffset }, now),
      ),
    );
    const pulls = pages.flatMap((page) => page.otherPullRequests.items);
    expect(pages.map((page) => page.otherPullRequests.total)).toEqual([24, 24, 24]);
    expect(pulls.map((pull) => pull.number)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(pulls.map((pull) => `${pull.repository}#${pull.number}`)).size).toBe(24);
    expect(pulls.every((pull) => pull.repository === repository)).toBe(true);
    expect(pulls[2]?.checks).toMatchObject({
      state: "success",
      current: false,
      headSha: "b".repeat(40),
    });
    expect(pulls[1]?.draft).toBe(true);
    expect(pulls.find((pull) => pull.number === 24)?.stories).toMatchObject([
      { id: linked.get("done"), status: "done", relation: "delivery" },
    ]);
    expect(pulls.find((pull) => pull.number === 23)?.stories).toMatchObject([
      { id: linked.get("archived"), status: "archived" },
    ]);
    expect(pulls.find((pull) => pull.number === 22)?.stories).toEqual([]);
    expect(pulls.find((pull) => pull.number === 21)?.stories).toMatchObject([
      { id: linked.get("source"), relation: "source" },
    ]);
    const active = pages[0]?.items.find((item) => item.storyId === linked.get("working"));
    expect(active?.delivery?.pullRequests.map((pull) => pull.number)).toEqual([25]);
    for (const q of ["%", "_", "100% LITERAL_REVIEW"]) {
      const found = await service.listStories(orgId, projectId, { ...query, q }, now);
      expect(found.otherPullRequests.items.map((pull) => pull.number)).toEqual([1]);
    }
    const whole = await service.listStories(
      orgId,
      projectId,
      { ...query, q: "Inventory change 25" },
      now,
    );
    expect(whole.items.map((item) => item.storyId)).toEqual([linked.get("working")]);
    expect(whole.otherPullRequests.total).toBe(0);
    const onlyPulls = await service.listStories(
      orgId,
      projectId,
      { ...query, category: "pulls", pullOffset: 20 },
      now,
    );
    expect(onlyPulls.total).toBe(0);
    expect(onlyPulls.otherPullRequests.items).toHaveLength(4);
    const beyond = await service.listStories(orgId, projectId, { ...query, pullOffset: 1000 }, now);
    expect(beyond.otherPullRequests).toMatchObject({ total: 24, items: [] });
    expect(
      (await service.listStories(otherOrgId, projectId, query, now)).otherPullRequests.total,
    ).toBe(0);
    const http = await app.inject({
      url: `/v1/projects/${projectId}/attention/stories?category=pulls&pullOffset=20`,
      headers: { authorization: `Bearer ${readerSecret}` },
    });
    expect(http.statusCode, http.body).toBe(200);
    expect(
      http.json().otherPullRequests.items.map((pull: { number: number }) => pull.number),
    ).toEqual([21, 22, 23, 24]);
    // Moving a story back to active moves its PR to its delivery card on refresh.
    const completedStory = linked.get("done");
    if (!completedStory) throw new Error("Missing completed story fixture");
    await db.update(stories).set({ status: "working" }).where(eq(stories.id, completedStory));
    const moved = await service.listStories(orgId, projectId, { ...query, limit: 25 }, now);
    expect(moved.otherPullRequests.total).toBe(23);
    expect(moved.otherPullRequests.items.some((pull) => pull.number === 24)).toBe(false);
    expect(
      moved.items.find((item) => item.storyId === linked.get("done"))?.delivery?.pullRequests[0]
        ?.number,
    ).toBe(24);
  });
});
