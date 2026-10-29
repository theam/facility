import { randomUUID } from "node:crypto";
import {
  generateApiKey,
  newId,
  type PlanDecisionReview,
  type StoryPlans,
  StoryPlansSchema,
} from "@facility/core";
import {
  agentManifests,
  apiKeys,
  createDb,
  githubInstallations,
  migrate,
  orgMembers,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  storyEvidenceEvents,
  storyMessages,
  storyPlanDecisions,
  storyPlanRequests,
  storyPlanRevisions,
  storyPlanStates,
  users,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService } from "../src/agents/catalog.js";
import { buildApp, mintSessionCookie } from "../src/app.js";
import { confirmStoryPlanDecision, readStoryPlans } from "../src/stories/plans.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const signing = await generateKeyPair("ES256", { extractable: true });
const jwk = {
  ...(await exportJWK(signing.privateKey)),
  kid: "plan-tests",
  alg: "ES256",
  use: "sig",
};
function requiredProof(value: PlanDecisionReview) {
  if (!value.proof) throw Error("Expected a pending interactive confirmation proof");
  return value.proof;
}
describe("revision-bound story plans and interactive confirmation API", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org"),
    projectId = newId("proj"),
    otherProjectId = newId("proj"),
    otherOrgId = newId("org"),
    tenantProjectId = newId("proj");
  const userId = newId("user"),
    secondUserId = newId("user"),
    viewerUserId = newId("user"),
    writerRole = newId("role");
  const repoId = newId("repo"),
    relatedId = newId("repo"),
    foreignRepoId = newId("repo");
  const repository = `example-${suffix}/app`,
    relatedRepository = `example-${suffix}/api`;
  const credentials: Record<string, string> = {};
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 3).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "https://facility.test",
    oauthIssuer: "https://facility.test",
    mcpPublicUrl: "https://mcp.facility.test/mcp",
    oauthJwks: { keys: [jwk] },
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const enqueue = vi.fn(async () => undefined);
  const upstream = vi.fn(async () => {
    throw Error("Unexpected GitHub client");
  });
  const runtime = new FakeWorkspaceRuntime();
  const runtimeCalls = ["create", "wake", "exec", "inspect", "suspend", "destroy"].map((method) =>
    vi.spyOn(runtime, method as "create").mockRejectedValue(Error("Plans must not use compute")),
  );
  const source = (
    name: string,
    enabled = true,
    prompt = "Inspect and propose a bounded plan.",
  ) => ({
    file: `.agents/${name}.md`,
    source: `---\nname: ${name}\ndescription: Planning fixture\nengine: codex\nmodel: fixture-model\nenabled: ${enabled}\ntriggers:\n  - type: manual\n---\n${prompt}\n`,
  });
  let catalogSources = [source("planner"), source("builder"), source("disabled", false)];
  let catalogCommit = "a".repeat(40);
  const loadCatalog = vi.fn(async () => ({
    commitSha: catalogCommit,
    sources: catalogSources,
    repositoryId: repoId as string | undefined,
  }));
  let app: Awaited<ReturnType<typeof buildApp>>;
  let catalog: AgentCatalogService;
  let cookie: string, secondCookie: string, viewerCookie: string, oauth: string;
  const path = (storyId: string, selected = projectId) =>
    `/v1/projects/${selected}/workspace-stories/${storyId}/plan`;
  const headers = (name = "writer") => ({ authorization: `Bearer ${credentials[name]}` });
  const proposal = (
    expected_revision = 0,
    markdown = "## Plan\n\nImplement and verify the change.\n",
  ) => ({
    expected_revision,
    markdown,
    repositories: [repository],
    agents: ["planner"],
    idempotency_key: randomUUID(),
  });
  async function post(
    url: string,
    payload: { idempotency_key: string } & Record<string, unknown>,
    auth: Record<string, string> = headers(),
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: { ...auth, "idempotency-key": payload.idempotency_key },
      payload,
    });
  }
  async function story(selected = projectId, tenant = orgId) {
    const id = newId("story");
    await db.insert(stories).values({
      id,
      orgId: tenant,
      projectId: selected,
      provider: "manual",
      externalId: id,
      title: "Plan fixture",
      status: "ready",
      createdBy: { type: "user", id: userId },
    });
    return id;
  }
  async function planned() {
    const id = await story();
    const response = await post(path(id), proposal());
    expect(response.statusCode, response.body).toBe(200);
    return id;
  }
  async function request(
    id: string,
    intent: "approve" | "reject" = "approve",
    auth = headers(),
    expected_revision = 1,
    expected_decision_revision = 0,
  ) {
    const response = await post(
      `${path(id)}/decisions`,
      {
        expected_revision,
        expected_decision_revision,
        intent,
        ...(intent === "reject" ? { reason: "Add a regression case" } : {}),
        idempotency_key: randomUUID(),
      },
      auth,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json().request.id as string;
  }
  async function review(id: string, requestId: string, selectedCookie = cookie) {
    const response = await app.inject({
      url: `${path(id)}/decisions/${requestId}`,
      headers: { cookie: selectedCookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<PlanDecisionReview>();
  }
  async function confirm(
    id: string,
    requestId: string,
    proof: string,
    selectedCookie = cookie,
    key = randomUUID(),
  ) {
    return post(
      `${path(id)}/decisions/${requestId}/confirm`,
      { proof, idempotency_key: key },
      { cookie: selectedCookie },
    );
  }
  const read = async (id: string) =>
    (await app.inject({ url: path(id), headers: headers("viewer") })).json<StoryPlans>();
  async function key(name: string, selected: string, roleId: string, tenant = orgId) {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId: tenant,
      name,
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId: selected,
      roleId,
    });
    credentials[name] = generated.secret;
    return generated.id;
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Plans fixture", slug: orgId },
      { id: otherOrgId, name: "Other tenant", slug: otherOrgId },
    ]);
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Plans fixture", slug: projectId },
      { id: otherProjectId, orgId, name: "Other project", slug: otherProjectId },
      { id: tenantProjectId, orgId: otherOrgId, name: "Other tenant", slug: tenantProjectId },
    ]);
    await db.insert(roles).values({
      id: writerRole,
      orgId,
      name: `plan-writer-${suffix}`,
      permissions: ["projects:read", "projects:write"],
    });
    for (const [id, roleId] of [
      [userId, writerRole],
      [secondUserId, writerRole],
      [viewerUserId, "role_bundled_viewer"],
    ] as const) {
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: "Fixture user", status: "active" });
      await db.insert(orgMembers).values({ id: newId("member"), orgId, userId: id, roleId });
    }
    await db.insert(githubInstallations).values({
      id: newId("int"),
      orgId,
      installationId: Date.now(),
      accountId: 1,
      accountLogin: "fixture",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: repoId,
        orgId,
        projectId,
        owner: `example-${suffix}`,
        name: "app",
        role: "primary",
        defaultBranch: "main",
      },
      {
        id: relatedId,
        orgId,
        projectId,
        owner: `example-${suffix}`,
        name: "api",
        role: "related",
        defaultBranch: "main",
      },
      {
        id: foreignRepoId,
        orgId,
        projectId: otherProjectId,
        owner: `example-${suffix}`,
        name: "foreign",
        role: "primary",
        defaultBranch: "main",
      },
    ]);
    await key("writer", projectId, writerRole);
    await key("viewer", projectId, "role_bundled_viewer");
    await key("otherProject", otherProjectId, "role_bundled_owner");
    await key("tenant", tenantProjectId, "role_bundled_owner", otherOrgId);
    cookie = `facility_session=${await mintSessionCookie(config, userId, orgId)}`;
    secondCookie = `facility_session=${await mintSessionCookie(config, secondUserId, orgId)}`;
    viewerCookie = `facility_session=${await mintSessionCookie(config, viewerUserId, orgId)}`;
    oauth = await new SignJWT({ org_id: orgId, scope: "facility:mcp" })
      .setProtectedHeader({ alg: "ES256", kid: "plan-tests" })
      .setIssuer("https://facility.test")
      .setAudience("https://mcp.facility.test/mcp")
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(signing.privateKey);
    const domain = createStoryDomain({ db, config, runtime, enqueue, githubFactory: upstream });
    catalog = new AgentCatalogService(db, { load: loadCatalog });
    domain.catalog = catalog;
    app = await buildApp(config, { rateLimitMax: 10_000, storyDomain: domain });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
    expect(enqueue).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    for (const call of runtimeCalls) expect(call).not.toHaveBeenCalled();
  });

  it("scopes authenticated reads/writes by tenant, project and permission without catalog reads for metadata", async () => {
    const id = await story();
    const calls = loadCatalog.mock.calls.length;
    expect((await app.inject({ url: path(id) })).statusCode).toBe(401);
    for (const name of ["otherProject", "tenant"]) {
      expect((await app.inject({ url: path(id), headers: headers(name) })).statusCode).toBe(404);
      expect((await post(path(id), proposal(), headers(name))).statusCode).toBe(404);
    }
    expect(
      (await app.inject({ url: path(id, otherProjectId), headers: headers() })).statusCode,
    ).toBe(404);
    expect((await post(path(id), proposal(), headers("viewer"))).statusCode).toBe(403);
    expect((await read(id)).state).toEqual({ revision: 0, decisionRevision: 0, status: "none" });
    expect(loadCatalog).toHaveBeenCalledTimes(calls);
  });
  it("pages only scoped repository names for plan writers without granting repository administration", async () => {
    const id = await story(),
      calls = loadCatalog.mock.calls.length;
    const first = await app.inject({ url: `${path(id)}/repositories?limit=1`, headers: headers() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      items: [{ repository: relatedRepository, primary: false }],
      hasMore: true,
      nextOffset: 1,
    });
    const second = await app.inject({
      url: `${path(id)}/repositories?limit=1&offset=1`,
      headers: headers(),
    });
    expect(second.json()).toEqual({
      items: [{ repository, primary: true }],
      hasMore: false,
      nextOffset: null,
    });
    expect(
      (await app.inject({ url: `${path(id)}/repositories?q=%25`, headers: headers() })).json()
        .items,
    ).toHaveLength(0);
    expect(
      (await app.inject({ url: `${path(id)}/repositories`, headers: headers("viewer") }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `${path(id)}/repositories`, headers: headers("tenant") }))
        .statusCode,
    ).toBe(404);
    expect(loadCatalog).toHaveBeenCalledTimes(calls);
  });

  it("retains the exact fresh catalog provenance when a concurrent refresh replaces the projection", async () => {
    const refresh = catalog.refreshSnapshot.bind(catalog);
    const spy = vi.spyOn(catalog, "refreshSnapshot").mockImplementationOnce(async (...args) => {
      const observed = await refresh(...args);
      // Identical manifests from another commit must not falsely attribute their provenance.
      await db
        .update(agentManifests)
        .set({ commitSha: "c".repeat(40) })
        .where(and(eq(agentManifests.orgId, orgId), eq(agentManifests.projectId, projectId)));
      return observed;
    });
    try {
      const id = await planned();
      expect((await read(id)).plan?.agents[0]?.catalogCommitSha).toBe(catalogCommit);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an unidentified, foreign or changed catalog source before recording a plan", async () => {
    const id = await story();
    for (const repositoryId of [undefined, foreignRepoId]) {
      loadCatalog.mockResolvedValueOnce({
        commitSha: catalogCommit,
        sources: catalogSources,
        repositoryId,
      });
      expect((await post(path(id), proposal())).statusCode).toBe(409);
      expect((await read(id)).plan).toBeNull();
    }
    loadCatalog.mockImplementationOnce(async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(projectRepositories)
          .set({ role: "related" })
          .where(eq(projectRepositories.id, repoId));
        await tx
          .update(projectRepositories)
          .set({ role: "primary" })
          .where(eq(projectRepositories.id, relatedId));
      });
      return { commitSha: catalogCommit, sources: catalogSources, repositoryId: repoId };
    });
    try {
      const changed = await post(path(id), proposal());
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe("plan_catalog_repository_changed");
      expect((await read(id)).plan).toBeNull();
    } finally {
      await db.transaction(async (tx) => {
        await tx
          .update(projectRepositories)
          .set({ role: "related" })
          .where(eq(projectRepositories.id, relatedId));
        await tx
          .update(projectRepositories)
          .set({ role: "primary" })
          .where(eq(projectRepositories.id, repoId));
      });
    }
  });

  it("resolves scope on the server, preserves exact source text and records the actual proposer", async () => {
    const id = await story(),
      conversationId = newId("sess"),
      messageId = newId("msg");
    const markdown = "  ## Plan\n\nReview the exact original text.\n";
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId, projectId, storyId: id });
    await db.insert(storyMessages).values({
      id: messageId,
      orgId,
      projectId,
      storyId: id,
      conversationId,
      seq: 1,
      role: "agent",
      body: markdown,
      actor: { name: "planner" },
    });
    const response = await post(path(id), {
      ...proposal(0, markdown),
      repositories: [relatedRepository, repository],
      agents: ["builder", "planner"],
      source_message_id: messageId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const value = response.json<StoryPlans>();
    expect(value.state).toEqual({ revision: 1, decisionRevision: 0, status: "proposed" });
    expect(value.plan).toMatchObject({
      markdown,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedBy: { type: "service" },
      source: { messageId, role: "agent" },
      agents: [
        { name: "builder", repositoryId: repoId, catalogCommitSha: catalogCommit },
        { name: "planner", repositoryId: repoId },
      ],
    });
    expect(value.plan?.proposedBy.id).not.toBe(userId);
    expect(
      (await app.inject({ url: `${path(id)}/revisions/1`, headers: headers("viewer") })).json()
        .markdown,
    ).toBe(markdown);
    const forged = await post(path(id), {
      ...proposal(1),
      proposedBy: { type: "user", id: userId },
    });
    expect(forged.statusCode).toBe(400);
    expect(
      (await post(path(id), { ...proposal(1), source_message_id: messageId })).json().error.code,
    ).toBe("plan_source_changed");
    const other = await story();
    expect(
      (await post(path(other), { ...proposal(), source_message_id: messageId })).statusCode,
    ).toBe(404);
  });
  it("rejects foreign repositories and missing/disabled agents, and never treats unavailable catalog refresh as fresh", async () => {
    const id = await story();
    for (const patch of [
      { repositories: [`example-${suffix}/foreign`] },
      { agents: ["missing"] },
      { agents: ["disabled"] },
    ])
      expect((await post(path(id), { ...proposal(), ...patch })).statusCode).toBeGreaterThanOrEqual(
        400,
      );
    expect((await read(id)).plan).toBeNull();
    loadCatalog.mockRejectedValueOnce(Error("Fixture catalog unavailable"));
    expect((await post(path(id), proposal())).statusCode).toBe(500);
    expect((await read(id)).plan).toBeNull();
  });
  it("uses CAS, stable HTTP idempotency and semantic no-ops while retaining bounded immutable history", async () => {
    const id = await story(),
      body = proposal();
    expect((await post(path(id), body)).statusCode).toBe(200);
    expect((await post(path(id), body)).headers["idempotency-status"]).toBe("replayed");
    catalogCommit = "b".repeat(40);
    expect((await post(path(id), proposal(1))).json().state.revision).toBe(1);
    catalogCommit = "a".repeat(40);
    const raced = await Promise.all([
      post(path(id), proposal(1, "Second plan")),
      post(path(id), proposal(1, "Competing plan")),
    ]);
    expect(raced.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await post(path(id), proposal(2, "Third plan"))).statusCode).toBe(200);
    const firstPage = (
      await app.inject({ url: `${path(id)}?limit=1`, headers: headers() })
    ).json<StoryPlans>();
    expect(firstPage.history).toMatchObject({
      items: [{ revision: 2 }],
      hasMore: true,
      nextBeforeRevision: 2,
    });
    const older = (
      await app.inject({ url: `${path(id)}?limit=1&before_revision=2`, headers: headers() })
    ).json<StoryPlans>();
    expect(older.history.items[0]?.revision).toBe(1);
    expect(older.history.hasMore).toBe(false);
    expect(
      (await app.inject({ url: `${path(id)}/revisions/1`, headers: headers() })).json().markdown,
    ).toBe(body.markdown);
    const domain = await readStoryPlans(
      db,
      { orgId, projectId, storyId: id },
      { webUrl: "https://facility.test" },
    );
    expect(domain).toEqual(StoryPlansSchema.parse(domain));
  });
  it("requires matching idempotency keys and rejects request-controlled confirmation authority", async () => {
    const id = await planned();
    const response = await app.inject({
      method: "POST",
      url: `${path(id)}/decisions`,
      headers: headers(),
      payload: {
        expected_revision: 1,
        expected_decision_revision: 0,
        intent: "approve",
        idempotency_key: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      (
        await post(`${path(id)}/decisions`, {
          expected_revision: 1,
          expected_decision_revision: 0,
          intent: "reject",
          idempotency_key: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    const requestId = await request(id),
      value = await review(id, requestId);
    expect(
      (
        await post(
          `${path(id)}/decisions/${requestId}/confirm`,
          { proof: value.proof, idempotency_key: randomUUID(), confirmedBy: { id: userId } },
          { cookie },
        )
      ).statusCode,
    ).toBe(400);
    expect((await read(id)).state.status).toBe("proposed");
  });
  it("denies service and valid OAuth bearer confirmation, including replay with the same user's cookie", async () => {
    const id = await planned(),
      requestId = await request(id),
      value = await review(id, requestId);
    for (const auth of [
      headers(),
      { authorization: `Bearer ${oauth}` },
      { authorization: `Bearer ${oauth}`, cookie },
    ]) {
      expect(
        (await app.inject({ url: `${path(id)}/decisions/${requestId}`, headers: auth })).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            `${path(id)}/decisions/${requestId}/confirm`,
            { proof: value.proof, idempotency_key: randomUUID() },
            auth,
          )
        ).statusCode,
      ).toBe(403);
    }
    const key = randomUUID();
    expect((await confirm(id, requestId, requiredProof(value), cookie, key)).statusCode).toBe(200);
    expect(
      (
        await post(
          `${path(id)}/decisions/${requestId}/confirm`,
          { proof: value.proof, idempotency_key: key },
          { authorization: `Bearer ${oauth}`, cookie },
        )
      ).statusCode,
    ).toBe(403);
  });
  it("records one interactive receipt atomically and replays only a matching session/key", async () => {
    const id = await planned(),
      requestId = await request(id),
      value = await review(id, requestId),
      key = randomUUID();
    const first = await confirm(id, requestId, requiredProof(value), cookie, key);
    expect(first.statusCode, first.body).toBe(200);
    const state = first.json<StoryPlans>();
    expect(state.state).toEqual({ revision: 1, decisionRevision: 1, status: "approved" });
    expect(state.decision).toMatchObject({
      method: "interactive_session",
      planDigest: value.plan.digest,
      confirmedBy: { type: "user", id: userId },
      requestId,
    });
    const replay = await confirm(id, requestId, requiredProof(value), cookie, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-status"]).toBe("replayed");
    expect((await confirm(id, requestId, requiredProof(value))).statusCode).toBe(409);
    const renewed = `facility_session=${await mintSessionCookie(config, userId, orgId)}`;
    expect((await confirm(id, requestId, requiredProof(value), renewed, key)).statusCode).toBe(400);
    expect((await review(id, requestId)).proof).toBeNull();
    expect(
      await db.select().from(storyPlanDecisions).where(eq(storyPlanDecisions.storyId, id)),
    ).toHaveLength(1);
    const evidence = await db
      .select()
      .from(storyEvidenceEvents)
      .where(
        and(
          eq(storyEvidenceEvents.storyId, id),
          eq(storyEvidenceEvents.type, "plan.decision_confirmed"),
        ),
      );
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain(value.proof);
    expect(JSON.stringify(evidence)).not.toContain(cookie.split("=")[1]);
  });
  it("binds OAuth-user requests to that user while service requests allow another authorized reviewer", async () => {
    const id = await planned(),
      requestId = await request(id, "approve", { authorization: `Bearer ${oauth}` });
    expect(
      (
        await app.inject({
          url: `${path(id)}/decisions/${requestId}`,
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(403);
    const own = await review(id, requestId);
    expect(own.request.boundUserId).toBe(userId);
    const serviceRequest = await request(id),
      serviceReview = await review(id, serviceRequest, secondCookie);
    expect(
      (await confirm(id, serviceRequest, requiredProof(serviceReview), secondCookie)).json()
        .decision.confirmedBy.id,
    ).toBe(secondUserId);
  });
  it("rejects wrong session, changed proof, expired request and cross-story/project confirmation", async () => {
    const id = await planned(),
      requestId = await request(id),
      value = await review(id, requestId);
    expect((await confirm(id, requestId, requiredProof(value), secondCookie)).statusCode).toBe(400);
    expect((await confirm(id, requestId, "x".repeat(43))).statusCode).toBe(400);
    const other = await planned();
    expect((await confirm(other, requestId, requiredProof(value))).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          url: `${path(id, otherProjectId)}/decisions/${requestId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    await db
      .update(storyPlanRequests)
      .set({
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(storyPlanRequests.id, requestId));
    expect((await review(id, requestId)).request.status).toBe("expired");
    expect((await confirm(id, requestId, requiredProof(value))).json().error.code).toBe(
      "plan_confirmation_expired",
    );
    expect((await read(id)).state.status).toBe("proposed");
  });
  it("rechecks revoked permission and active membership between review and confirmation", async () => {
    const id = await planned(),
      requestId = await request(id),
      value = await review(id, requestId);
    expect(
      (
        await app.inject({
          url: `${path(id)}/decisions/${requestId}`,
          headers: { cookie: viewerCookie },
        })
      ).statusCode,
    ).toBe(403);
    try {
      await db
        .update(orgMembers)
        .set({ roleId: "role_bundled_viewer" })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
      expect((await confirm(id, requestId, requiredProof(value))).statusCode).toBe(403);
      // Bypass the HTTP hook to verify the transaction itself rechecks current membership.
      await expect(
        confirmStoryPlanDecision(
          db,
          { orgId, projectId, storyId: id },
          requestId,
          requiredProof(value),
          { id: userId, name: "Fixture", sessionCookie: cookie.slice("facility_session=".length) },
          config.secretMasterKey,
          { webUrl: "https://facility.test" },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await db
        .update(orgMembers)
        .set({ roleId: writerRole })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    }
    try {
      await db.update(users).set({ status: "inactive" }).where(eq(users.id, userId));
      expect((await confirm(id, requestId, requiredProof(value))).statusCode).toBe(401);
    } finally {
      await db.update(users).set({ status: "active" }).where(eq(users.id, userId));
    }
    expect((await read(id)).decision).toBeNull();
  });
  it("supersedes old confirmations and approvals when the plan or selected agent configuration changes", async () => {
    const id = await planned(),
      firstRequest = await request(id),
      old = await review(id, firstRequest);
    expect((await confirm(id, firstRequest, requiredProof(old))).statusCode).toBe(200);
    const staleRequest = await request(id, "approve", headers(), 1, 1),
      stale = await review(id, staleRequest);
    catalogSources = [
      source("planner", true, "A revised instruction."),
      source("builder"),
      source("disabled", false),
    ];
    try {
      expect((await post(path(id), proposal(1))).json().state).toEqual({
        revision: 2,
        decisionRevision: 1,
        status: "proposed",
      });
    } finally {
      catalogSources = [source("planner"), source("builder"), source("disabled", false)];
    }
    expect((await confirm(id, staleRequest, requiredProof(stale))).json().error.code).toBe(
      "plan_revision_conflict",
    );
    expect((await review(id, staleRequest)).request.status).toBe("superseded");
    const current = await read(id);
    expect(current.decision?.planRevision).toBe(1);
    expect(current.decisions.items).toHaveLength(1);
  });
  it("serializes competing approve/reject decisions and retains paged decision history", async () => {
    const id = await planned(),
      approve = await request(id),
      reject = await request(id, "reject");
    const a = await review(id, approve),
      b = await review(id, reject);
    const results = await Promise.all([
      confirm(id, approve, requiredProof(a)),
      confirm(id, reject, requiredProof(b)),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await read(id)).state.decisionRevision).toBe(1);
    const next = await request(id, "reject", headers(), 1, 1),
      nextReview = await review(id, next);
    expect((await confirm(id, next, requiredProof(nextReview))).json().state.status).toBe(
      "rejected",
    );
    const first = (
      await app.inject({ url: `${path(id)}?limit=1`, headers: headers() })
    ).json<StoryPlans>();
    expect(first.decisions).toMatchObject({
      items: [{ decisionRevision: 2, intent: "reject" }],
      hasMore: true,
      nextBeforeRevision: 2,
    });
    const older = (
      await app.inject({
        url: `${path(id)}?limit=1&before_decision_revision=2`,
        headers: headers(),
      })
    ).json<StoryPlans>();
    expect(older.decisions.items[0]?.decisionRevision).toBe(1);
  });
  it("rolls back the receipt, consumption and state together when evidence cannot be appended", async () => {
    const id = await planned(),
      requestId = await request(id),
      value = await review(id, requestId);
    const functionName = `fixture_plan_evidence_${suffix.replaceAll("-", "")}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.story_id = '${id}' AND NEW.type = 'plan.decision_confirmed' THEN RAISE EXCEPTION 'fixture evidence failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${functionName} BEFORE INSERT ON story_evidence_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    try {
      expect((await confirm(id, requestId, requiredProof(value))).statusCode).toBe(500);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${functionName} ON story_evidence_events`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
    expect((await read(id)).state).toEqual({
      revision: 1,
      decisionRevision: 0,
      status: "proposed",
    });
    const [row] = await db
      .select()
      .from(storyPlanRequests)
      .where(eq(storyPlanRequests.id, requestId));
    expect(row?.consumedAt).toBeNull();
    expect(
      await db.select().from(storyPlanDecisions).where(eq(storyPlanDecisions.storyId, id)),
    ).toHaveLength(0);
    expect((await confirm(id, requestId, requiredProof(value))).statusCode).toBe(200);
  });
  it("enforces relational repository/tenant/source boundaries and keeps audit history on disconnect", async () => {
    const id = await planned();
    await expect(
      db.delete(projectRepositories).where(eq(projectRepositories.id, repoId)),
    ).rejects.toThrow();
    const [row] = await db
      .select()
      .from(storyPlanRevisions)
      .where(eq(storyPlanRevisions.storyId, id));
    expect(row).toBeDefined();
    await expect(
      db
        .update(storyPlanRevisions)
        .set({ orgId: otherOrgId })
        .where(eq(storyPlanRevisions.storyId, id)),
    ).rejects.toThrow();
    expect((await read(id)).plan?.revision).toBe(1);
    expect(
      await db.select().from(storyPlanStates).where(eq(storyPlanStates.storyId, id)),
    ).toHaveLength(1);
  });
});
