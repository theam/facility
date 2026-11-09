import { randomUUID } from "node:crypto";
import { costCents, newId } from "@facility/core";
import {
  budgetReservations,
  githubPullRequests,
  modelCalls,
  orgMembers,
  projectRepositories,
  roles,
  stories,
  storyConsultations,
  storyConversations,
  storyMessages,
  turns,
  users,
} from "@facility/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService, GithubAgentCatalogSource } from "../src/agents/catalog.js";
import { CostBudgetService } from "../src/insights/costs.js";
import { replaceStoryDelivery } from "../src/stories/delivery.js";
import {
  confirmStoryPlanDecision,
  proposeStoryPlan,
  requestStoryPlanDecision,
  reviewStoryPlanDecision,
} from "../src/stories/plans.js";
import { consultationTestEnvironment } from "./fixtures/consultations.js";

let env: Awaited<ReturnType<typeof consultationTestEnvironment>>;
beforeAll(async () => {
  env = await consultationTestEnvironment();
});
afterAll(async () => {
  await env?.client.end();
});

it("completes an admitted context with two verified 8 KiB source snapshots", async () => {
  const f = await env.fixture();
  f.state.sourceText = "a".repeat(8192);
  const options = await f.service.options(f.scope, "ui", { costsVisible: true });
  expect(options.agents[0]?.eligible).toBe(true);
  const body = await f.body(true);
  const first = body.sources[0];
  if (!first) throw Error("Expected selected source");
  f.octokit.rest.git.getCommit.mockImplementation(async (args) => ({
    data: {
      sha: String(args.commit_sha),
      tree: { sha: "b".repeat(40) },
    },
  }));
  body.sources.push({ ...first, commit_sha: "d".repeat(40) });
  const queued = await f.service.request(f.scope, body, f.actor, "ui");
  expect(queued.state).toBe("queued");
  await f.service.dispatch({ ...f.scope, consultationId: queued.id });
  const final = await f.service.get(f.scope, queued.id, { costsVisible: true });
  expect(final).toMatchObject({ state: "succeeded", billing: { state: "confirmed" } });
  expect(final.context.files).toHaveLength(2);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.mutation).not.toHaveBeenCalled();
  expect(
    await env.db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.storyId, f.scope.storyId)),
  ).toEqual([]);
});
const job = (
  scope: { orgId: string; projectId: string; storyId: string },
  consultationId: string,
) => ({ ...scope, consultationId });
async function stored(id: string) {
  return (await env.db.select().from(storyConsultations).where(eq(storyConsultations.id, id)))[0];
}

describe("isolated consultation persistence and accounting", () => {
  it("pins the existing plan, recorded decision and complete PR observations without exposing confirmation material", async () => {
    const f = await env.fixture();
    await env.db
      .update(roles)
      .set({ permissions: ["projects:read", "projects:write", "workspaces:execute"] })
      .where(eq(roles.id, f.roleId));
    const catalog = new AgentCatalogService(
      env.db,
      new GithubAgentCatalogSource(env.db, async () => f.octokit),
    );
    const options = { webUrl: "https://facility.test" };
    const proposal = {
      expected_revision: 0,
      markdown: "Preserve the stored preferences and add the settings page.",
      repositories: [`example/${f.scope.projectId}`],
      agents: ["reviewer"],
      idempotency_key: randomUUID(),
    };
    await proposeStoryPlan(env.db, catalog, f.scope, proposal, f.actor, options);
    const requested = await requestStoryPlanDecision(
      env.db,
      f.scope,
      {
        expected_revision: 1,
        expected_decision_revision: 0,
        intent: "approve",
        idempotency_key: randomUUID(),
      },
      f.actor,
      options,
    );
    const actor = {
      id: f.userId,
      name: f.actor.name,
      sessionCookie: "synthetic-private-browser-session",
    };
    const masterKey = Buffer.alloc(32, 69).toString("base64");
    const review = await reviewStoryPlanDecision(
      env.db,
      f.scope,
      requested.request.id,
      actor,
      masterKey,
      options,
    );
    if (!review.proof) throw Error("Missing interactive test proof");
    await confirmStoryPlanDecision(
      env.db,
      f.scope,
      requested.request.id,
      review.proof,
      actor,
      masterKey,
      options,
    );
    await env.db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId: f.scope.orgId,
      projectId: f.scope.projectId,
      repositoryId: f.repositoryId,
      number: 12,
      title: "Settings page",
      state: "open",
      headRef: "feature/settings",
      baseRef: "main",
      headSha: "a".repeat(40),
      ciState: "success",
      ciHeadSha: "a".repeat(40),
      ciUpdatedAt: new Date(),
      htmlUrl: `https://github.com/example/${f.scope.projectId}/pull/12`,
    });
    await replaceStoryDelivery(
      env.db,
      f.scope,
      {
        expected_revision: 0,
        declared_complete: true,
        pull_requests: [
          { repository: `example/${f.scope.projectId}`, number: 12, required: true, primary: true },
        ],
        idempotency_key: randomUUID(),
      },
      f.actor,
    );
    const receipt = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    expect(receipt.context.taskState).toMatchObject({
      planRevision: 1,
      decisionRevision: 1,
      deliveryScopeRevision: 1,
    });
    await proposeStoryPlan(
      env.db,
      catalog,
      f.scope,
      {
        ...proposal,
        expected_revision: 1,
        markdown: "A newer proposal, which must not replace the captured one.",
        idempotency_key: randomUUID(),
      },
      f.actor,
      options,
    );
    await env.db
      .update(githubPullRequests)
      .set({ headSha: "b".repeat(40) })
      .where(eq(githubPullRequests.repositoryId, f.repositoryId));
    await f.service.dispatch(job(f.scope, receipt.id));
    const sent = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    const persisted = await stored(receipt.id);
    if (!persisted?.contextPrompt) throw Error("Missing captured prompt");
    expect(sent.input.endsWith(persisted.contextPrompt)).toBe(true);
    const snapshot = JSON.parse(persisted.contextPrompt);
    expect(snapshot.taskState.plans).toMatchObject({
      state: { revision: 1, decisionRevision: 1, status: "approved" },
      plan: { markdown: proposal.markdown },
      decision: { intent: "approve", method: "interactive_session" },
    });
    expect(snapshot.taskState.delivery).toMatchObject({
      scope: { revision: 1, declaredComplete: true },
      pullRequests: [
        { number: 12, headSha: "a".repeat(40), checks: { state: "success", current: true } },
      ],
    });
    expect(sent.input).not.toContain("newer proposal");
    expect(sent.input).not.toContain(actor.sessionCookie);
    expect(sent.input).not.toContain(review.proof);
    expect(sent.input).not.toContain("confirmationUrl");
    expect((await f.service.get(f.scope, receipt.id)).context.taskState).toEqual(
      receipt.context.taskState,
    );
  });

  it("identifies an oversized plan without silently supplying a partial plan as the whole text", async () => {
    const f = await env.fixture();
    const catalog = new AgentCatalogService(
      env.db,
      new GithubAgentCatalogSource(env.db, async () => f.octokit),
    );
    await proposeStoryPlan(
      env.db,
      catalog,
      f.scope,
      {
        expected_revision: 0,
        markdown: "Long plan. ".repeat(1500),
        repositories: [`example/${f.scope.projectId}`],
        agents: ["reviewer"],
        idempotency_key: randomUUID(),
      },
      f.actor,
      { webUrl: "https://facility.test" },
    );
    const receipt = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    await f.service.dispatch(job(f.scope, receipt.id));
    const persisted = await stored(receipt.id);
    if (!persisted?.contextPrompt) throw Error("Missing captured prompt");
    expect(
      JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body)).input.endsWith(persisted.contextPrompt),
    ).toBe(true);
    const snapshot = JSON.parse(persisted.contextPrompt);
    expect(snapshot.taskState.plans.plan).toMatchObject({
      revision: 1,
      markdown: null,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await f.service.get(f.scope, receipt.id)).context.omissions.join(" ")).toContain(
      "Plan revision 1 text exceeds 12000 bytes",
    );
  });

  it("saves a scoped snapshot and one bill without creating a native turn or queue message", async () => {
    const f = await env.fixture();
    const consultation = await f.service.request(f.scope, await f.body(true), f.actor, "ui");
    expect(consultation).toMatchObject({
      state: "queued",
      context: { hash: null, omittedMessages: null },
      billing: { costsVisible: false, costCents: null },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.service.dispatch(job(f.scope, consultation.id))).resolves.toMatchObject({
      claimed: true,
      state: "succeeded",
    });
    const final = await f.service.get(f.scope, consultation.id, { costsVisible: true });
    expect(final).toMatchObject({
      state: "succeeded",
      result: f.state.output,
      context: {
        throughMessageSeq: 1,
        workspaceFilesIncluded: false,
        omittedMessages: 0,
        summaryIncluded: true,
        files: [{ repositoryId: f.repositoryId, commitSha: f.state.fileSha, path: "src/app.ts" }],
      },
      billing: {
        state: "confirmed",
        costCents: costCents({ model: "gpt-5.5", inputTokens: 100, outputTokens: 10 }),
      },
    });
    expect(
      await env.db.select().from(turns).where(eq(turns.storyId, f.scope.storyId)),
    ).toHaveLength(1);
    expect(
      await env.db.select().from(storyMessages).where(eq(storyMessages.storyId, f.scope.storyId)),
    ).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.mutation).not.toHaveBeenCalled();
    const handoff = await f.service.handoff(f.scope, consultation.id);
    expect(handoff).toMatchObject({
      consultationId: consultation.id,
      resultHash: final.resultHash,
      requiresExplicitSend: true,
    });
    expect(handoff.message).toContain(final.result ?? "missing result");
    expect(
      await env.db.select().from(turns).where(eq(turns.storyId, f.scope.storyId)),
    ).toHaveLength(1);
    expect((await f.service.get(f.scope, consultation.id)).billing).toMatchObject({
      costsVisible: false,
      costCents: null,
      estimatedCents: null,
      state: "confirmed",
    });
  });

  it("deduplicates simultaneous requests and worker deliveries, including replay after completion", async () => {
    const f = await env.fixture(),
      body = await f.body();
    const [a, b] = await Promise.all([
      f.service.request(f.scope, body, f.actor, "ui"),
      f.service.request(f.scope, body, f.actor, "ui"),
    ]);
    expect(a.id).toBe(b.id);
    await Promise.all([
      f.service.dispatch(job(f.scope, a.id)),
      f.service.dispatch(job(f.scope, b.id)),
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.service.request(f.scope, body, f.actor, "ui")).id).toBe(a.id);
    expect(await f.service.dispatch(job(f.scope, a.id))).toEqual({ claimed: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await expect(
      f.service.request(f.scope, { ...body, message: "Changed intent" }, f.actor, "ui"),
    ).rejects.toMatchObject({ code: "consultation_idempotency_conflict" });
  });

  it("rejects another active consultation and canceled requests never call the provider", async () => {
    const f = await env.fixture(),
      body = await f.body();
    const a = await f.service.request(f.scope, body, f.actor, "ui");
    await expect(
      f.service.request(f.scope, { ...body, idempotency_key: randomUUID() }, f.actor, "ui"),
    ).rejects.toMatchObject({ code: "consultation_concurrency_limit" });
    expect(await f.service.cancel(f.scope, a.id)).toMatchObject({ state: "canceled" });
    expect(await f.service.dispatch(job(f.scope, a.id))).toEqual({ claimed: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      await env.db.select().from(modelCalls).where(eq(modelCalls.storyId, f.scope.storyId)),
    ).toEqual([]);
    await expect(f.service.handoff(f.scope, a.id)).rejects.toMatchObject({
      code: "consultation_not_complete",
    });
  });

  it.each([
    "role",
    "membership",
    "user",
  ])("rechecks revoked %s authority before reading sources or paying", async (kind) => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(true), f.actor, "ui");
    if (kind === "role")
      await env.db
        .update(roles)
        .set({ permissions: ["projects:read"] })
        .where(eq(roles.id, f.roleId));
    if (kind === "membership")
      await env.db.delete(orgMembers).where(eq(orgMembers.userId, f.userId));
    if (kind === "user")
      await env.db.update(users).set({ status: "inactive" }).where(eq(users.id, f.userId));
    await f.service.dispatch(job(f.scope, a.id));
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_authorization_revoked",
    });
    expect(f.githubRequest).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rechecks authority after source preparation and rolls an unstarted claim back to unbilled", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(true), f.actor, "ui");
    let release!: () => void;
    f.state.sourceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = f.service.dispatch(job(f.scope, a.id));
    await vi.waitFor(() => expect(f.githubRequest).toHaveBeenCalled());
    await env.db
      .update(roles)
      .set({ permissions: ["projects:read"] })
      .where(eq(roles.id, f.roleId));
    release();
    await running;
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_authorization_revoked",
      billing: { state: "unbilled" },
    });
  });

  it("denies changed agent configuration and changed source connections before a call", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    f.state.catalogSha = "d".repeat(40);
    f.state.model = "gpt-5.5-mini";
    await f.service.dispatch(job(f.scope, a.id));
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_configuration_changed",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    const g = await env.fixture();
    const b = await g.service.request(g.scope, await g.body(true), g.actor, "ui");
    await env.db
      .update(projectRepositories)
      .set({ defaultBranch: "another" })
      .where(eq(projectRepositories.id, g.repositoryId));
    await g.service.dispatch(job(g.scope, b.id));
    expect(await g.service.get(g.scope, b.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_repository_changed",
    });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("does not substitute providers when the selected key or model is unsupported", async () => {
    const f = await env.fixture();
    const body = await f.body();
    f.state.keyAvailable = false;
    await expect(f.service.request(f.scope, body, f.actor, "ui")).rejects.toMatchObject({
      code: "consultation_credentials_unavailable",
    });
    f.state.keyAvailable = true;
    f.state.model = "gpt-5.6";
    const unsupported = await f.body();
    await expect(f.service.request(f.scope, unsupported, f.actor, "ui")).rejects.toMatchObject({
      code: "model_api_unsupported",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      await env.db
        .select()
        .from(storyConsultations)
        .where(eq(storyConsultations.storyId, f.scope.storyId)),
    ).toEqual([]);
  });

  it.each([
    ["claude_code", "claude-haiku-4-5", "high"],
    ["codex", "gpt-5.5", "minimal"],
    ["codex", "gpt-5.5", "max"],
    ["codex", "gpt-5.6-sol", "minimal"],
  ])("denies unsupported %s/%s effort %s before reserving budget", async (engine, model, effort) => {
    const f = await env.fixture();
    f.state.engine = engine;
    f.state.model = model;
    f.state.reasoningEffort = effort;
    await expect(f.service.request(f.scope, await f.body(), f.actor, "ui")).rejects.toMatchObject({
      code: "reasoning_api_unsupported",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      await env.db
        .select()
        .from(storyConsultations)
        .where(eq(storyConsultations.storyId, f.scope.storyId)),
    ).toEqual([]);
    expect(
      await env.db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.projectId, f.scope.projectId)),
    ).toEqual([]);
  });

  it("denies cross-project, cross-tenant and foreign-repository inputs without inference", async () => {
    const f = await env.fixture(),
      other = await env.fixture(env.otherOrgId);
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    await expect(other.service.get(other.scope, a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.service.request(
        { ...f.scope, projectId: other.scope.projectId },
        await f.body(),
        f.actor,
        "ui",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const body = await other.body();
    body.sources = [
      { repository_id: f.repositoryId, commit_sha: f.state.fileSha, path: "src/app.ts" },
    ];
    await expect(other.service.request(other.scope, body, other.actor, "ui")).rejects.toMatchObject(
      { code: "consultation_repository_unavailable" },
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(other.fetch).not.toHaveBeenCalled();
  });

  it("expires queued intent without a provider attempt", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    await env.db
      .update(storyConsultations)
      .set({ createdAt: new Date(Date.now() - 300_000), expiresAt: new Date(Date.now() - 180_000) })
      .where(eq(storyConsultations.id, a.id));
    await f.service.dispatch(job(f.scope, a.id));
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_expired",
      billing: { state: "not_started" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("blocks shared native/title spending after a lost provider reply and does not retry the call", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    f.state.providerError = new Error("synthetic-provider-key");
    await f.service.dispatch(job(f.scope, a.id));
    const value = await f.service.get(f.scope, a.id, { costsVisible: true });
    expect(value).toMatchObject({
      state: "failed",
      errorCode: "provider_request_failed",
      billing: { state: "unconfirmed", costCents: null },
    });
    expect(JSON.stringify(value)).not.toContain("synthetic-provider-key");
    const costs = new CostBudgetService(env.db);
    expect((await costs.budgetState(f.scope.orgId, f.scope.projectId)).state).toBe("unconfirmed");
    await expect(
      costs.assertTurnAllowed(f.scope.orgId, f.scope.projectId, "gpt-5.5"),
    ).rejects.toMatchObject({ code: "budget_usage_unconfirmed" });
    expect(await costs.reserveTitle({ ...f.scope, model: "gpt-5.5-mini" })).toEqual({
      outcome: "unconfirmed",
    });
    await f.service.dispatch(job(f.scope, a.id));
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks shared admission as soon as a started consultation loses its worker lease", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    let release!: () => void;
    f.state.providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.ignoreAbort = true;
    const running = f.service.dispatch(job(f.scope, a.id));
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    const costs = new CostBudgetService(env.db);
    try {
      await env.db
        .update(storyConsultations)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(storyConsultations.id, a.id));
      expect((await costs.budgetState(f.scope.orgId, f.scope.projectId)).state).toBe("unconfirmed");
      await expect(
        costs.assertTurnAllowed(f.scope.orgId, f.scope.projectId, "gpt-5.5"),
      ).rejects.toMatchObject({ code: "budget_usage_unconfirmed" });
      expect(await costs.reserveTitle({ ...f.scope, model: "gpt-5.5-mini" })).toEqual({
        outcome: "unconfirmed",
      });
    } finally {
      release();
      await running;
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await costs.budgetState(f.scope.orgId, f.scope.projectId)).state).toBe("ok");
  });

  it("cancels a submitted call without treating an absent receipt as zero or retrying inference", async () => {
    const f = await env.fixture();
    const receipt = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    f.state.providerGate = new Promise<void>(() => undefined);
    const running = f.service.dispatch(job(f.scope, receipt.id));
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    await f.service.cancel(f.scope, receipt.id);
    await running;
    expect(await f.service.get(f.scope, receipt.id)).toMatchObject({
      state: "canceled",
      result: null,
      errorCode: "consultation_canceled",
      billing: { state: "unconfirmed" },
    });
    expect(await f.service.dispatch(job(f.scope, receipt.id))).toEqual({ claimed: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(
      (await new CostBudgetService(env.db).budgetState(f.scope.orgId, f.scope.projectId)).state,
    ).toBe("unconfirmed");
  });

  it("settles a final receipt after recovery without reviving the failed consultation or paying twice", async () => {
    const f = await env.fixture();
    const receipt = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    let release!: () => void;
    f.state.providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.ignoreAbort = true;
    const running = f.service.dispatch(job(f.scope, receipt.id));
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    try {
      await env.db
        .update(storyConsultations)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(storyConsultations.id, receipt.id));
      await f.service.recover();
      expect(await f.service.get(f.scope, receipt.id)).toMatchObject({
        state: "failed",
        result: null,
        errorCode: "consultation_worker_interrupted",
        billing: { state: "unconfirmed" },
      });
    } finally {
      release();
      await running;
    }
    expect(await f.service.get(f.scope, receipt.id, { costsVisible: true })).toMatchObject({
      state: "failed",
      result: null,
      resultHash: null,
      errorCode: "consultation_worker_interrupted",
      billing: {
        state: "confirmed",
        costCents: costCents({ model: "gpt-5.5", inputTokens: 100, outputTokens: 10 }),
      },
    });
    await expect(f.service.handoff(f.scope, receipt.id)).rejects.toMatchObject({
      code: "consultation_not_complete",
    });
    expect(await f.service.dispatch(job(f.scope, receipt.id))).toEqual({ claimed: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(
      (await new CostBudgetService(env.db).budgetState(f.scope.orgId, f.scope.projectId)).state,
    ).toBe("ok");
  });

  it("limits queued consultations across stories in one project before any provider call", async () => {
    const f = await env.fixture();
    const body = await f.body();
    await f.service.request(f.scope, body, f.actor, "ui");
    for (let index = 1; index <= 4; index++) {
      const storyId = newId("story");
      await env.db.insert(stories).values({
        orgId: f.scope.orgId,
        projectId: f.scope.projectId,
        id: storyId,
        provider: "manual",
        externalId: storyId,
        title: "Another scoped consultation",
        titleSource: "user",
        createdBy: { type: "user", id: f.userId },
      });
      await env.db.insert(storyConversations).values({ ...f.scope, storyId, id: newId("sess") });
      const request = f.service.request(
        { ...f.scope, storyId },
        { ...body, idempotency_key: randomUUID() },
        f.actor,
        "ui",
      );
      if (index < 4) await expect(request).resolves.toMatchObject({ state: "queued" });
      else await expect(request).rejects.toMatchObject({ code: "consultation_concurrency_limit" });
    }
    expect(f.enqueue).toHaveBeenCalledTimes(4);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects a foreign model-call link at the database boundary", async () => {
    const f = await env.fixture(),
      other = await env.fixture(env.otherOrgId);
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    const b = await other.service.request(other.scope, await other.body(), other.actor, "ui");
    await f.service.dispatch(job(f.scope, a.id));
    await other.service.dispatch(job(other.scope, b.id));
    const before = await stored(a.id),
      foreign = await stored(b.id);
    if (!before || !foreign?.modelCallId) throw Error("Missing billed consultation");
    await expect(
      env.db
        .update(storyConsultations)
        .set({ modelCallId: foreign.modelCallId })
        .where(eq(storyConsultations.id, a.id)),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint_name: "story_consultations_model_call_scope_fk" },
    });
    expect((await stored(a.id))?.modelCallId).toBe(before.modelCallId);
  });

  it("preserves the message watermark, excludes later conversation and labels truncated results", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    await env.db.insert(storyMessages).values({
      id: `msg_${randomUUID()}`,
      ...f.scope,
      conversationId: f.conversationId,
      seq: 2,
      role: "user",
      body: "A later request must not enter this snapshot",
      actor: { type: "user", id: f.userId },
      turnId: f.previousTurnId,
    });
    f.state.outcome = "incomplete";
    await f.service.dispatch(job(f.scope, a.id));
    const body = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    expect(body.input).toContain("Earlier task request");
    expect(body.input).not.toContain("A later request");
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "incomplete",
      billing: { state: "confirmed" },
      context: { throughMessageSeq: 1 },
    });
    await expect(f.service.handoff(f.scope, a.id)).rejects.toMatchObject({
      code: "consultation_not_complete",
    });
  });

  it("rolls back publication and billing together, keeps the hold and refuses a repeated provider call", async () => {
    const f = await env.fixture();
    const a = await f.service.request(f.scope, await f.body(), f.actor, "ui");
    const functionName = `consult_fail_${randomUUID().replaceAll("-", "")}`;
    await env.db.execute(
      sql.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${a.id}' AND NEW.state = 'succeeded' THEN RAISE EXCEPTION 'simulated publication failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await env.db.execute(
      sql.raw(
        `CREATE TRIGGER ${functionName} BEFORE UPDATE ON story_consultations FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    try {
      await expect(f.service.dispatch(job(f.scope, a.id))).rejects.toThrow();
    } finally {
      await env.db.execute(sql.raw(`DROP TRIGGER ${functionName} ON story_consultations`));
      await env.db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
    expect(await stored(a.id)).toMatchObject({ state: "running", result: null });
    expect(
      await env.db.select().from(modelCalls).where(eq(modelCalls.storyId, f.scope.storyId)),
    ).toMatchObject([{ state: "started", costCents: null }]);
    expect(
      await env.db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.storyId, f.scope.storyId)),
    ).toHaveLength(1);
    await f.service.dispatch(job(f.scope, a.id));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await env.db
      .update(storyConsultations)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(storyConsultations.id, a.id));
    await f.service.recover();
    expect(await f.service.get(f.scope, a.id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_worker_interrupted",
      billing: { state: "unconfirmed" },
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
