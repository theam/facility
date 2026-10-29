import { randomUUID } from "node:crypto";
import { generateApiKey, newId, type StoryDelivery } from "@facility/core";
import {
  agentManifests,
  apiKeys,
  budgetReservations,
  createDb,
  githubPullRequests,
  migrate,
  orgMembers,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  storyDeliveryAcceptanceRequests,
  storyDeliveryAcceptances,
  storyPlanDecisions,
  turns,
  users,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService } from "../src/agents/catalog.js";
import { buildApp, mintSessionCookie } from "../src/app.js";
import {
  authorizePlanExecution,
  planExecutionStillAuthorized,
  recordPlanExecution,
} from "../src/stories/workflow-execution.js";
import { createStoryDomain, type StoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
describe("interactive workflow policy and exact delivery acceptance API", () => {
  const { db, client } = createDb(databaseUrl);
  const orgId = "org_local",
    projectId = newId("proj"),
    otherProjectId = newId("proj"),
    repoId = newId("repo");
  const userId = "user_local_admin",
    otherUserId = newId("user"),
    writerRole = newId("role"),
    writerId = newId("user");
  const runtime = new FakeWorkspaceRuntime();
  const compute = ["create", "wake", "exec", "inspect", "suspend", "destroy"].map((name) =>
    vi.spyOn(runtime, name as "create").mockRejectedValue(Error("No compute for human decisions")),
  );
  const enqueue = vi.fn(async (_queue: string, _data: Record<string, unknown>) => null);
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 6).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "https://facility.test",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  let domain: StoryDomain;
  let app: Awaited<ReturnType<typeof buildApp>>,
    cookie: string,
    otherCookie: string,
    writerCookie: string,
    key: string;
  const policyPath = `/v1/projects/${projectId}/workflow-policy`;
  const path = (id: string) => `/v1/projects/${projectId}/workspace-stories/${id}`;
  const headers = () => ({ authorization: `Bearer ${key}` });
  const post = (
    url: string,
    payload: Record<string, unknown> & { idempotency_key: string },
    auth: Record<string, string> = { cookie },
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: { ...auth, "idempotency-key": payload.idempotency_key },
      payload,
    });
  const policy = (input = {}) => ({
    planApprovalAgents: [],
    holdAfterFailure: false,
    requireDeliveryAcceptance: true,
    requirePreviewForAcceptance: false,
    ...input,
  });
  async function reviewPolicy(input = policy(), auth: Record<string, string> = { cookie }) {
    const response = await app.inject({ url: policyPath, headers: auth });
    const review = await post(
      `${policyPath}/review`,
      { expected_revision: response.json().revision, policy: input, idempotency_key: randomUUID() },
      auth,
    );
    expect(review.statusCode, review.body).toBe(200);
    return review.json();
  }
  async function savePolicy(input = policy()) {
    const review = await reviewPolicy(input);
    const response = await post(`${policyPath}/confirm`, {
      expected_revision: review.expectedRevision,
      policy: review.policy,
      nonce: review.nonce,
      expires_at: review.expiresAt,
      proof: review.proof,
      idempotency_key: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function delivery() {
    const id = newId("story");
    await db.insert(stories).values({
      id,
      orgId,
      projectId,
      provider: "manual",
      externalId: id,
      title: "Acceptance fixture",
      status: "review",
      createdBy: { type: "user", id: userId },
    });
    const response = await post(
      `${path(id)}/delivery`,
      {
        expected_revision: 0,
        declared_complete: true,
        pull_requests: [
          { repository: `${projectId}/app`, number: 1, required: true, primary: true },
        ],
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(response.statusCode, response.body).toBe(200);
    return { id, delivery: response.json<StoryDelivery>() };
  }
  async function request(
    id: string,
    candidate: StoryDelivery,
    auth: Record<string, string> = headers(),
  ) {
    const response = await post(
      `${path(id)}/delivery-acceptance`,
      {
        expected_candidate_revision: candidate.candidate.revision,
        expected_plan_revision: 0,
        expected_decision_revision: 0,
        idempotency_key: randomUUID(),
      },
      auth,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function review(id: string, requestId: string, auth: Record<string, string> = { cookie }) {
    return app.inject({ url: `${path(id)}/delivery-acceptance/${requestId}`, headers: auth });
  }
  const confirm = (
    id: string,
    requestId: string,
    proof: string,
    auth: Record<string, string> = { cookie },
    idempotency_key = randomUUID(),
  ) =>
    post(`${path(id)}/delivery-acceptance/${requestId}/confirm`, { proof, idempotency_key }, auth);
  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Workflow fixture", slug: projectId },
      { id: otherProjectId, orgId, name: "Other scope", slug: otherProjectId },
    ]);
    await db.insert(projectRepositories).values({
      id: repoId,
      orgId,
      projectId,
      owner: projectId,
      name: "app",
      role: "primary",
      defaultBranch: "main",
    });
    await db.insert(roles).values({
      id: writerRole,
      orgId,
      name: writerRole,
      permissions: ["projects:read", "projects:write"],
    });
    for (const [id, roleId] of [
      [otherUserId, "role_bundled_owner"],
      [writerId, writerRole],
    ] as const) {
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: "Fixture member", status: "active" });
      await db.insert(orgMembers).values({ id: newId("member"), orgId, userId: id, roleId });
    }
    const generated = await generateApiKey("fak");
    key = generated.secret;
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      name: "Workflow API fixture",
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_owner",
    });
    cookie = `facility_session=${await mintSessionCookie(config, userId, orgId)}`;
    otherCookie = `facility_session=${await mintSessionCookie(config, otherUserId, orgId)}`;
    writerCookie = `facility_session=${await mintSessionCookie(config, writerId, orgId)}`;
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repositoryId: repoId,
      number: 1,
      title: "Delivery fixture",
      state: "open",
      headRef: "feature",
      baseRef: "main",
      headSha: "a".repeat(40),
      htmlUrl: `https://github.com/${projectId}/app/pull/1`,
      ciState: "success",
      ciHeadSha: "a".repeat(40),
      ciUpdatedAt: new Date(),
    });
    domain = createStoryDomain({
      db,
      config,
      runtime,
      enqueue,
      githubFactory: async () => {
        throw Error("No live GitHub for workflow tests");
      },
    });
    domain.catalog = new AgentCatalogService(db, {
      load: async () => ({
        repositoryId: repoId,
        commitSha: "a".repeat(40),
        sources: [
          {
            file: ".agents/builder.md",
            source:
              "---\nname: builder\ndescription: Build a bounded change\nengine: codex\nmodel: fixture-model\nenabled: true\ntriggers:\n  - type: manual\n---\nBuild and test.\n",
          },
        ],
      }),
    });
    app = await buildApp(config, { rateLimitMax: 10000, storyDomain: domain });
    vi.spyOn(app, "enqueue").mockImplementation(enqueue);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
    for (const call of compute) expect(call).not.toHaveBeenCalled();
  });
  it("keeps defaults compatible and requires both configuration grants plus interactive session", async () => {
    const initial = await app.inject({ url: policyPath, headers: headers() });
    expect(initial.json()).toEqual({
      revision: 0,
      policy: policy({ requireDeliveryAcceptance: false }),
    });
    const body = { expected_revision: 0, policy: policy(), idempotency_key: randomUUID() };
    expect((await post(`${policyPath}/review`, body, headers())).statusCode).toBe(403);
    expect((await post(`${policyPath}/review`, body, { cookie: writerCookie })).statusCode).toBe(
      403,
    );
    await savePolicy();
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: {
        settings: {
          storyWorkflow: { revision: 0, policy: policy({ requireDeliveryAcceptance: false }) },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    const current = (await app.inject({ url: policyPath, headers: headers() })).json();
    const generic = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: { settings: { ordinaryPreference: true } },
    });
    expect(generic.statusCode, generic.body).toBe(200);
    expect((await app.inject({ url: policyPath, headers: headers() })).json()).toEqual(current);
  });
  it("binds policy confirmation to exact content, session and single policy revision", async () => {
    const reviewed = await reviewPolicy();
    const body = {
      expected_revision: reviewed.expectedRevision,
      policy: reviewed.policy,
      nonce: reviewed.nonce,
      expires_at: reviewed.expiresAt,
      proof: reviewed.proof,
      idempotency_key: randomUUID(),
    };
    expect(
      (
        await post(`${policyPath}/confirm`, {
          ...body,
          policy: policy({ requireDeliveryAcceptance: false }),
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(`${policyPath}/confirm`, body, { cookie: otherCookie })).statusCode).toBe(
      400,
    );
    expect((await post(`${policyPath}/confirm`, body)).statusCode).toBe(200);
    expect(
      (await post(`${policyPath}/confirm`, { ...body, idempotency_key: randomUUID() })).statusCode,
    ).toBe(409);
  });
  it("lets API clients request review but records only an interactive exact-candidate receipt", async () => {
    const value = await delivery(),
      requested = await request(value.id, value.delivery);
    expect(requested.confirmationUrl).toContain(`/stories/${value.id}/delivery-acceptance/`);
    expect((await review(value.id, requested.id, headers())).statusCode).toBe(403);
    const reviewed = await review(value.id, requested.id);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const proof = reviewed.json().proof;
    expect((await confirm(value.id, requested.id, proof, headers())).statusCode).toBe(403);
    const idempotencyKey = randomUUID();
    const accepted = await confirm(value.id, requested.id, proof, { cookie }, idempotencyKey);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      required: true,
      status: "current",
      receipt: {
        revision: 1,
        confirmedBy: { type: "user", id: userId },
        snapshot: { candidateRevision: value.delivery.candidate.revision },
      },
    });
    expect(
      (await confirm(value.id, requested.id, proof, { cookie }, idempotencyKey)).json(),
    ).toEqual(accepted.json());
    expect((await confirm(value.id, requested.id, proof)).statusCode).toBe(409);
    expect(
      (await confirm(value.id, requested.id, proof, { cookie: otherCookie }, idempotencyKey))
        .statusCode,
    ).toBe(403);
  });
  it("rejects stale heads, scope confusion, expired requests and bound-user/session substitution", async () => {
    const value = await delivery(),
      requested = await request(value.id, value.delivery);
    const bounded = await request(value.id, value.delivery, { cookie });
    expect((await review(value.id, bounded.id, { cookie: otherCookie })).statusCode).toBe(403);
    const proof = (await review(value.id, requested.id)).json().proof;
    expect((await confirm(value.id, requested.id, proof, { cookie: otherCookie })).statusCode).toBe(
      400,
    );
    const wrongScope = await app.inject({
      url: `${path(value.id).replace(projectId, otherProjectId)}/delivery-acceptance/${requested.id}`,
      headers: { cookie },
    });
    expect(wrongScope.statusCode).toBe(404);
    await db
      .update(githubPullRequests)
      .set({ headSha: "b".repeat(40), syncedAt: new Date() })
      .where(eq(githubPullRequests.repositoryId, repoId));
    expect((await confirm(value.id, requested.id, proof)).statusCode).toBe(409);
    expect((await review(value.id, requested.id)).json().request.status).toBe("superseded");
    await db
      .update(githubPullRequests)
      .set({ headSha: "a".repeat(40), syncedAt: new Date() })
      .where(eq(githubPullRequests.repositoryId, repoId));
    await db
      .update(storyDeliveryAcceptanceRequests)
      .set({ requestedAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000) })
      .where(eq(storyDeliveryAcceptanceRequests.id, requested.id));
    const expired = await confirm(value.id, requested.id, proof);
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe("workflow_confirmation_expired");
  });
  it("serializes concurrent confirmations of the same candidate into one immutable receipt", async () => {
    const value = await delivery();
    const requests = await Promise.all([
      request(value.id, value.delivery),
      request(value.id, value.delivery),
    ]);
    const proofs = await Promise.all(
      requests.map(async (item) => (await review(value.id, item.id)).json().proof),
    );
    const results = await Promise.all(
      requests.map((item, index) => confirm(value.id, item.id, proofs[index])),
    );
    expect(results.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const receipts = await db
      .select()
      .from(storyDeliveryAcceptances)
      .where(eq(storyDeliveryAcceptances.storyId, value.id));
    expect(receipts).toHaveLength(1);
    await savePolicy(policy({ holdAfterFailure: true }));
    const stale = await app.inject({
      url: `${path(value.id)}/delivery-acceptance`,
      headers: headers(),
    });
    expect(stale.json().status).toBe("stale");
    await savePolicy();
  });
  it("requires a current preview only when configured and rejects inaccessible delivery reads", async () => {
    await savePolicy(policy({ requirePreviewForAcceptance: true }));
    const value = await delivery();
    const response = await post(
      `${path(value.id)}/delivery-acceptance`,
      {
        expected_candidate_revision: value.delivery.candidate.revision,
        expected_plan_revision: 0,
        expected_decision_revision: 0,
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("workflow_preview_not_ready");
    expect((await app.inject({ url: `${path(value.id)}/workflow` })).statusCode).toBe(401);
    await savePolicy();
  });
  it("denies gated story startup before creating or waking compute", async () => {
    await savePolicy(policy({ planApprovalAgents: ["builder"] }));
    const builder = (await domain.catalog.sync(orgId, projectId)).find(
      (agent) => agent.name === "builder",
    );
    if (!builder) throw Error("Missing configured builder");
    await expect(
      domain.stories.start({
        orgId,
        projectId,
        provider: "manual",
        externalId: randomUUID(),
        title: "Gated startup",
        agent: builder,
        actor: { type: "user", id: userId },
        message: "Build",
        messageDedupeKey: randomUUID(),
        workspace: { image: "fixture" },
      }),
    ).rejects.toMatchObject({ code: "workflow_plan_approval_required" });
    await savePolicy();
  });
  it.each([
    "manual",
    "mcp",
    "schedule",
    "github",
  ])("holds %s work durably at the shared dispatcher before budget reservation", async (triggerType) => {
    await savePolicy(policy({ planApprovalAgents: ["builder"] }));
    const value = await delivery();
    const builder = (await domain.catalog.sync(orgId, projectId)).find(
      (agent) => agent.name === "builder",
    );
    if (!builder) throw Error("Missing builder");
    const conversationId = newId("sess"),
      turnId = newId("turn");
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId, projectId, storyId: value.id });
    await db.insert(turns).values({
      id: turnId,
      orgId,
      projectId,
      storyId: value.id,
      conversationId,
      agentName: "builder",
      manifestHash: builder.hash,
      manifest: builder,
      engine: builder.engine,
      model: builder.model,
      triggerType,
      createdBy: { type: "user", id: userId },
    });
    const reserve = vi.spyOn(domain.costs, "reserveTurn");
    expect(await domain.dispatcher.dispatch({ orgId, projectId, turnId })).toMatchObject({
      claimed: false,
      state: "held",
      code: "workflow_plan_approval_required",
    });
    expect(reserve).not.toHaveBeenCalled();
    reserve.mockRestore();
    const [held] = await db.select().from(turns).where(eq(turns.id, turnId));
    expect(held?.state).toBe("queued");
    expect(held?.retryAfter).toBeInstanceOf(Date);
    expect(
      await db.select().from(budgetReservations).where(eq(budgetReservations.turnId, turnId)),
    ).toHaveLength(0);
    const workflow = await app.inject({ url: `${path(value.id)}/workflow`, headers: headers() });
    expect(workflow.json()).toMatchObject({
      queuedAgents: ["builder"],
      blockedReason: expect.stringContaining("approve"),
    });
    await db
      .update(turns)
      .set({ state: "canceled", endedAt: new Date() })
      .where(eq(turns.id, turnId));
    await savePolicy();
  });
  it("can hold admission with a single database connection without a nested pool checkout", async () => {
    await savePolicy(policy({ planApprovalAgents: ["builder"] }));
    const value = await delivery();
    const builder = (await domain.catalog.sync(orgId, projectId)).find(
      (agent) => agent.name === "builder",
    );
    if (!builder) throw Error("Missing builder");
    const conversationId = newId("sess"),
      turnId = newId("turn");
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId, projectId, storyId: value.id });
    await db.insert(turns).values({
      id: turnId,
      orgId,
      projectId,
      storyId: value.id,
      conversationId,
      agentName: "builder",
      manifestHash: builder.hash,
      manifest: builder,
      engine: builder.engine,
      model: builder.model,
      triggerType: "manual",
      createdBy: { type: "user", id: userId },
    });
    const single = createDb(databaseUrl, { max: 1 });
    const isolated = createStoryDomain({
      db: single.db,
      config,
      runtime,
      enqueue,
      githubFactory: async () => {
        throw Error("No external client before admission");
      },
    });
    const dispatch = isolated.dispatcher.dispatch({ orgId, projectId, turnId });
    void dispatch.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          dispatch,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Admission requested another pooled connection")),
              2000,
            );
          }),
        ]),
      ).toMatchObject({ state: "held" });
    } finally {
      if (timer) clearTimeout(timer);
      await single.client.end({ timeout: 1 });
      await db
        .update(turns)
        .set({ state: "canceled", endedAt: new Date() })
        .where(eq(turns.id, turnId));
      await savePolicy();
    }
  });

  it("binds permitted execution to the approved agent/repositories and revokes it after plan changes", async () => {
    await savePolicy(policy({ planApprovalAgents: ["builder"] }));
    const value = await delivery();
    const builder = (await domain.catalog.sync(orgId, projectId)).find(
      (agent) => agent.name === "builder",
    );
    if (!builder) throw Error("Missing builder");
    const scope = { orgId, projectId, storyId: value.id };
    const conversationId = newId("sess"),
      turnId = newId("turn");
    await db.insert(storyConversations).values({ id: conversationId, ...scope });
    await db.insert(turns).values({
      id: turnId,
      ...scope,
      conversationId,
      agentName: "builder",
      manifestHash: builder.hash,
      manifest: builder,
      engine: builder.engine,
      model: builder.model,
      triggerType: "manual",
      createdBy: { type: "user", id: userId },
    });
    expect(await domain.dispatcher.dispatch({ orgId, projectId, turnId })).toMatchObject({
      state: "held",
    });
    const proposed = await post(
      `${path(value.id)}/plan`,
      {
        expected_revision: 0,
        markdown: "Build and verify a bounded feature",
        repositories: [`${projectId}/app`],
        agents: ["builder"],
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(proposed.statusCode, proposed.body).toBe(200);
    const requested = await post(
      `${path(value.id)}/plan/decisions`,
      {
        expected_revision: 1,
        expected_decision_revision: 0,
        intent: "approve",
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(requested.statusCode, requested.body).toBe(200);
    const requestId = requested.json().request.id;
    const reviewed = await app.inject({
      url: `${path(value.id)}/plan/decisions/${requestId}`,
      headers: { cookie: otherCookie },
    });
    const confirmed = await post(
      `${path(value.id)}/plan/decisions/${requestId}/confirm`,
      {
        proof: reviewed.json().proof,
        idempotency_key: randomUUID(),
      },
      { cookie: otherCookie },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const authorization = await authorizePlanExecution(db, scope, builder, {
      type: "user",
      id: userId,
    });
    expect(authorization).toMatchObject({
      planRevision: 1,
      manifestHash: builder.hash,
      authorizerId: otherUserId,
      repositoryIds: [repoId],
    });
    expect(enqueue).toHaveBeenCalledWith("turns.dispatch", { orgId, projectId, turnId });
    const [released] = await db.select().from(turns).where(eq(turns.id, turnId));
    expect(released?.retryAfter).toBeNull();
    const [running] = await db
      .update(turns)
      .set({ state: "running" })
      .where(eq(turns.id, turnId))
      .returning();
    if (!running) throw Error("Missing running fixture");
    await recordPlanExecution(db, scope, turnId, authorization);
    expect(await planExecutionStillAuthorized(db, scope, running)).toBe(true);
    const weakening = await reviewPolicy(policy());
    const deniedPolicy = await post(`${policyPath}/confirm`, {
      expected_revision: weakening.expectedRevision,
      policy: weakening.policy,
      nonce: weakening.nonce,
      expires_at: weakening.expiresAt,
      proof: weakening.proof,
      idempotency_key: randomUUID(),
    });
    expect(deniedPolicy.statusCode).toBe(409);
    expect(deniedPolicy.json().error.code).toBe("workflow_execution_active");
    await db.update(users).set({ status: "inactive" }).where(eq(users.id, otherUserId));
    try {
      expect(await planExecutionStillAuthorized(db, scope, running)).toBe(false);
    } finally {
      await db.update(users).set({ status: "active" }).where(eq(users.id, otherUserId));
    }
    expect(await planExecutionStillAuthorized(db, scope, running)).toBe(true);
    const extraRepo = newId("repo");
    await db.insert(projectRepositories).values({
      id: extraRepo,
      orgId,
      projectId,
      owner: projectId,
      name: "extra",
      role: "related",
      defaultBranch: "main",
    });
    try {
      expect(await planExecutionStillAuthorized(db, scope, running)).toBe(false);
    } finally {
      await db.delete(projectRepositories).where(eq(projectRepositories.id, extraRepo));
    }
    await db
      .update(agentManifests)
      .set({ manifest: { ...builder, enabled: false } })
      .where(eq(agentManifests.projectId, projectId));
    try {
      expect(await planExecutionStillAuthorized(db, scope, running)).toBe(false);
    } finally {
      await db
        .update(agentManifests)
        .set({ manifest: builder })
        .where(eq(agentManifests.projectId, projectId));
    }
    expect(await planExecutionStillAuthorized(db, scope, running)).toBe(true);
    const changed = await post(
      `${path(value.id)}/plan`,
      {
        expected_revision: 1,
        markdown: "Changed scope requiring a new decision",
        repositories: [`${projectId}/app`],
        agents: ["builder"],
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await planExecutionStillAuthorized(db, scope, running)).toBe(false);
    await db
      .update(turns)
      .set({ state: "canceled", endedAt: new Date() })
      .where(eq(turns.id, turnId));
    await savePolicy();
  });
  it("holds successors after a failure until a later interactive decision", async () => {
    await savePolicy(policy({ holdAfterFailure: true }));
    const value = await delivery();
    const builder = (await domain.catalog.sync(orgId, projectId)).find(
      (agent) => agent.name === "builder",
    );
    if (!builder) throw Error("Missing builder");
    const proposed = await post(
      `${path(value.id)}/plan`,
      {
        expected_revision: 0,
        markdown: "Recover a bounded failed change",
        repositories: [`${projectId}/app`],
        agents: ["builder"],
        idempotency_key: randomUUID(),
      },
      headers(),
    );
    expect(proposed.statusCode, proposed.body).toBe(200);
    async function approve(expectedDecision: number) {
      const request = await post(
        `${path(value.id)}/plan/decisions`,
        {
          expected_revision: 1,
          expected_decision_revision: expectedDecision,
          intent: "approve",
          idempotency_key: randomUUID(),
        },
        headers(),
      );
      expect(request.statusCode, request.body).toBe(200);
      const url = `${path(value.id)}/plan/decisions/${request.json().request.id}`;
      const reviewed = await app.inject({ url, headers: { cookie } });
      const confirmed = await post(`${url}/confirm`, {
        proof: reviewed.json().proof,
        idempotency_key: randomUUID(),
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
    }
    await approve(0);
    await db
      .update(storyPlanDecisions)
      .set({ confirmedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(storyPlanDecisions.storyId, value.id));
    const scope = { orgId, projectId, storyId: value.id },
      conversationId = newId("sess");
    await db.insert(storyConversations).values({ id: conversationId, ...scope });
    await db.insert(turns).values({
      id: newId("turn"),
      ...scope,
      conversationId,
      agentName: "builder",
      manifestHash: builder.hash,
      manifest: builder,
      engine: builder.engine,
      model: builder.model,
      state: "failed",
      endedAt: new Date("2021-01-01T00:00:00Z"),
      triggerType: "manual",
      createdBy: { type: "user", id: userId },
    });
    await expect(
      authorizePlanExecution(db, scope, builder, { type: "user", id: userId }),
    ).rejects.toMatchObject({ code: "workflow_previous_turn_failed" });
    await approve(1);
    expect(
      await authorizePlanExecution(db, scope, builder, { type: "user", id: userId }),
    ).toMatchObject({ decisionRevision: 2 });
    await savePolicy();
  });
});
