import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubBranches,
  githubChecks,
  githubCiEvents,
  githubInstallations,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  githubWebhookEvents,
  migrate,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  workspaces,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { Octokit } from "../src/github/client.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const mirrorTables = [
  githubIssues,
  githubPullRequests,
  githubBranches,
  githubChecks,
  githubPullRequestReviews,
  githubCiEvents,
];

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("repository unlink API", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const writerRole = newId("role");
  let app: Awaited<ReturnType<typeof buildApp>>;
  const upstreamGet = vi.fn(async ({ owner, repo }: Record<string, unknown>) => ({
    data: { owner: { login: String(owner) }, name: String(repo), default_branch: "main" },
  }));

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(roles).values({
      id: writerRole,
      orgId: "org_local",
      name: `repo-writer-${suffix}`,
      permissions: ["repos:read", "repos:write"],
    });
    app = await buildApp(
      {
        databaseUrl,
        secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
        port: 4400,
        publicUrl: "http://localhost:4400",
        webUrl: "http://localhost:3400",
        workspaceImage: "facility-runner:test",
        workspaceDriver: "docker",
        facilityInsecureDev: true,
        logLevel: "silent",
      },
      { rateLimitMax: 10_000 },
    );
    app.githubClientFactory = async () =>
      ({ rest: { repos: { get: upstreamGet } } }) as unknown as Octokit;
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  async function key(projectId: string, roleId = writerRole, orgId = "org_local") {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      name: "unlink test",
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId,
      roleId,
    });
    return generated;
  }
  async function fixture(orgId = "org_local") {
    const projectId = newId("proj");
    const installationId = newId("ghi");
    const owner = `example-${randomUUID().slice(0, 8)}`;
    if (orgId !== "org_local")
      await db.insert(orgs).values({ id: orgId, name: "Other tenant", slug: orgId });
    await db
      .insert(projects)
      .values({ id: projectId, orgId, name: "Repository unlink", slug: projectId });
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 10_000,
      accountId: 1,
      accountLogin: owner,
      targetType: "Organization",
    });
    const repo = (
      await db
        .insert(projectRepositories)
        .values({
          id: newId("repo"),
          orgId,
          projectId,
          installationId,
          owner,
          name: "app",
          role: "primary",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!repo) throw Error("Fixture repository missing");
    return {
      projectId,
      repo,
      credential: await key(
        projectId,
        orgId === "org_local" ? writerRole : "role_bundled_owner",
        orgId,
      ),
    };
  }
  async function related(f: Awaited<ReturnType<typeof fixture>>, name: string) {
    const row = (
      await db
        .insert(projectRepositories)
        .values({ ...f.repo, id: newId("repo"), name, role: "related" })
        .returning()
    )[0];
    if (!row) throw Error("Related fixture repository missing");
    return row;
  }
  async function mirror(repo: typeof projectRepositories.$inferSelect) {
    if (!repo.installationId) throw Error("Fixture installation missing");
    const scope = { orgId: repo.orgId, projectId: repo.projectId, repositoryId: repo.id };
    await db.insert(githubIssues).values({
      ...scope,
      id: newId("ghi"),
      number: 1,
      title: "Issue",
      state: "open",
      htmlUrl: "https://github.com/example/app/issues/1",
    });
    await db.insert(githubPullRequests).values({
      ...scope,
      id: newId("ghp"),
      number: 2,
      title: "PR",
      state: "open",
      headRef: "feature",
      headSha: "a".repeat(40),
      baseRef: "main",
      htmlUrl: "https://github.com/example/app/pull/2",
    });
    await db
      .insert(githubBranches)
      .values({ ...scope, id: newId("ghb"), name: "main", headSha: "a".repeat(40) });
    await db.insert(githubChecks).values({
      ...scope,
      id: newId("ghc"),
      checkId: "check",
      headSha: "a".repeat(40),
      name: "CI",
      status: "completed",
    });
    await db
      .insert(githubPullRequestReviews)
      .values({ ...scope, id: newId("ghr"), pullNumber: 2, reviewId: "review", state: "APPROVED" });
    await db.insert(githubCiEvents).values({
      ...scope,
      id: newId("cie"),
      pullNumber: 2,
      headSha: "a".repeat(40),
      state: "success",
    });
    const eventId = newId("evt");
    await db.insert(githubWebhookEvents).values({
      ...scope,
      id: eventId,
      installationId: repo.installationId,
      eventType: "issues",
      payload: { action: "opened" },
      verified: true,
      processedAt: new Date(),
    });
    return eventId;
  }
  function remove(projectId: string, repoId: string, secret: string, requestKey = randomUUID()) {
    return app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/repos/${repoId}`,
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": requestKey },
    });
  }
  async function rows(repoId: string) {
    return Promise.all(
      mirrorTables.map((table) =>
        db.select({ id: table.id }).from(table).where(eq(table.repositoryId, repoId)),
      ),
    );
  }
  async function addStory(
    f: Awaited<ReturnType<typeof fixture>>,
    repositoryId: string | null = f.repo.id,
  ) {
    const id = newId("story");
    await db.insert(stories).values({
      id,
      orgId: f.repo.orgId,
      projectId: f.projectId,
      repositoryId,
      provider: "manual",
      externalId: id,
      title: "Retained work",
      createdBy: { type: "test" },
    });
    return id;
  }

  it("unlinks a sole primary with all mirror data, preserves webhook evidence, and reconnects elsewhere", async () => {
    const f = await fixture();
    const other = await fixture();
    const eventId = await mirror(f.repo);
    await mirror(other.repo);
    const requestsBefore = upstreamGet.mock.calls.length;
    const requestKey = randomUUID();
    const response = await remove(f.projectId, f.repo.id, f.credential.secret, requestKey);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect((await remove(f.projectId, f.repo.id, f.credential.secret, requestKey)).statusCode).toBe(
      200,
    );
    expect(await rows(f.repo.id)).toEqual([[], [], [], [], [], []]);
    expect((await rows(other.repo.id)).map((r) => r.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(
      await db.select().from(projectRepositories).where(eq(projectRepositories.id, f.repo.id)),
    ).toEqual([]);
    expect(
      (await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, eventId)))[0],
    ).toMatchObject({
      repositoryId: null,
      projectId: f.projectId,
      payload: { action: "opened" },
      verified: true,
    });
    expect(upstreamGet.mock.calls.length).toBe(requestsBefore);
    const connected = await app.inject({
      method: "POST",
      url: `/v1/projects/${other.projectId}/repos`,
      headers: {
        authorization: `Bearer ${other.credential.secret}`,
        "idempotency-key": randomUUID(),
      },
      payload: { owner: f.repo.owner, name: f.repo.name, mode: "connect", defaultBranch: "main" },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({
      projectId: other.projectId,
      owner: f.repo.owner,
      name: f.repo.name,
      role: "related",
    });
    const handle = vi.spyOn(app.storyDomain.githubTriggers, "handle");
    try {
      expect(await app.storyDomain.githubTriggers.handleInbound(eventId)).toEqual({
        matched: 0,
        queued: 0,
        merged: 0,
      });
      expect(handle).not.toHaveBeenCalled();
    } finally {
      handle.mockRestore();
    }
  });

  it("unlinks a primary even with a placeholder present and promotes the oldest related", async () => {
    const f = await fixture();
    const oldest = await related(f, "placeholder");
    await db
      .update(projectRepositories)
      .set({ createdAt: new Date("2020-01-01Z") })
      .where(eq(projectRepositories.id, oldest.id));
    await related(f, "newer");
    await mirror(f.repo);
    const response = await remove(f.projectId, f.repo.id, f.credential.secret);
    expect(response.statusCode, response.body).toBe(200);
    const primary = await db
      .select()
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.projectId, f.projectId),
          eq(projectRepositories.role, "primary"),
        ),
      );
    expect(primary.map((r) => r.id)).toEqual([oldest.id]);
  });

  it("unlinks a synchronized related repository without replacing the primary", async () => {
    const f = await fixture();
    const child = await related(f, "child");
    await mirror(child);
    expect((await remove(f.projectId, child.id, f.credential.secret)).statusCode).toBe(200);
    expect(await rows(child.id)).toEqual([[], [], [], [], [], []]);
    expect(
      (await db.select().from(projectRepositories).where(eq(projectRepositories.id, f.repo.id)))[0]
        ?.role,
    ).toBe("primary");
  });

  it("denies retained stories, including archived history, before changing mirror rows", async () => {
    const f = await fixture();
    const event = await mirror(f.repo);
    const storyId = await addStory(f);
    await db
      .update(stories)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(stories.id, storyId));
    const response = await remove(f.projectId, f.repo.id, f.credential.secret);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("repository_in_use");
    expect((await rows(f.repo.id)).map((r) => r.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(
      (await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, event)))[0]
        ?.repositoryId,
    ).toBe(f.repo.id);
    expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0]?.status).toBe(
      "archived",
    );
  });

  it.each([
    "creating",
    "running",
    "sleeping",
    "error",
    "deleting",
  ])("denies %s project workspaces even when the target has no direct story", async (state) => {
    const f = await fixture();
    const storyId = await addStory(f, null);
    await mirror(f.repo);
    await db.insert(workspaces).values({
      id: newId("ws"),
      orgId: "org_local",
      projectId: f.projectId,
      storyId,
      provider: "fake",
      volumeRef: "retained-test-volume",
      state,
    });
    const response = await remove(f.projectId, f.repo.id, f.credential.secret);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("repository_in_use");
    expect((await rows(f.repo.id)).map((r) => r.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("does not treat an already destroyed workspace as a retained checkout", async () => {
    const f = await fixture();
    const storyId = await addStory(f, null);
    await db.insert(workspaces).values({
      id: newId("ws"),
      orgId: "org_local",
      projectId: f.projectId,
      storyId,
      provider: "fake",
      volumeRef: "removed-test-volume",
      state: "destroyed",
      destroyedAt: new Date(),
    });
    await mirror(f.repo);
    expect((await remove(f.projectId, f.repo.id, f.credential.secret)).statusCode).toBe(200);
  });

  it("denies missing write permission, invalid/revoked keys and cross-project/tenant access", async () => {
    const f = await fixture();
    const other = await fixture();
    const foreign = await fixture(newId("org"));
    const viewer = await key(f.projectId, "role_bundled_viewer");
    const revoked = await key(f.projectId);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, revoked.id));
    await mirror(f.repo);
    expect((await remove(f.projectId, f.repo.id, viewer.secret)).statusCode).toBe(403);
    expect((await remove(f.projectId, f.repo.id, "fak_invalid")).statusCode).toBe(401);
    expect((await remove(f.projectId, f.repo.id, revoked.secret)).statusCode).toBe(401);
    expect((await remove(other.projectId, other.repo.id, f.credential.secret)).statusCode).toBe(
      404,
    );
    expect((await remove(foreign.projectId, foreign.repo.id, f.credential.secret)).statusCode).toBe(
      404,
    );
    // A mismatched repository ID is an idempotent scoped no-op, never a cross-project delete.
    expect((await remove(f.projectId, other.repo.id, f.credential.secret)).statusCode).toBe(200);
    expect((await remove(f.projectId, foreign.repo.id, f.credential.secret)).statusCode).toBe(200);
    expect((await rows(f.repo.id)).map((r) => r.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(
      await db.select().from(projectRepositories).where(eq(projectRepositories.id, other.repo.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.id, foreign.repo.id)),
    ).toHaveLength(1);
  });

  it("serializes simultaneous primary and related removals", async () => {
    const f = await fixture();
    const first = await related(f, "first");
    const survivor = await related(f, "survivor");
    await mirror(f.repo);
    await mirror(first);
    const responses = await Promise.all([
      remove(f.projectId, f.repo.id, f.credential.secret),
      remove(f.projectId, first.id, f.credential.secret),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const remaining = await db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.projectId, f.projectId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: survivor.id, role: "primary" });
  });

  it("rolls back all cleanup for an unknown retained foreign-key dependency", async () => {
    const f = await fixture();
    const eventId = await mirror(f.repo);
    await client`create table repository_unlink_test_guard (repository_id text references project_repositories(id))`;
    try {
      await client`insert into repository_unlink_test_guard values (${f.repo.id})`;
      const response = await remove(f.projectId, f.repo.id, f.credential.secret);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("repository_in_use");
      expect((await rows(f.repo.id)).map((r) => r.length)).toEqual([1, 1, 1, 1, 1, 1]);
      expect(
        (await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, eventId)))[0]
          ?.repositoryId,
      ).toBe(f.repo.id);
      expect(
        await db.select().from(projectRepositories).where(eq(projectRepositories.id, f.repo.id)),
      ).toHaveLength(1);
    } finally {
      await client`drop table repository_unlink_test_guard`;
    }
  });

  it("cancels queued webhook processing while retaining its signed receipt", async () => {
    const f = await fixture();
    const eventId = await mirror(f.repo);
    await db
      .update(githubWebhookEvents)
      .set({ processedAt: null, error: null })
      .where(eq(githubWebhookEvents.id, eventId));
    expect((await remove(f.projectId, f.repo.id, f.credential.secret)).statusCode).toBe(200);
    const receipt = (
      await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, eventId))
    )[0];
    expect(receipt).toMatchObject({
      repositoryId: null,
      projectId: f.projectId,
      verified: true,
      error: "repository_disconnected",
    });
    expect(receipt?.processedAt).toBeInstanceOf(Date);
    expect(await app.storyDomain.githubTriggers.handleInbound(eventId)).toEqual({
      matched: 0,
      queued: 0,
      merged: 0,
    });
  });

  it("does not rebind an in-flight receipt to a later connection or overwrite cancellation", async () => {
    const f = await fixture();
    const other = await fixture();
    const eventId = await mirror(f.repo);
    const payload = {
      action: "opened",
      repository: { owner: { login: f.repo.owner }, name: f.repo.name },
      issue: {
        number: 90,
        title: "Old delivery",
        state: "open",
        html_url: "https://github.com/example/app/issues/90",
      },
    };
    await db
      .update(githubWebhookEvents)
      .set({ processedAt: null, payload })
      .where(eq(githubWebhookEvents.id, eventId));
    const entered = deferred();
    const release = deferred();
    const original = app.storyDomain.githubTriggers.handle.bind(app.storyDomain.githubTriggers);
    const handle = vi
      .spyOn(app.storyDomain.githubTriggers, "handle")
      .mockImplementation(async (event) => {
        entered.resolve();
        await release.promise;
        return original(event);
      });
    const delivery = app.storyDomain.githubTriggers.handleInbound(eventId);
    await entered.promise;
    try {
      expect((await remove(f.projectId, f.repo.id, f.credential.secret)).statusCode).toBe(200);
      const connected = await app.inject({
        method: "POST",
        url: `/v1/projects/${other.projectId}/repos`,
        headers: { authorization: `Bearer ${other.credential.secret}` },
        payload: { owner: f.repo.owner, name: f.repo.name, mode: "connect" },
      });
      expect(connected.statusCode).toBe(200);
      const mirrored = await app.storyDomain.mirror.handleWebhook({
        id: eventId,
        orgId: f.repo.orgId,
        projectId: f.projectId,
        repositoryId: f.repo.id,
        eventType: "issues",
        payload,
      });
      expect(mirrored.mirrored).toBe(0);
      expect(await rows(connected.json().id)).toEqual([[], [], [], [], [], []]);
    } finally {
      release.resolve();
      handle.mockRestore();
    }
    expect(await delivery).toEqual({ matched: 0, queued: 0, merged: 0 });
    expect(
      (await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, eventId)))[0]
        ?.error,
    ).toBe("repository_disconnected");
  });
});
