import { randomUUID } from "node:crypto";
import { generateApiKey, newId, seal } from "@facility/core";
import {
  apiKeys,
  auditEvents,
  createDb,
  migrate,
  orgs,
  projectBudgets,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  turns,
  turnUsage,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CostBudgetService } from "../src/insights/costs.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const costs = new CostBudgetService(db);
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const otherOrg = newId("org");
beforeAll(async () => {
  await migrate(databaseUrl);
  await seed(databaseUrl, { includeDemoData: true });
  await db.insert(orgs).values({ id: otherOrg, name: "Other", slug: randomUUID() });
  app = await buildApp(
    {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
      port: 4400,
      publicUrl: "http://localhost:4400",
      webUrl: "http://localhost:3400",
      workspaceImage: "fake",
      workspaceDriver: "docker",
      facilityInsecureDev: true,
      logLevel: "silent",
    },
    { rateLimitMax: 10_000 },
  );
  await app.ready();
  const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
  cookie = login.cookies.map((x) => `${x.name}=${x.value}`).join("; ");
});
afterAll(async () => {
  await app?.close();
  await client.end();
});

async function fixture(orgId = "org_local", complete = true) {
  const projectId = newId("proj"),
    storyId = newId("story"),
    conversationId = newId("sess"),
    turnId = newId("turn");
  await db.insert(projects).values({ id: projectId, orgId, name: "Certainty", slug: projectId });
  await db
    .insert(projectBudgets)
    .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 10000, enabled: false });
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    provider: "manual",
    externalId: storyId,
    title: "Receipt",
    createdBy: { type: "user", id: "fixture" },
  });
  await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
  await db.insert(turns).values({
    id: turnId,
    orgId,
    projectId,
    storyId,
    conversationId,
    agentName: "builder",
    manifestHash: "test",
    manifest: {},
    engine: "codex",
    model: "unlisted-model",
    state: complete ? "succeeded" : "failed",
    triggerType: "manual",
    createdBy: { type: "user", id: "fixture" },
  });
  const bill = {
    orgId,
    projectId,
    storyId,
    turnId,
    agentName: "builder",
    engine: "codex",
    model: "unlisted-model",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 10,
    status: complete ? ("succeeded" as const) : ("failed" as const),
    complete,
  };
  await costs.record(bill);
  return { ...bill };
}
const url = (f: { projectId: string; turnId: string }) =>
  `/v1/projects/${f.projectId}/costs/${f.turnId}/settlement`;
const settle = (
  f: Parameters<typeof url>[0],
  body: unknown = { cost_cents: 12.5, reference: "provider-receipt-1" },
  headers: Record<string, string> = { cookie },
) =>
  app.inject({
    method: "POST",
    url: url(f),
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: body as Record<string, unknown>,
  });
async function rows(f: { turnId: string }) {
  return db.select().from(turnUsage).where(eq(turnUsage.turnId, f.turnId));
}
async function audits(f: { turnId: string }) {
  const usage = (await rows(f))[0];
  if (!usage) throw new Error("fixture usage missing");
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.action, "usage.settled"), eq(auditEvents.projectId, usage.projectId)),
    );
}

describe("usage certainty and audited final charges", () => {
  it("checks revoked read permission before replaying a stored receipt", async () => {
    const f = await fixture();
    const roleId = newId("role");
    await db.insert(roles).values({
      id: roleId,
      orgId: f.orgId,
      name: roleId,
      permissions: ["budgets:write", "costs:read"],
    });
    const key = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: key.id,
      orgId: f.orgId,
      name: "replay permission",
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      scopeType: "project",
      projectId: f.projectId,
      roleId,
    });
    const request = {
      method: "POST" as const,
      url: url(f),
      headers: { authorization: `Bearer ${key.secret}`, "idempotency-key": randomUUID() },
      payload: { cost_cents: 1, reference: "permission-replay" },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    await db
      .update(roles)
      .set({ permissions: ["budgets:write"] })
      .where(eq(roles.id, roleId));
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(await audits(f)).toHaveLength(1);
  });
  it("distinguishes a completed unpriced call, blocks after budget enable, and resumes only after receipt settlement", async () => {
    const f = await fixture();
    expect((await rows(f))[0]).toMatchObject({
      usageComplete: true,
      priced: false,
      costCents: null,
    });
    await db
      .update(projectBudgets)
      .set({ enabled: true })
      .where(eq(projectBudgets.projectId, f.projectId));
    await expect(costs.assertTurnAllowed(f.orgId, f.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    await db
      .update(turnUsage)
      .set({ createdAt: new Date("2020-01-01") })
      .where(eq(turnUsage.turnId, f.turnId));
    const pending = await app.inject({
      method: "GET",
      url: `/v1/projects/${f.projectId}/costs?unpriced_only=true`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().usage).toEqual([
      expect.objectContaining({ turnId: f.turnId, usageComplete: true, priced: false }),
    ]);
    const reply = await settle(f);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      source: "manual",
      priced: true,
      costCents: 12.5,
      usageComplete: true,
      settlementReference: "provider-receipt-1",
    });
    expect(new Date(reply.json().createdAt).getUTCFullYear()).toBe(new Date().getUTCFullYear());
    expect((await costs.assertTurnAllowed(f.orgId, f.projectId, "gpt-5.5")).spentCents).toBe(12.5);
    expect((await audits(f))[0]).toMatchObject({
      actor: expect.objectContaining({ type: "user" }),
      payload: expect.objectContaining({ costCents: 12.5, reference: "provider-receipt-1" }),
    });
  });
  it("does not fabricate complete tokens when a final zero-charge receipt resolves partial evidence", async () => {
    const f = await fixture("org_local", false);
    await db
      .update(projectBudgets)
      .set({ enabled: true })
      .where(eq(projectBudgets.projectId, f.projectId));
    expect((await costs.budgetState(f.orgId, f.projectId)).state).toBe("unconfirmed");
    const reply = await settle(f, { cost_cents: 0, reference: "free-attempt-receipt" });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      usageComplete: false,
      priced: true,
      costCents: 0,
      inputTokens: 100,
    });
    expect((await costs.budgetState(f.orgId, f.projectId)).state).toBe("ok");
  });
  it("settles concurrent duplicate receipts once and rejects conflicting replay and later engine overwrites", async () => {
    const f = await fixture();
    const replies = await Promise.all([settle(f), settle(f)]);
    expect(replies.map((x) => x.statusCode)).toEqual([200, 200]);
    expect(await audits(f)).toHaveLength(1);
    expect((await settle(f, { cost_cents: 1, reference: "different" })).statusCode).toBe(409);
    expect(await costs.record({ ...f, usage: { ...f.usage, reportedCostCents: 99 } })).toBeNull();
    expect((await rows(f))[0]?.costCents).toBe(12.5);
    expect(await audits(f)).toHaveLength(1);
  });
  it("does not downgrade complete unpriced evidence with a late partial report", async () => {
    const f = await fixture();
    expect(
      await costs.record({ ...f, complete: false, usage: { ...f.usage, inputTokens: 1 } }),
    ).toBeNull();
    expect((await rows(f))[0]).toMatchObject({
      usageComplete: true,
      inputTokens: 100,
      priced: false,
    });
  });
  it("allows only one of two conflicting final receipts and never rewrites an automatic charge", async () => {
    const f = await fixture();
    const replies = await Promise.all([
      settle(f, { cost_cents: 10, reference: "receipt-a" }),
      settle(f, { cost_cents: 11, reference: "receipt-b" }),
    ]);
    expect(replies.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(await audits(f)).toHaveLength(1);
    const automatic = await fixture();
    await costs.record({ ...automatic, usage: { ...automatic.usage, reportedCostCents: 0 } });
    expect((await settle(automatic)).statusCode).toBe(409);
    expect((await rows(automatic))[0]).toMatchObject({ source: "provider", costCents: 0 });
  });
  it("requires both budget-write and cost-read permissions", async () => {
    const f = await fixture();
    for (const permission of ["budgets:write", "costs:read"]) {
      const roleId = newId("role");
      await db
        .insert(roles)
        .values({ id: roleId, orgId: f.orgId, name: roleId, permissions: [permission] });
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId: f.orgId,
        name: "single permission",
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "project",
        projectId: f.projectId,
        roleId,
      });
      expect(
        (await settle(f, undefined, { authorization: `Bearer ${key.secret}` })).statusCode,
      ).toBe(403);
    }
    expect(await audits(f)).toHaveLength(0);
  });
  it("denies active turns and leaves receipt and audit unchanged", async () => {
    const f = await fixture();
    await db.update(turns).set({ state: "running" }).where(eq(turns.id, f.turnId));
    expect((await settle(f)).statusCode).toBe(409);
    expect((await rows(f))[0]?.priced).toBe(false);
    expect(await audits(f)).toHaveLength(0);
  });
  it.each([
    { cost_cents: -1, reference: "r" },
    { cost_cents: 1, reference: "  " },
    { cost_cents: 2_000_000_001, reference: "r" },
    { cost_cents: 1, reference: "r", usageComplete: true },
  ])("rejects malformed or forged receipt fields %#", async (body) => {
    const f = await fixture();
    expect((await settle(f, body)).statusCode).toBe(400);
    expect((await rows(f))[0]?.priced).toBe(false);
    expect(await audits(f)).toHaveLength(0);
  });
  it("rejects missing authentication, viewers, expired/revoked credentials and cross-project/tenant writes", async () => {
    const f = await fixture(),
      other = await fixture(),
      foreign = await fixture(otherOrg);
    expect((await settle(f, undefined, {})).statusCode).toBe(401);
    const expired = await seal(
      JSON.stringify({ userId: "user_local", orgId: f.orgId, exp: 0 }),
      Buffer.alloc(32, 7).toString("base64"),
    );
    expect((await settle(f, undefined, { cookie: `facility_session=${expired}` })).statusCode).toBe(
      401,
    );
    expect((await settle(f, undefined, { authorization: "Bearer invalid" })).statusCode).toBe(401);
    for (const [role, revoked] of [
      ["role_bundled_viewer", false],
      ["role_bundled_owner", true],
    ] as const) {
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId: f.orgId,
        name: "receipt-test",
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "project",
        projectId: f.projectId,
        roleId: role,
        revokedAt: revoked ? new Date() : null,
      });
      expect([401, 403]).toContain(
        (await settle(f, undefined, { authorization: `Bearer ${key.secret}` })).statusCode,
      );
    }
    const key = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: key.id,
      orgId: f.orgId,
      name: "scoped",
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      scopeType: "project",
      projectId: f.projectId,
      roleId: "role_bundled_owner",
    });
    expect([403, 404]).toContain(
      (await settle(other, undefined, { authorization: `Bearer ${key.secret}` })).statusCode,
    );
    expect((await settle({ ...f, turnId: foreign.turnId })).statusCode).toBe(404);
    expect([403, 404]).toContain((await settle(foreign)).statusCode);
    for (const entry of [f, other, foreign]) {
      expect((await rows(entry))[0]?.priced).toBe(false);
      expect(await audits(entry)).toHaveLength(0);
    }
  });
});
