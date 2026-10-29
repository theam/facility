import { randomUUID } from "node:crypto";
import { generateApiKey, newId, type StoryDelivery } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubPullRequestReviews,
  githubPullRequests,
  migrate,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyEvidenceEvents,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

describe("project-scoped delivery register API", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = "org_local",
    projectId = newId("proj"),
    otherProjectId = newId("proj");
  const otherOrgId = newId("org"),
    otherTenantProjectId = newId("proj");
  const repositoryIds = [newId("repo"), newId("repo"), newId("repo")] as const;
  const owner = `example-${suffix}`;
  const names = ["app", "api", "worker"] as const;
  const writerRole = newId("role"),
    executorRole = newId("role"),
    noReadRole = newId("role");
  const tenantOwnerRole = newId("role");
  const credentials: Record<string, string> = {};
  const enqueue = vi.fn(async () => undefined);
  const upstream = vi.fn(async () => {
    throw Error("Delivery must not call GitHub");
  });
  const runtime = new FakeWorkspaceRuntime();
  const runtimeCalls = ["create", "wake", "exec", "inspect", "suspend", "destroy"].map((method) =>
    vi.spyOn(runtime, method as "create").mockRejectedValue(Error("Delivery must not use compute")),
  );
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 9).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let legacyStory: string;
  const pullRequests = () =>
    repositoryIds.map((_, index) => ({
      repository: `${owner}/${names[index]}`,
      number: index + 1,
      required: true,
      primary: index === 0,
    }));
  const path = (storyId: string, selectedProject = projectId) =>
    `/v1/projects/${selectedProject}/workspace-stories/${storyId}/delivery`;
  const previewPath = (storyId: string, selectedProject = projectId) =>
    `/v1/projects/${selectedProject}/workspace-stories/${storyId}/preview-convergence`;
  const headers = (name = "writer") => ({ authorization: `Bearer ${credentials[name]}` });
  const body = (expected_revision = 0, idempotency_key = randomUUID()) => ({
    expected_revision,
    declared_complete: true,
    pull_requests: pullRequests(),
    idempotency_key,
  });
  async function save(storyId: string, payload = body(), name = "writer") {
    return app.inject({
      method: "POST",
      url: path(storyId),
      headers: { ...headers(name), "idempotency-key": payload.idempotency_key },
      payload,
    });
  }
  async function story(legacy = false) {
    const id = newId("story");
    await db.insert(stories).values({
      id,
      orgId,
      projectId,
      provider: "manual",
      externalId: id,
      title: "Delivery example",
      status: "review",
      createdBy: { type: "user", id: "user_local_admin" },
      ...(legacy
        ? {
            repositoryId: repositoryIds[0],
            pullRequestNumber: 1,
            pullRequestUrl: `https://github.com/${owner}/app/pull/1`,
          }
        : {}),
    });
    return id;
  }
  async function key(name: string, selectedProject: string, roleId: string, tenant = orgId) {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId: tenant,
      name,
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId: selectedProject,
      roleId,
    });
    credentials[name] = generated.secret;
    return generated.id;
  }
  let writerId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({ id: otherOrgId, name: "Other tenant", slug: otherOrgId });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Delivery example", slug: projectId },
      { id: otherProjectId, orgId, name: "Other project", slug: otherProjectId },
      {
        id: otherTenantProjectId,
        orgId: otherOrgId,
        name: "Other tenant",
        slug: otherTenantProjectId,
      },
    ]);
    await db.insert(roles).values([
      {
        id: writerRole,
        orgId,
        name: `delivery-writer-${suffix}`,
        permissions: ["projects:read", "projects:write"],
      },
      {
        id: executorRole,
        orgId,
        name: `delivery-executor-${suffix}`,
        permissions: ["projects:read", "workspaces:execute"],
      },
      {
        id: noReadRole,
        orgId,
        name: `delivery-no-read-${suffix}`,
        permissions: ["analytics:read"],
      },
      { id: tenantOwnerRole, orgId: otherOrgId, name: "owner", permissions: ["*"] },
    ]);
    writerId = await key("writer", projectId, writerRole);
    await key("owner", projectId, "role_bundled_owner");
    await key("viewer", projectId, "role_bundled_viewer");
    await key("executor", projectId, executorRole);
    await key("noRead", projectId, noReadRole);
    await key("otherProject", otherProjectId, "role_bundled_owner");
    await key("otherTenant", otherTenantProjectId, tenantOwnerRole, otherOrgId);
    for (const [index, id] of repositoryIds.entries()) {
      const name = names[index];
      if (!name) throw new Error("Fixture repository name missing");
      await db.insert(projectRepositories).values({
        id,
        orgId,
        projectId,
        owner,
        name,
        role: index === 0 ? "primary" : "related",
        defaultBranch: "main",
      });
      await db.insert(githubPullRequests).values({
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId: id,
        number: index + 1,
        title: `Feature ${names[index]}`,
        state: index === 0 ? "merged" : "open",
        headRef: "feature",
        baseRef: "main",
        headSha: "a".repeat(40),
        htmlUrl: `https://github.com/${owner}/${names[index]}/pull/${index + 1}`,
        ciState: "success",
        ciHeadSha: "a".repeat(40),
        ciUpdatedAt: new Date(),
      });
    }
    legacyStory = await story(true);
    app = await buildApp(config, {
      rateLimitMax: 10_000,
      storyDomain: createStoryDomain({ db, config, runtime, enqueue, githubFactory: upstream }),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
    expect(upstream).not.toHaveBeenCalled();
    for (const call of runtimeCalls) expect(call).not.toHaveBeenCalled();
  });

  it("authenticates and scopes every read and write without leaking another project or tenant", async () => {
    expect((await app.inject({ url: path(legacyStory) })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: path(legacyStory), headers: headers("noRead") })).statusCode,
    ).toBe(403);
    for (const name of ["otherProject", "otherTenant"]) {
      expect(
        (await app.inject({ url: path(legacyStory), headers: headers(name) })).statusCode,
      ).toBe(404);
      expect((await save(legacyStory, body(), name)).statusCode).toBe(404);
    }
    expect(
      (await app.inject({ url: path(legacyStory, otherProjectId), headers: headers() })).statusCode,
    ).toBe(404);
    for (const name of ["viewer", "executor"])
      expect((await save(legacyStory, body(), name)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: `${path(legacyStory)}?include_available=maybe`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("keeps a legacy source association incomplete and pages only this project's available mirror", async () => {
    const response = await app.inject({
      url: `${path(legacyStory)}?include_available=true&limit=2`,
      headers: headers("viewer"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      scope: { revision: 0, declaredComplete: false, origin: "legacy" },
      candidate: { state: "scope_incomplete", revision: null, allRequiredMerged: null },
      available: { hasMore: true, nextOffset: 2 },
    });
    expect(response.json().pullRequests).toHaveLength(1);
    expect(response.json().available.items).toHaveLength(2);
    const next = await app.inject({
      url: `${path(legacyStory)}?include_available=true&limit=2&offset=2`,
      headers: headers(),
    });
    expect(next.json().available.items).toHaveLength(1);
    const literal = await app.inject({
      url: `${path(legacyStory)}?include_available=true&q=%25_`,
      headers: headers(),
    });
    expect(literal.json().available.items).toEqual([]);
    const empty = await app.inject({ url: path(await story()), headers: headers() });
    expect(empty.json().pullRequests).toEqual([]);
    expect(empty.json().candidate.state).toBe("scope_incomplete");
  });

  it("requires matching idempotency keys and rejects malformed or unobserved links before writing", async () => {
    const id = await story();
    const payload = body();
    expect(
      (await app.inject({ method: "POST", url: path(id), headers: headers(), payload })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(id),
          headers: { ...headers(), "idempotency-key": randomUUID() },
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(id),
          headers: { ...headers(), "idempotency-key": payload.idempotency_key },
          payload: { ...payload, actor: { id: "spoofed" } },
        })
      ).statusCode,
    ).toBe(400);
    for (const changes of [{ repository: "elsewhere/private" }, { number: 999 }]) {
      const invalid = body();
      invalid.pull_requests = invalid.pull_requests.map((pull, index) =>
        index === 0 ? { ...pull, ...changes } : pull,
      );
      expect((await save(id, invalid)).statusCode).toBe(404);
    }
    expect((await app.inject({ url: path(id), headers: headers() })).json().scope.revision).toBe(0);
  });

  it("records the entire set atomically with its service actor, replays safely and preserves source identity", async () => {
    const payload = body();
    payload.pull_requests = payload.pull_requests.map((pull, index) => ({
      ...pull,
      primary: index === 2,
    }));
    const first = await save(legacyStory, payload);
    expect(first.statusCode, first.body).toBe(200);
    const result = first.json<StoryDelivery>();
    expect(result.scope).toMatchObject({
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "service", id: writerId },
    });
    expect(result.pullRequests).toHaveLength(3);
    expect(result.pullRequests.find((pull) => pull.primary)?.repositoryId).toBe(repositoryIds[2]);
    expect(result.candidate).toMatchObject({
      requiredCount: 3,
      mergedCount: 1,
      allRequiredMerged: false,
    });
    const preview = await app.inject({ url: previewPath(legacyStory), headers: headers("viewer") });
    expect(preview.statusCode, preview.body).toBe(200);
    const previewBody = preview.json();
    expect(previewBody).toMatchObject({
      state: "blocked",
      error: { code: "preview_execution_authorization_required" },
      desired: {
        generation: result.candidate.revision,
      },
      deployedGeneration: null,
      lastGoodGeneration: null,
    });
    expect(
      previewBody.desired.repositories.map((item: { repositoryId: string }) => item.repositoryId),
    ).toEqual(repositoryIds);
    expect(enqueue).not.toHaveBeenCalledWith("stories.preview-convergence", {
      orgId,
      projectId,
      storyId: legacyStory,
    });
    expect(
      await app.storyDomain.previewConvergence.claim({ orgId, projectId, storyId: legacyStory }),
    ).toMatchObject({ claimed: false, reason: "blocked" });
    expect(
      (await app.inject({ url: previewPath(legacyStory), headers: headers("noRead") })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: previewPath(legacyStory, otherProjectId),
          headers: headers("otherProject"),
        })
      ).statusCode,
    ).toBe(404);
    const retryKey = randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${previewPath(legacyStory)}/retry`,
          headers: { ...headers("viewer"), "idempotency-key": retryKey },
          payload: { idempotency_key: retryKey },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${previewPath(legacyStory)}/retry`,
          headers: { ...headers("executor"), "idempotency-key": randomUUID() },
          payload: { idempotency_key: retryKey },
        })
      ).statusCode,
    ).toBe(400);
    const retry = await app.inject({
      method: "POST",
      url: `${previewPath(legacyStory)}/retry`,
      headers: { ...headers("executor"), "idempotency-key": retryKey },
      payload: { idempotency_key: retryKey },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().state).toBe("pending");
    expect((await save(legacyStory, payload)).json()).toEqual(result);
    const evidence = await db
      .select()
      .from(storyEvidenceEvents)
      .where(eq(storyEvidenceEvents.storyId, legacyStory));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.data).toMatchObject({
      revision: 1,
      declared_complete: true,
      actor: { type: "service", id: writerId },
    });
    const [source] = await db.select().from(stories).where(eq(stories.id, legacyStory));
    expect(source).toMatchObject({ pullRequestNumber: 1, repositoryId: repositoryIds[0] });

    const beforeRevision = result.candidate.revision;
    await db
      .update(githubPullRequests)
      .set({ headSha: "b".repeat(40) })
      .where(eq(githubPullRequests.repositoryId, repositoryIds[1]));
    const current = (
      await app.inject({ url: path(legacyStory), headers: headers() })
    ).json<StoryDelivery>();
    expect(current.scope.revision).toBe(1);
    expect(current.candidate.revision).not.toBe(beforeRevision);
    expect(
      current.pullRequests.find((pull) => pull.repositoryId === repositoryIds[1])?.checks,
    ).toMatchObject({ state: "success", current: false });
  });

  it("allows one concurrent scope revision, reports the conflict and leaves semantic no-ops unchanged", async () => {
    const id = await story();
    const one = body(),
      two = body();
    two.declared_complete = false;
    const results = await Promise.all([save(id, one), save(id, two)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json().error.code).toBe(
      "delivery_revision_conflict",
    );
    const winner = results[0]?.statusCode === 200 ? one : two;
    expect(
      (await save(id, { ...winner, expected_revision: 1, idempotency_key: randomUUID() })).json()
        .scope.revision,
    ).toBe(1);
    expect(
      await db.select().from(storyEvidenceEvents).where(eq(storyEvidenceEvents.storyId, id)),
    ).toHaveLength(1);
    expect((await save(id, one)).statusCode).toBe(results[0]?.statusCode);
  });

  it("records the authenticated human actor from a session instead of trusting request data", async () => {
    const login = await app.inject({ url: "/auth/dev-login" });
    const session = login.cookies.find((cookie) => cookie.name === "facility_session");
    expect(session).toBeDefined();
    const payload = body();
    const response = await app.inject({
      method: "POST",
      url: path(await story()),
      headers: {
        cookie: `${session?.name}=${session?.value}`,
        "idempotency-key": payload.idempotency_key,
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().scope.updatedBy).toEqual({ type: "user", id: "user_local_admin" });
  });

  it("retains delivery history when disconnecting a related repository and rolls back mirror deletion", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/repos/${repositoryIds[1]}`,
      headers: headers("owner"),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("repository_in_use");
    expect(
      await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.repositoryId, repositoryIds[1])),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(storyDeliveryPullRequests)
        .where(eq(storyDeliveryPullRequests.storyId, legacyStory)),
    ).toHaveLength(3);
  });

  it("enforces tenant and primary constraints even for direct database writes", async () => {
    const id = await story();
    const row = {
      orgId,
      projectId,
      storyId: id,
      repositoryId: repositoryIds[0],
      pullNumber: 1,
      required: true,
      isPrimary: true,
    };
    await expect(
      db.insert(storyDeliveryPullRequests).values({ ...row, projectId: otherProjectId }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(storyDeliveryPullRequests).values({ ...row, required: false }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await db.insert(storyDeliveryPullRequests).values(row);
    await expect(
      db
        .insert(storyDeliveryPullRequests)
        .values({ ...row, repositoryId: repositoryIds[1], pullNumber: 2 }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("marks a bounded review sample partial and never silently truncates an oversized stored PR set", async () => {
    await db.insert(githubPullRequestReviews).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: newId("ghr"),
        orgId,
        projectId,
        repositoryId: repositoryIds[0],
        pullNumber: 1,
        reviewId: `${suffix}-${index}`,
        author: `reviewer-${index}`,
        state: "APPROVED",
        commitSha: "a".repeat(40),
        submittedAt: new Date(Date.now() - index * 1000),
      })),
    );
    const read = (
      await app.inject({ url: path(legacyStory), headers: headers() })
    ).json<StoryDelivery>();
    const reviewed = read.pullRequests.find((pull) => pull.repositoryId === repositoryIds[0]);
    expect(reviewed?.reviews).toMatchObject({ state: "partial", truncated: true });
    expect(reviewed?.reviews.latest).toHaveLength(5);
    const id = await story();
    await db.insert(storyDeliveryScopes).values({
      orgId,
      projectId,
      storyId: id,
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "user", id: "user_local_admin" },
    });
    const numbers = Array.from({ length: 51 }, (_, index) => index + 1001);
    await db.insert(githubPullRequests).values(
      numbers.map((number) => ({
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId: repositoryIds[0],
        number,
        title: "Bulk example",
        state: "open",
        headRef: "feature",
        baseRef: "main",
        headSha: "a".repeat(40),
        htmlUrl: `https://github.com/${owner}/app/pull/${number}`,
      })),
    );
    await db.insert(storyDeliveryPullRequests).values(
      numbers.map((pullNumber, index) => ({
        orgId,
        projectId,
        storyId: id,
        repositoryId: repositoryIds[0],
        pullNumber,
        required: true,
        isPrimary: index === 0,
      })),
    );
    const response = await app.inject({ url: path(id), headers: headers() });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("delivery_scope_limit_exceeded");
    const repair = await save(id, { ...body(1), pull_requests: pullRequests().slice(0, 1) });
    expect(repair.statusCode, repair.body).toBe(200);
    expect(repair.json().scope.revision).toBe(2);
  });
});
