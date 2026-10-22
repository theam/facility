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
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyCompletionOperations,
  storyDeliveryIntegrations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  workspaces,
} from "@facility/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

describe("durable delivery integration, notices and source completion", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = "org_local";
  const otherOrgId = newId("org");
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const sourceRepositoryId = newId("repo");
  const integrationRepositoryId = newId("repo");
  const secondIntegrationRepositoryId = newId("repo");
  const storyId = newId("story");
  const workspaceId = newId("ws");
  const installationId = newId("ghi");
  const installationNumber = Math.floor(Math.random() * 1_000_000_000);
  const pullNumber = 41;
  const issueNumber = 77;
  const scope = { orgId, projectId, storyId };
  const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const enqueue = vi.fn(async (queue: string, data: Record<string, unknown>) => {
    enqueued.push({ queue, data });
  });
  let dispatchFailures = 0;
  let completionFailures = 0;
  const githubRequest = vi.fn(async (route: string, args: Record<string, unknown> = {}) => {
    if (route === "POST /repos/{owner}/{repo}/dispatches") {
      if (dispatchFailures-- > 0) throw Object.assign(new Error("unavailable"), { status: 503 });
      return { data: {} };
    }
    if (route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}") {
      if (completionFailures-- > 0)
        throw Object.assign(new Error("accepted response lost"), { status: 503 });
      return {
        data: {
          number: args.issue_number,
          state: "closed",
          closed_at: "2026-10-22T12:30:00.000Z",
        },
      };
    }
    throw new Error(`unexpected GitHub route ${route}`);
  });
  const githubFactory: GithubClientFactory = async () =>
    ({ request: githubRequest, rest: {} }) as unknown as Octokit;
  const runtime = new FakeWorkspaceRuntime();
  const suspend = vi.spyOn(runtime, "suspend").mockResolvedValue();
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 13).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const credentials: Record<string, string> = {};
  const domain = createStoryDomain({ db, config, runtime, enqueue, githubFactory });
  let app: Awaited<ReturnType<typeof buildApp>>;

  const completionPath = (project = projectId, story = storyId) =>
    `/v1/projects/${project}/workspace-stories/${story}/completion`;
  const headers = (name: string) => ({ authorization: `Bearer ${credentials[name]}` });

  async function key(
    name: string,
    tenant: string,
    project: string,
    roleId: string,
    revokedAt: Date | null = null,
  ) {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId: tenant,
      name: `${name}-${suffix}`,
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId: project,
      roleId,
      revokedAt,
    });
    credentials[name] = generated.secret;
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({ id: otherOrgId, name: "Other", slug: `completion-${suffix}` });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Completion", slug: `completion-${suffix}` },
      { id: otherProjectId, orgId: otherOrgId, name: "Other", slug: `other-${suffix}` },
    ]);
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: installationNumber,
      accountId: installationNumber,
      accountLogin: `completion-${suffix}`,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: sourceRepositoryId,
        orgId,
        projectId,
        installationId,
        owner: `example-${suffix}`,
        name: "source",
        defaultBranch: "main",
        role: "primary",
      },
      {
        id: integrationRepositoryId,
        orgId,
        projectId,
        installationId,
        owner: `example-${suffix}`,
        name: "integration",
        defaultBranch: "main",
        role: "related",
      },
      {
        id: secondIntegrationRepositoryId,
        orgId,
        projectId,
        installationId,
        owner: `example-${suffix}`,
        name: "integration-two",
        defaultBranch: "main",
        role: "related",
      },
    ]);
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId,
      projectId,
      repositoryId: sourceRepositoryId,
      number: issueNumber,
      title: "Ship a bounded delivery",
      state: "open",
      htmlUrl: `https://github.com/example-${suffix}/source/issues/${issueNumber}`,
      syncedAt: new Date(),
    });
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repositoryId: sourceRepositoryId,
      number: pullNumber,
      title: "Ship the delivery",
      state: "merged",
      draft: false,
      headRef: "feature/completion",
      baseRef: "main",
      headSha: "a".repeat(40),
      htmlUrl: `https://github.com/example-${suffix}/source/pull/${pullNumber}`,
      syncedAt: new Date(),
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      repositoryId: sourceRepositoryId,
      provider: "github",
      externalId: `issue:${issueNumber}`,
      title: "Ship a bounded delivery",
      status: "review",
      createdBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(storyDeliveryScopes).values({
      ...scope,
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(storyDeliveryPullRequests).values({
      ...scope,
      repositoryId: sourceRepositoryId,
      pullNumber,
      required: true,
      isPrimary: true,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      ...scope,
      provider: "fake",
      externalRef: `fake:${workspaceId}`,
      state: "running",
      volumeRef: `retained://${workspaceId}`,
      environment: { image: "facility-runner:test", ports: [] },
    });
    const operatorRole = newId("role");
    const resultRole = newId("role");
    const otherOwnerRole = newId("role");
    await db.insert(roles).values([
      {
        id: operatorRole,
        orgId,
        name: `completion-operator-${suffix}`,
        permissions: [
          "projects:read",
          "projects:write",
          "repos:write",
          "stories:write",
          "github:write",
        ],
      },
      {
        id: resultRole,
        orgId,
        name: `completion-result-${suffix}`,
        permissions: ["projects:read", "stories:write"],
      },
      {
        id: otherOwnerRole,
        orgId: otherOrgId,
        name: `completion-other-${suffix}`,
        permissions: ["*"],
      },
    ]);
    await key("operator", orgId, projectId, operatorRole);
    await key("result", orgId, projectId, resultRole);
    await key("viewer", orgId, projectId, "role_bundled_viewer");
    await key("revoked", orgId, projectId, operatorRole, new Date());
    await key("other", otherOrgId, otherProjectId, otherOwnerRole);
    app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  it("enforces authentication, permissions and tenant scope on every completion surface", async () => {
    expect((await app.inject({ url: completionPath() })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: completionPath(), headers: headers("revoked") })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: completionPath(), headers: headers("viewer") })).statusCode,
    ).toBe(200);
    const other = await app.inject({ url: completionPath(), headers: headers("other") });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(`example-${suffix}`);

    for (const url of [
      `/v1/projects/${projectId}/delivery-integration`,
      `/v1/projects/${projectId}/delivery-notices`,
    ]) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers: headers("viewer"),
            payload: url.endsWith("delivery-notices")
              ? { in_app: false }
              : { mode: "manual", repository: null },
          })
        ).statusCode,
      ).toBe(403);
    }
    const completion = await domain.completion.read(scope);
    const malformedKey = randomUUID();
    const malformed = await app.inject({
      method: "POST",
      url: completionPath().replace(/\/completion$/, "/complete"),
      headers: { ...headers("operator"), "idempotency-key": malformedKey },
      payload: {
        candidate_revision: "not-a-candidate",
        confirm: true,
        idempotency_key: malformedKey,
      },
    });
    expect(malformed.statusCode).toBe(400);
    const key = randomUUID();
    const denied = await app.inject({
      method: "POST",
      url: completionPath().replace(/\/completion$/, "/complete"),
      headers: { ...headers("result"), "idempotency-key": key },
      payload: {
        candidate_revision: completion.candidate.revision,
        confirm: true,
        idempotency_key: key,
      },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("deduplicates actionable notices and honors the in-app preference", async () => {
    const first = await domain.completion.reconcile(scope);
    expect(first.nextAction).toBe("request_completion");
    await domain.completion.reconcile(scope);
    expect(
      await db
        .select()
        .from(attentionItems)
        .where(and(eq(attentionItems.storyId, storyId), eq(attentionItems.status, "open"))),
    ).toHaveLength(1);

    await domain.completion.setNoticePolicy({ orgId, projectId }, { in_app: false });
    expect(
      await db
        .select()
        .from(attentionItems)
        .where(and(eq(attentionItems.storyId, storyId), eq(attentionItems.status, "open"))),
    ).toHaveLength(0);
    await domain.completion.setNoticePolicy({ orgId, projectId }, { in_app: true });
    expect(
      await db
        .select()
        .from(attentionItems)
        .where(and(eq(attentionItems.storyId, storyId), eq(attentionItems.status, "open"))),
    ).toHaveLength(1);
  });

  it("fences dispatches, candidates and terminal results while resetting a changed destination", async () => {
    await domain.completion.setPolicy(
      { orgId, projectId },
      { mode: "repository_dispatch", repository: `example-${suffix}/integration` },
    );
    const pending = await domain.completion.read(scope);
    const revision = pending.candidate.revision;
    if (!revision) throw new Error("Expected a delivery candidate");
    await expect(
      domain.completion.recordIntegration(
        scope,
        {
          candidate_revision: revision,
          state: "succeeded",
          summary: "Cannot arrive before dispatch",
          evidence_url: null,
          idempotency_key: randomUUID(),
        },
        { type: "service", id: "test" },
      ),
    ).rejects.toMatchObject({ code: "integration_not_dispatched" });

    const claims = await Promise.all([
      domain.completion.dispatchIntegration(scope),
      domain.completion.dispatchIntegration(scope),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(
      githubRequest.mock.calls.filter(([route]) => String(route).includes("dispatches")),
    ).toHaveLength(1);
    const succeeded = await domain.completion.recordIntegration(
      scope,
      {
        candidate_revision: revision,
        state: "succeeded",
        summary: "Integration completed",
        evidence_url: "https://ci.example.test/runs/1",
        idempotency_key: randomUUID(),
      },
      { type: "service", id: "integration" },
    );
    expect(succeeded.integration.state).toBe("succeeded");
    await expect(
      domain.completion.recordIntegration(
        scope,
        {
          candidate_revision: revision,
          state: "failed",
          summary: "Conflicting replay",
          evidence_url: null,
          idempotency_key: randomUUID(),
        },
        { type: "service", id: "integration" },
      ),
    ).rejects.toMatchObject({ code: "integration_result_already_recorded" });

    await domain.completion.setPolicy(
      { orgId, projectId },
      { mode: "repository_dispatch", repository: `example-${suffix}/integration-two` },
    );
    const reset = await domain.completion.read(scope);
    expect(reset.integration).toMatchObject({
      state: "pending",
      repository: `example-${suffix}/integration-two`,
      attempt: 0,
      summary: null,
    });

    dispatchFailures = 1;
    expect(await domain.completion.dispatchIntegration(scope)).toMatchObject({
      claimed: true,
      state: "failed",
      errorCode: "github_http_503",
    });
    expect(
      (
        await db
          .select()
          .from(attentionItems)
          .where(
            and(
              eq(attentionItems.storyId, storyId),
              eq(attentionItems.kind, "delivery_integration"),
              eq(attentionItems.status, "open"),
            ),
          )
      ).length,
    ).toBe(1);
    await db
      .update(storyDeliveryIntegrations)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(storyDeliveryIntegrations.storyId, storyId));
    expect(await domain.completion.dispatchIntegration(scope)).toMatchObject({
      claimed: true,
      state: "dispatched",
    });
    await domain.completion.recordIntegration(
      scope,
      {
        candidate_revision: revision,
        state: "succeeded",
        summary: "Second destination completed",
        evidence_url: null,
        idempotency_key: randomUUID(),
      },
      { type: "service", id: "integration" },
    );
    await domain.completion.setPolicy({ orgId, projectId }, { mode: "none", repository: null });
    expect((await domain.completion.read(scope)).integration.state).toBe("not_required");
    await domain.completion.setPolicy(
      { orgId, projectId },
      { mode: "repository_dispatch", repository: `example-${suffix}/integration-two` },
    );
    expect((await domain.completion.read(scope)).integration).toMatchObject({
      state: "pending",
      attempt: 0,
      summary: null,
    });
    expect(await domain.completion.dispatchIntegration(scope)).toMatchObject({
      claimed: true,
      state: "dispatched",
    });
    await domain.completion.recordIntegration(
      scope,
      {
        candidate_revision: revision,
        state: "succeeded",
        summary: "Re-enabled policy ran again",
        evidence_url: null,
        idempotency_key: randomUUID(),
      },
      { type: "service", id: "integration" },
    );
  });

  it("retries exact source closure, suspends compute and retains storage", async () => {
    const ready = await domain.completion.read(scope);
    const revision = ready.candidate.revision;
    if (!revision) throw new Error("Expected a delivery candidate");
    const key = randomUUID();
    const requested = await app.inject({
      method: "POST",
      url: completionPath().replace(/\/completion$/, "/complete"),
      headers: { ...headers("operator"), "idempotency-key": key },
      payload: {
        candidate_revision: revision,
        confirm: true,
        idempotency_key: key,
      },
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json().completion.state).toBe("pending");
    const replay = await app.inject({
      method: "POST",
      url: completionPath().replace(/\/completion$/, "/complete"),
      headers: { ...headers("operator"), "idempotency-key": key },
      payload: {
        candidate_revision: revision,
        confirm: true,
        idempotency_key: key,
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().completion.state).toBe("pending");
    expect(
      await db
        .select()
        .from(storyCompletionOperations)
        .where(eq(storyCompletionOperations.storyId, storyId)),
    ).toHaveLength(1);
    expect(enqueued.filter(({ queue }) => queue === "stories.complete")).toHaveLength(1);
    expect(enqueued).toContainEqual({ queue: "stories.complete", data: scope });

    completionFailures = 1;
    expect(await domain.completion.dispatchCompletion(scope)).toMatchObject({
      claimed: true,
      state: "failed",
      errorCode: "github_http_503",
    });
    expect((await domain.completion.read(scope)).source.state).toBe("open");
    await db
      .update(storyCompletionOperations)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(storyCompletionOperations.storyId, storyId));
    const completed = await domain.completion.dispatchCompletion(scope);
    expect(completed, JSON.stringify(completed)).toMatchObject({
      claimed: true,
      state: "completed",
    });

    const issueCalls = githubRequest.mock.calls.filter(([route]) =>
      String(route).includes("issues"),
    );
    expect(issueCalls).toHaveLength(2);
    for (const [, args] of issueCalls)
      expect(args).toMatchObject({
        owner: `example-${suffix}`,
        repo: "source",
        issue_number: issueNumber,
        state: "closed",
      });
    expect(suspend).toHaveBeenCalledTimes(1);
    const final = await domain.completion.read(scope);
    expect(final).toMatchObject({
      source: { kind: "github_issue", state: "closed" },
      completion: { state: "completed", candidateRevision: revision },
      retention: {
        workspaceState: "sleeping",
        computeSuspended: true,
        storageRetained: true,
        archived: false,
        deleted: false,
      },
      nextAction: "completed",
    });
    expect(
      await db
        .select()
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.storyId, storyId),
            inArray(attentionItems.kind, ["delivery_integration", "delivery_completion"]),
            eq(attentionItems.status, "open"),
          ),
        ),
    ).toHaveLength(0);

    await db
      .update(githubIssues)
      .set({ state: "open", closedAt: null, syncedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(githubIssues.projectId, projectId),
          eq(githubIssues.repositoryId, sourceRepositoryId),
          eq(githubIssues.number, issueNumber),
        ),
      );
    await domain.stories.reconcileIssue(orgId, projectId, storyId);
    expect((await domain.completion.read(scope)).nextAction).toBe("request_completion");
    const reopened = await domain.completion.requestCompletion(
      scope,
      {
        candidate_revision: revision,
        confirm: true,
        idempotency_key: randomUUID(),
      },
      { type: "user", id: "user_local_admin" },
    );
    expect(reopened.completion.state).toBe("pending");
  });
});
