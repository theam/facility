import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  attentionItems,
  createDb,
  migrate,
  orgs,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  turns,
} from "@facility/db";
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
});
