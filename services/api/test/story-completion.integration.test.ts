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
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import { StoryCompletionService } from "../src/stories/completion.js";
import { replaceStoryDelivery } from "../src/stories/delivery.js";
import {
  confirmDeliveryAcceptance,
  requestDeliveryAcceptance,
  reviewDeliveryAcceptance,
} from "../src/stories/delivery-acceptance.js";
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
    return generated.id;
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
          event_id: (await domain.completion.read(scope)).integration.eventId,
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
        event_id: (await domain.completion.read(scope)).integration.eventId,
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
          event_id: (await domain.completion.read(scope)).integration.eventId,
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
        event_id: (await domain.completion.read(scope)).integration.eventId,
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
        event_id: (await domain.completion.read(scope)).integration.eventId,
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
  async function reviewFixture() {
    const projectId = newId("proj"),
      storyId = newId("story"),
      repositoryId = newId("repo"),
      otherRepositoryId = newId("repo");
    const freshScope = { orgId, projectId, storyId };
    const name = `review-${randomUUID().slice(0, 8)}`;
    await db.insert(projects).values({ id: projectId, orgId, name, slug: projectId });
    await db.insert(projectRepositories).values([
      {
        id: repositoryId,
        orgId,
        projectId,
        owner: "example",
        name,
        role: "primary",
        defaultBranch: "main",
        installationId,
      },
      {
        id: otherRepositoryId,
        orgId,
        projectId,
        owner: "example",
        name: `${name}-two`,
        role: "related",
        defaultBranch: "main",
        installationId,
      },
    ]);
    const issueId = newId("ghi"),
      pullId = newId("ghp");
    await db.insert(githubIssues).values({
      id: issueId,
      orgId,
      projectId,
      repositoryId,
      number: 99,
      title: "Source",
      state: "open",
      htmlUrl: `https://github.com/example/${name}/issues/99`,
      syncedAt: new Date(),
    });
    await db.insert(githubPullRequests).values({
      id: pullId,
      orgId,
      projectId,
      repositoryId,
      number: 1,
      title: "Delivery",
      state: "merged",
      headSha: "a".repeat(40),
      headRef: "feature",
      baseRef: "main",
      htmlUrl: `https://github.com/example/${name}/pull/1`,
      syncedAt: new Date(),
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:99",
      title: "Source",
      createdBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(storyDeliveryScopes).values({
      ...freshScope,
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "user", id: "user_local_admin" },
    });
    await db
      .insert(storyDeliveryPullRequests)
      .values({ ...freshScope, repositoryId, pullNumber: 1, required: true, isPrimary: true });
    const completion = await domain.completion.reconcile(freshScope);
    if (!completion.candidate.revision) throw Error("Missing review candidate");
    const revision = completion.candidate.revision;
    const result = {
      candidate_revision: revision,
      event_id: null,
      state: "succeeded" as const,
      summary: "Integration complete",
      evidence_url: null,
      idempotency_key: randomUUID(),
    };
    const request = {
      candidate_revision: revision,
      confirm: true as const,
      idempotency_key: randomUUID(),
    };
    const change = () =>
      replaceStoryDelivery(
        db,
        freshScope,
        {
          expected_revision: 1,
          declared_complete: false,
          pull_requests: [
            { repository: `example/${name}`, number: 1, required: true, primary: true },
          ],
          idempotency_key: randomUUID(),
        },
        { type: "user", id: "user_local_admin" },
      );
    return {
      scope: freshScope,
      name,
      repositoryId,
      otherRepositoryId,
      issueId,
      pullId,
      revision,
      result,
      request,
      change,
    };
  }

  it("requires every privileged permission and preserves policy keys through generic settings", async () => {
    const f = await reviewFixture();
    const identities: Record<string, string> = {};
    for (const [name, permissions] of Object.entries({
      project: ["projects:write"],
      github: ["github:write"],
      repo: ["repos:write"],
      completion: ["projects:write", "github:write"],
      policy: ["projects:write", "repos:write"],
    })) {
      const roleId = newId("role");
      await db.insert(roles).values({ id: roleId, orgId, name: roleId, permissions });
      const identity = `${f.scope.storyId}-${name}`;
      await key(identity, orgId, f.scope.projectId, roleId);
      identities[name] = identity;
    }
    for (const name of ["project", "github"]) {
      const requestKey = randomUUID();
      const denied = await app.inject({
        method: "POST",
        url: `/v1/projects/${f.scope.projectId}/workspace-stories/${f.scope.storyId}/complete`,
        headers: { ...headers(identities[name] ?? "missing"), "idempotency-key": requestKey },
        payload: { ...f.request, idempotency_key: requestKey },
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }
    for (const name of ["project", "repo"]) {
      const denied = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${f.scope.projectId}/delivery-integration`,
        headers: headers(identities[name] ?? "missing"),
        payload: { mode: "manual", repository: null },
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }
    expect(
      await db
        .select()
        .from(storyCompletionOperations)
        .where(eq(storyCompletionOperations.storyId, f.scope.storyId)),
    ).toEqual([]);
    const configured = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${f.scope.projectId}/delivery-integration`,
      headers: headers(identities.policy ?? "missing"),
      payload: { mode: "manual", repository: null },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    for (const field of ["deliveryIntegration", "deliveryNotices"]) {
      const denied = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${f.scope.projectId}`,
        headers: headers(identities.project ?? "missing"),
        payload: {
          settings: {
            [field]:
              field === "deliveryIntegration"
                ? { mode: "none", repository: null }
                : { in_app: false },
          },
        },
      });
      expect(denied.statusCode, denied.body).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/projects/${f.scope.projectId}`,
          headers: headers(identities.project ?? "missing"),
          payload: { settings: { ordinary: "preference" } },
        })
      ).statusCode,
    ).toBe(200);
    expect((await domain.completion.read(f.scope)).integration.policy.mode).toBe("manual");
  });

  it("keeps manual results pending across recovery and refuses worker dispatch", async () => {
    const f = await reviewFixture();
    await domain.completion.setPolicy(f.scope, { mode: "manual", repository: null });
    await db
      .update(storyDeliveryIntegrations)
      .set({ state: "failed", errorCode: "integration_policy_changed" })
      .where(eq(storyDeliveryIntegrations.storyId, f.scope.storyId));
    enqueued.length = 0;
    await domain.completion.recover();
    expect(
      enqueued.filter(
        (job) =>
          job.queue === "stories.delivery-integration" && job.data.storyId === f.scope.storyId,
      ),
    ).toEqual([]);
    expect(await domain.completion.dispatchIntegration(f.scope)).toEqual({ claimed: false });
    expect((await domain.completion.read(f.scope)).integration).toMatchObject({
      state: "pending",
      errorCode: null,
    });
    expect(
      (
        await domain.completion.recordIntegration(f.scope, f.result, {
          type: "user",
          id: "user_local_admin",
        })
      ).integration.state,
    ).toBe("succeeded");
  });

  it("rejects old dispatch events after a destination or policy changes", async () => {
    const f = await reviewFixture();
    await domain.completion.setPolicy(f.scope, {
      mode: "repository_dispatch",
      repository: `example/${f.name}`,
    });
    await domain.completion.dispatchIntegration(f.scope);
    const first = (await domain.completion.read(f.scope)).integration.eventId;
    await domain.completion.setPolicy(f.scope, {
      mode: "repository_dispatch",
      repository: `example/${f.name}-two`,
    });
    await domain.completion.dispatchIntegration(f.scope);
    const second = (await domain.completion.read(f.scope)).integration.eventId;
    expect(second).not.toBe(first);
    await expect(
      domain.completion.recordIntegration(
        f.scope,
        { ...f.result, event_id: first },
        { type: "service", id: "old" },
      ),
    ).rejects.toMatchObject({ code: "integration_event_stale" });
    await expect(
      domain.completion.recordIntegration(
        f.scope,
        { ...f.result, event_id: null },
        { type: "service", id: "missing" },
      ),
    ).rejects.toMatchObject({ code: "integration_event_stale" });
    const current = await domain.completion.recordIntegration(
      f.scope,
      { ...f.result, event_id: second },
      { type: "service", id: "current" },
    );
    expect(current.integration).toMatchObject({
      state: "succeeded",
      recordedBy: { id: "current" },
    });
    await domain.completion.setPolicy(f.scope, { mode: "none", repository: null });
    await domain.completion.setPolicy(f.scope, {
      mode: "repository_dispatch",
      repository: `example/${f.name}-two`,
    });
    await domain.completion.dispatchIntegration(f.scope);
    await expect(
      domain.completion.recordIntegration(
        f.scope,
        { ...f.result, event_id: second },
        { type: "service", id: "old" },
      ),
    ).rejects.toMatchObject({ code: "integration_event_stale" });
  });

  it("records only one concurrent terminal receipt and preserves its original provenance", async () => {
    const f = await reviewFixture();
    await domain.completion.setPolicy(f.scope, { mode: "manual", repository: null });
    const results = await Promise.allSettled([
      domain.completion.recordIntegration(f.scope, f.result, { type: "service", id: "success" }),
      domain.completion.recordIntegration(
        f.scope,
        { ...f.result, state: "failed", summary: "Integration failed" },
        { type: "service", id: "failure" },
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((result) => result.status === "rejected");
    expect(denied).toMatchObject({ reason: { code: "integration_result_already_recorded" } });
    const receipt = (await domain.completion.read(f.scope)).integration;
    const duplicate = await domain.completion.recordIntegration(
      f.scope,
      {
        ...f.result,
        state: receipt.state as "succeeded" | "failed",
        summary: receipt.summary ?? "",
      },
      { type: "service", id: "retry" },
    );
    expect(duplicate.integration.recordedAt).toBe(receipt.recordedAt);
    expect(duplicate.integration.recordedBy).toEqual(receipt.recordedBy);
  });

  async function enableAcceptance(project: string, revision = 1) {
    await db
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify({
          storyWorkflow: {
            revision,
            policy: {
              planApprovalAgents: [],
              holdAfterFailure: false,
              requireDeliveryAcceptance: true,
              requirePreviewForAcceptance: false,
            },
          },
        })}::jsonb`,
      })
      .where(eq(projects.id, project));
  }
  async function acceptFixture(f: Awaited<ReturnType<typeof reviewFixture>>) {
    // HTTP cookie/principal enforcement is covered by story-workflow.integration;
    // this fixture exercises the same scoped domain confirmation and receipt.
    const human = {
      id: "user_local_admin",
      name: "Fixture reviewer",
      sessionCookie: "synthetic-local-session",
    };
    const pending = await requestDeliveryAcceptance(
      db,
      f.scope,
      {
        expected_candidate_revision: f.revision,
        expected_plan_revision: 0,
        expected_decision_revision: 0,
        idempotency_key: randomUUID(),
      },
      { type: "user", id: human.id, name: human.name },
      "https://facility.test",
    );
    const reviewed = await reviewDeliveryAcceptance(
      db,
      f.scope,
      pending.id,
      human,
      config.secretMasterKey,
      "https://facility.test",
    );
    if (!reviewed.proof) throw Error("Expected a current acceptance proof");
    const receipt = await confirmDeliveryAcceptance(
      db,
      f.scope,
      pending.id,
      reviewed.proof,
      human,
      config.secretMasterKey,
    );
    expect(receipt.status).toBe("current");
  }
  it("blocks completion without required acceptance and permits the exact accepted candidate", async () => {
    const f = await reviewFixture();
    await enableAcceptance(f.scope.projectId);
    const request = vi.fn(async () => ({ data: { number: 99, state: "closed" } }));
    const service = new StoryCompletionService(
      db,
      async () => ({ request, rest: {} }) as unknown as Octokit,
      domain.stories,
      enqueue,
    );
    await expect(
      service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" }),
    ).rejects.toMatchObject({ code: "workflow_delivery_acceptance_required" });
    expect(request).not.toHaveBeenCalled();
    await acceptFixture(f);
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    expect(await service.dispatchCompletion(f.scope)).toMatchObject({
      claimed: true,
      state: "completed",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rechecks acceptance under the protected close boundary after GitHub client acquisition", async () => {
    const f = await reviewFixture();
    await enableAcceptance(f.scope.projectId);
    await acceptFixture(f);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn(async () => ({ data: { number: 99, state: "closed" } }));
    const service = new StoryCompletionService(
      db,
      async () => {
        entered();
        await gate;
        return { request, rest: {} } as unknown as Octokit;
      },
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    const running = service.dispatchCompletion(f.scope);
    await waiting;
    await enableAcceptance(f.scope.projectId, 2);
    release();
    expect(await running).toMatchObject({ claimed: true, state: "failed" });
    expect(request).not.toHaveBeenCalled();
    expect(
      (await db.select().from(githubIssues).where(eq(githubIssues.id, f.issueId)))[0]?.state,
    ).toBe("open");
  });

  it("rechecks the candidate after client acquisition before closing the source", async () => {
    const f = await reviewFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn(async () => ({ data: { number: 99, state: "closed" } }));
    const service = new StoryCompletionService(
      db,
      async () => {
        entered();
        await gate;
        return { request, rest: {} } as unknown as Octokit;
      },
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    const running = service.dispatchCompletion(f.scope);
    await waiting;
    await f.change();
    release();
    expect(await running).toMatchObject({ claimed: true, state: "failed" });
    expect(request).not.toHaveBeenCalled();
    expect(
      (await db.select().from(githubIssues).where(eq(githubIssues.id, f.issueId)))[0]?.state,
    ).toBe("open");
  });

  it("serializes a delivery change after the bounded source-close operation", async () => {
    const f = await reviewFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn(async () => {
      entered();
      await gate;
      return { data: { number: 99, state: "closed" } };
    });
    const service = new StoryCompletionService(
      db,
      async () => ({ request, rest: {} }) as unknown as Octokit,
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    const running = service.dispatchCompletion(f.scope);
    await waiting;
    let changed = false;
    const mutation = f.change().then(() => {
      changed = true;
    });
    try {
      await vi.waitFor(async () => {
        const result = await db.execute(
          sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted`,
        );
        expect(Number(result[0]?.count)).toBeGreaterThan(0);
      });
      expect(changed).toBe(false);
    } finally {
      release();
    }
    await running;
    await mutation;
    expect(request).toHaveBeenCalledOnce();
    expect(changed).toBe(true);
  });
  it("does not close a source after the requesting key is revoked", async () => {
    const f = await reviewFixture();
    const roleId = newId("role");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: roleId, permissions: ["projects:write", "github:write"] });
    const keyId = await key(
      `completion-revocation-${f.scope.storyId}`,
      orgId,
      f.scope.projectId,
      roleId,
    );
    const request = vi.fn(async () => ({ data: { number: 99, state: "closed" } }));
    const service = new StoryCompletionService(
      db,
      async () => ({ request, rest: {} }) as unknown as Octokit,
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "service", id: keyId });
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
    expect(await service.dispatchCompletion(f.scope)).toMatchObject({
      claimed: true,
      state: "failed",
      errorCode: "completion_authorization_revoked",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "later timestamp",
    "same timestamp",
  ])("preserves a newer source reopen received during the close response: %s", async (timing) => {
    const f = await reviewFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closedAt = new Date(Date.now() - 1_000).toISOString();
    const reopenedAt =
      timing === "same timestamp" ? closedAt : new Date(Date.now() + 1_000).toISOString();
    let remoteState = "open";
    const request = vi.fn(async () => {
      remoteState = "closed";
      entered();
      await gate;
      return { data: { number: 99, state: "closed", closed_at: closedAt, updated_at: closedAt } };
    });
    const service = new StoryCompletionService(
      db,
      async () => ({ request, rest: {} }) as unknown as Octokit,
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    const running = service.dispatchCompletion(f.scope);
    await waiting;
    remoteState = "open";
    const reopened = domain.mirror.handleWebhook({
      id: randomUUID(),
      orgId,
      projectId: f.scope.projectId,
      repositoryId: f.repositoryId,
      eventType: "issues",
      payload: {
        action: "reopened",
        repository: { full_name: `example/${f.name}` },
        issue: {
          number: 99,
          title: "Source reopened after accepted close",
          state: "open",
          html_url: `https://github.com/example/${f.name}/issues/99`,
          updated_at: reopenedAt,
          closed_at: null,
        },
      },
    });
    try {
      await vi.waitFor(async () => {
        const [observed] = await db
          .select()
          .from(githubIssues)
          .where(eq(githubIssues.id, f.issueId));
        expect(observed?.githubUpdatedAt?.toISOString()).toBe(reopenedAt);
        expect(observed?.state).toBe("open");
      });
    } finally {
      release();
    }
    const outcome = await running;
    await reopened;
    const [observed] = await db.select().from(githubIssues).where(eq(githubIssues.id, f.issueId));
    const [story] = await db.select().from(stories).where(eq(stories.id, f.scope.storyId));
    expect(outcome).toMatchObject({ state: "failed", errorCode: "completion_source_changed" });
    expect(story?.status).not.toBe("done");
    expect(await service.dispatchCompletion(f.scope, new Date(Date.now() + 3600000))).toEqual({
      claimed: false,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(observed?.state).toBe(remoteState);
    expect(observed?.githubUpdatedAt?.toISOString()).toBe(reopenedAt);
  });
  it("accepts its own matching close webhook before HTTP response", async () => {
    const f = await reviewFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closedAt = new Date(Date.now() - 1000).toISOString();
    const request = vi.fn(async () => {
      entered();
      await gate;
      return { data: { number: 99, state: "closed", closed_at: closedAt, updated_at: closedAt } };
    });
    const service = new StoryCompletionService(
      db,
      async () => ({ request, rest: {} }) as unknown as Octokit,
      domain.stories,
      enqueue,
    );
    await service.requestCompletion(f.scope, f.request, { type: "user", id: "user_local_admin" });
    const running = service.dispatchCompletion(f.scope);
    await waiting;
    // This is the ordinary event produced by the same successful PATCH, not a reopen.
    const closingWebhook = domain.mirror.handleWebhook({
      id: randomUUID(),
      orgId,
      projectId: f.scope.projectId,
      repositoryId: f.repositoryId,
      eventType: "issues",
      payload: {
        action: "closed",
        repository: { full_name: `example/${f.name}` },
        issue: {
          number: 99,
          title: "Source",
          state: "closed",
          state_reason: "completed",
          html_url: `https://github.com/example/${f.name}/issues/99`,
          updated_at: closedAt,
          closed_at: closedAt,
        },
      },
    });
    try {
      await vi.waitFor(async () => {
        const [observed] = await db
          .select()
          .from(githubIssues)
          .where(eq(githubIssues.id, f.issueId));
        expect(observed?.state).toBe("closed");
        expect(observed?.githubUpdatedAt?.toISOString()).toBe(closedAt);
      });
    } finally {
      release();
    }
    const outcome = await running;
    await closingWebhook;
    const [operation] = await db
      .select()
      .from(storyCompletionOperations)
      .where(eq(storyCompletionOperations.storyId, f.scope.storyId));
    const [story] = await db.select().from(stories).where(eq(stories.id, f.scope.storyId));
    expect(request).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ state: "completed" });
    expect(operation).toMatchObject({ state: "completed", errorCode: null });
    expect(story?.status).toBe("done");
  }, 15000);
});
