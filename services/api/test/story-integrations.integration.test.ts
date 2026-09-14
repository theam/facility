import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
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
  storyConversations,
  storyIntegrationNotifications,
  turns,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { StoryIntegrationNotifications } from "../src/stories/integration-notifications.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
// Unlike an optional provider E2E, this critical read/tenant contract must not skip.
describe("story integration API with persisted lifecycle and real authorization", () => {
  const { db, client } = createDb(databaseUrl);
  const projectId = newId("proj"),
    otherProjectId = newId("proj"),
    otherOrgId = newId("org");
  const repositoryId = newId("repo"),
    childId = newId("repo"),
    storyId = newId("story"),
    workspaceId = newId("ws");
  const issueId = newId("iss"),
    suffix = randomUUID();
  const site = {
    id: "site",
    orgId: "org_local",
    projectId,
    workspaceId,
    service: "app",
    origin: "https://one.cloudfront.net",
    surfaceToken: "s".repeat(43),
  };
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 9).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
    previewSites: [
      site,
      { ...site, id: "other", projectId: otherProjectId, origin: "https://two.cloudfront.net" },
    ],
  };
  const runtime = new FakeWorkspaceRuntime();
  const wake = vi.spyOn(runtime, "wake"),
    execute = vi.spyOn(runtime, "exec"),
    destroy = vi.spyOn(runtime, "destroy"),
    inspect = vi.spyOn(runtime, "inspect");
  const domain = createStoryDomain({
    db,
    config,
    runtime,
    enqueue: async () => {
      throw new Error("must not enqueue");
    },
  });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let secret: string, otherSecret: string, revokedSecret: string, writerSecret: string;
  const url = (project = projectId, story = storyId) =>
    `/v1/projects/${project}/workspace-stories/${story}`;
  const read = () =>
    app.inject({ method: "GET", url: url(), headers: { authorization: `Bearer ${secret}` } });
  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Other", slug: `registration-other-${suffix}` });
    await db.insert(projects).values([
      {
        id: projectId,
        orgId: "org_local",
        name: "Registration",
        slug: `registration-${suffix}`,
        settings: {},
      },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other",
        slug: `registration-${suffix}`,
        settings: {},
      },
    ]);
    const installationId = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId: "org_local",
      installationId: Math.floor(Math.random() * 1e9),
      accountId: 3,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: repositoryId,
        orgId: "org_local",
        projectId,
        installationId,
        owner: "acme",
        name: `parent-${suffix}`,
        defaultBranch: "main",
        role: "primary",
      },
      {
        id: childId,
        orgId: "org_local",
        projectId,
        installationId,
        owner: "acme",
        name: `child-${suffix}`,
        defaultBranch: "main",
        role: "related",
      },
    ]);
    await db.insert(githubIssues).values({
      id: issueId,
      orgId: "org_local",
      projectId,
      repositoryId,
      number: 30,
      title: "Preview",
      state: "open",
      htmlUrl: "https://github.com/acme/parent/issues/30",
      syncedAt: new Date(),
    });
    await db.insert(stories).values({
      id: storyId,
      orgId: "org_local",
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:30",
      title: "Preview",
      status: "working",
      branch: "facility/story",
      createdBy: { type: "user", id: "test" },
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: "org_local",
      projectId,
      storyId,
      provider: "fake",
      state: "sleeping",
      volumeRef: "retained-volume",
    });
    const writerRole = newId("role");
    await db.insert(roles).values({
      id: writerRole,
      orgId: "org_local",
      name: `integration-${suffix}`,
      permissions: ["projects:read", "stories:write"],
    });
    for (const kind of ["valid", "other", "revoked", "writer"] as const) {
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId: kind === "other" ? otherOrgId : "org_local",
        name: kind,
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "project",
        projectId: kind === "other" ? otherProjectId : projectId,
        roleId: kind === "writer" ? writerRole : "role_bundled_viewer",
        revokedAt: kind === "revoked" ? new Date() : null,
      });
      if (kind === "valid") secret = key.secret;
      else if (kind === "other") otherSecret = key.secret;
      else if (kind === "writer") writerSecret = key.secret;
      else revokedSecret = key.secret;
    }
    app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  it("reads scoped metadata without waking compute, secrets, turns or mutations", async () => {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().lifecycle).toMatchObject({
      orgId: "org_local",
      projectId,
      storyId,
      issue: { state: "open", stale: false },
      workspace: { id: workspaceId, sites: [{ id: "site", service: "app", origin: site.origin }] },
    });
    expect(response.json().lifecycle.workspace.sites).toHaveLength(1);
    expect(response.json().story.integrationState).toEqual({});
    expect(response.body).not.toContain(site.surfaceToken);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    for (const spy of [wake, execute, destroy, inspect]) expect(spy).not.toHaveBeenCalled();
  });
  it("tracks issue close/reopen independently of persisted story status and retained machine", async () => {
    const initial = (await read()).json();
    await db
      .update(githubIssues)
      .set({ state: "closed", syncedAt: new Date() })
      .where(eq(githubIssues.id, issueId));
    expect((await read()).json().lifecycle.issue.state).toBe("closed");
    expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0]?.status).toBe(
      "working",
    );
    await db
      .update(githubIssues)
      .set({ state: "open", syncedAt: new Date() })
      .where(eq(githubIssues.id, issueId));
    expect((await read()).json().lifecycle.revision).toBe(initial.lifecycle.revision);
    expect(
      (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]?.volumeRef,
    ).toBe("retained-volume");
  });
  it("does not finish a parent story on a child PR with the same branch and closing issue number", async () => {
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId: "org_local",
      projectId,
      repositoryId: childId,
      number: 31,
      title: "Child done",
      state: "merged",
      draft: false,
      headRef: "facility/story",
      headSha: "a".repeat(40),
      baseRef: "main",
      htmlUrl: "https://github.com/acme/child/pull/31",
      closingIssues: [30],
    });
    expect((await read()).json().lifecycle.phase).not.toBe("done");
  });
  it("refuses to infer cleanup from stale mirrors or missing stories", async () => {
    await db
      .update(githubIssues)
      .set({ state: "closed", syncedAt: new Date(0) })
      .where(eq(githubIssues.id, issueId));
    expect((await read()).json().lifecycle.issue.stale).toBe(true);
    expect(
      (
        await app.inject({
          method: "GET",
          url: url(projectId, "missing"),
          headers: { authorization: `Bearer ${secret}` },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("denies anonymous, malformed, revoked, cross-project and cross-tenant requests", async () => {
    for (const credential of [undefined, "malformed", revokedSecret, otherSecret]) {
      const response = await app.inject({
        method: "GET",
        url: url(),
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(site.origin);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: url(otherProjectId),
          headers: { authorization: `Bearer ${secret}` },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  async function prStory(number: number) {
    const id = newId("story"),
      workspace = newId("ws"),
      conversationId = newId("sess");
    const pullId = newId("ghp"),
      branch = `facility/pr-${number}`;
    await db.insert(stories).values({
      id,
      orgId: "org_local",
      projectId,
      repositoryId,
      provider: "github",
      externalId: `pull-request:${number}`,
      title: "PR regression",
      status: "working",
      branch,
      createdBy: { type: "user", id: "test" },
    });
    await db.insert(workspaces).values({
      id: workspace,
      orgId: "org_local",
      projectId,
      storyId: id,
      provider: "fake",
      state: "sleeping",
      volumeRef: "pr-retained-volume",
    });
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId: "org_local", projectId, storyId: id });
    await db.insert(turns).values({
      id: newId("turn"),
      orgId: "org_local",
      projectId,
      storyId: id,
      conversationId,
      agentName: "architect",
      manifestHash: "synthetic",
      manifest: {},
      engine: "claude_code",
      model: "synthetic",
      state: "succeeded",
      triggerType: "github",
      createdBy: { type: "user", id: "test" },
    });
    const pull = {
      id: pullId,
      orgId: "org_local",
      projectId,
      repositoryId,
      number,
      title: "PR regression",
      state: "open",
      draft: false,
      headRef: branch,
      headSha: "b".repeat(40),
      baseRef: "main",
      htmlUrl: `https://github.com/acme/parent/pull/${number}`,
      syncedAt: new Date(),
      githubUpdatedAt: new Date(0),
    };
    await db.insert(githubPullRequests).values(pull);
    const readPr = async () => {
      const response = await app.inject({
        method: "GET",
        url: `${url(projectId, id)}?evidence=none`,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().lifecycle;
    };
    return { id, workspace, pullId, pull, readPr };
  }

  it("reports a fresh PR-backed story after its turn settles, including close, merge and reopen", async () => {
    const f = await prStory(401);
    for (const [state, draft, phase] of [
      ["open", false, "review"],
      ["open", true, "in_progress"],
      ["closed", false, "in_progress"],
      ["merged", false, "done"],
      ["open", false, "review"],
    ] as const) {
      await db
        .update(githubPullRequests)
        .set({ state, draft })
        .where(eq(githubPullRequests.id, f.pullId));
      expect(await f.readPr()).toMatchObject({
        provider: "github",
        repositoryId,
        externalId: "pull-request:401",
        issue: null,
        phase,
        activity: "idle",
        pullRequest: { repositoryId, number: 401, state, stale: false },
        workspace: { id: f.workspace, state: "sleeping" },
      });
    }
    for (const spy of [wake, execute, destroy, inspect]) expect(spy).not.toHaveBeenCalled();
  });

  it("uses PR mirror sync time, not GitHub edit time, and preserves stale merged evidence", async () => {
    const f = await prStory(402);
    const fresh = await f.readPr(); // Old GitHub edit, freshly synced mirror.
    expect(fresh.pullRequest.stale).toBe(false);
    await db
      .update(githubPullRequests)
      .set({ syncedAt: new Date(0), githubUpdatedAt: new Date() })
      .where(eq(githubPullRequests.id, f.pullId));
    const stale = await f.readPr();
    expect(stale.pullRequest.stale).toBe(true);
    expect(stale.revision).not.toBe(fresh.revision);
    await db
      .update(githubPullRequests)
      .set({ state: "merged" })
      .where(eq(githubPullRequests.id, f.pullId));
    expect(await f.readPr()).toMatchObject({
      phase: "done",
      pullRequest: { stale: true, state: "merged" },
    });
    await db
      .update(githubPullRequests)
      .set({ state: "open", syncedAt: new Date() })
      .where(eq(githubPullRequests.id, f.pullId));
    expect((await f.readPr()).revision).toBe(fresh.revision);
  });

  it("never substitutes a same-branch or child-repository PR for missing/stale source evidence", async () => {
    const f = await prStory(403);
    await db
      .update(githubPullRequests)
      .set({ state: "merged", syncedAt: new Date(0) })
      .where(eq(githubPullRequests.id, f.pullId));
    await db.insert(githubPullRequests).values([
      { ...f.pull, id: newId("ghp"), number: 404 },
      { ...f.pull, id: newId("ghp"), repositoryId: childId },
    ]);
    expect(await f.readPr()).toMatchObject({
      pullRequest: { repositoryId, number: 403, state: "merged", stale: true },
    });
    await db.delete(githubPullRequests).where(eq(githubPullRequests.id, f.pullId));
    expect(await f.readPr()).toMatchObject({
      externalId: "pull-request:403",
      issue: null,
      pullRequest: null,
      phase: "in_progress",
    });
  });

  it("retains missing or stale issue evidence even when its related PR is fresh", async () => {
    const f = await prStory(405);
    await db.update(stories).set({ externalId: "issue:405" }).where(eq(stories.id, f.id));
    expect(await f.readPr()).toMatchObject({
      externalId: "issue:405",
      issue: null,
      pullRequest: { stale: false },
    });
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId: "org_local",
      projectId,
      repositoryId,
      number: 405,
      title: "Stale source issue",
      state: "closed",
      htmlUrl: "https://github.com/acme/parent/issues/405",
      syncedAt: new Date(0),
    });
    expect(await f.readPr()).toMatchObject({
      issue: { stale: true, state: "closed" },
      pullRequest: { stale: false },
    });
  });

  const patch = (payload: unknown, credential = writerSecret, project = projectId) =>
    app.inject({
      method: "PATCH",
      url: `${url(project)}/integration-state`,
      headers: { authorization: `Bearer ${credential}` },
      payload: payload as Record<string, unknown>,
    });

  it("persists namespaced state across closure and rejects stale concurrent writes", async () => {
    const before = (await read()).json();
    const body = {
      namespace: "auth0",
      expected_revision: 0,
      value: { owned: ["https://one.cloudfront.net/auth/callback"] },
    };
    const results = await Promise.all([patch(body), patch(body)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await patch({ namespace: "other", expected_revision: 1, value: { id: "x" } })).statusCode,
    ).toBe(200);
    const after = (await read()).json();
    expect(after.story.integrationState).toEqual({ auth0: body.value, other: { id: "x" } });
    expect(after.story.updatedAt).toBe(before.story.updatedAt);
    expect(after.lifecycle.revision).toBe(before.lifecycle.revision);
    await db
      .update(stories)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(stories.id, storyId));
    expect((await read()).json().story.integrationState.auth0).toEqual(body.value);
    expect(
      (await patch({ namespace: "auth0", expected_revision: 2, value: null })).statusCode,
    ).toBe(200);
    expect((await read()).json().story.integrationState).toEqual({ other: { id: "x" } });
    // A retained, soft-deleted story still has its integration ledger for cleanup.
    await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
    expect((await read()).json().story.integrationState.other).toEqual({ id: "x" });
  });

  it("rejects state write without permission, cross scope, invalid shape and oversize JSON", async () => {
    const payload = { namespace: "auth0", expected_revision: 3, value: {} };
    for (const credential of [secret, revokedSecret, otherSecret, "malformed"])
      expect((await patch(payload, credential)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await patch(payload, writerSecret, otherProjectId)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    for (const body of [
      { ...payload, namespace: "__proto__" },
      { ...payload, value: [] },
      { ...payload, expected_revision: -1 },
    ])
      expect((await patch(body)).statusCode).toBe(400);
    expect((await patch({ ...payload, value: { huge: "a".repeat(16384) } })).statusCode).toBe(413);
    expect((await read()).json().story.integrationStateRevision).toBe(3);
  });

  it("delivers only to the scoped primary repo, ignores no-listener acceptance and does not loop on integration writes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (route: string, args: Record<string, unknown>) => {
      expect(route).toBe("POST /repos/{owner}/{repo}/dispatches");
      requests.push(args);
      return { data: undefined };
    });
    const factory = vi.fn(async () => ({ request })) as unknown as GithubClientFactory;
    const notifier = new StoryIntegrationNotifications(
      db,
      domain.backlog,
      config.previewSites ?? [],
      factory,
    );
    const scope = { orgId: "org_local", projectId, storyId };
    const start = new Date();
    expect(await notifier.deliver(scope, start)).toEqual({ accepted: 2, failed: false });
    expect(
      requests.every((args) => args.owner === "acme" && args.repo === `parent-${suffix}`),
    ).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(site.surfaceToken);
    expect(JSON.stringify(requests)).not.toContain("integrationState");
    expect(
      (await patch({ namespace: "auth0", expected_revision: 3, value: { state: "closed" } }))
        .statusCode,
    ).toBe(200);
    const later = new Date(start.getTime() + 61_000);
    expect(await notifier.deliver(scope, later)).toEqual({ accepted: 0, failed: false });
    const changed = new StoryIntegrationNotifications(
      db,
      domain.backlog,
      [{ ...site, origin: "https://new.cloudfront.net" }],
      factory,
    );
    expect(await changed.deliver(scope, new Date(later.getTime() + 61_000))).toEqual({
      accepted: 1,
      failed: false,
    });
    expect(requests.at(-1)?.event_type).toBe("facility.workspace.updated");
    expect(await changed.deliver({ ...scope, orgId: otherOrgId }, new Date())).toBeNull();
    expect(requests).toHaveLength(3);
  });

  it("retains retry identity across HTTP errors and serializes concurrent notification workers", async () => {
    await db
      .delete(storyIntegrationNotifications)
      .where(eq(storyIntegrationNotifications.storyId, storyId));
    const delivered: Array<Record<string, unknown>> = [];
    let fail = true;
    const factory = (async () => ({
      request: async (_route: string, args: Record<string, unknown>) => {
        delivered.push(args);
        if (fail) throw Object.assign(new Error("do not persist this secret"), { status: 403 });
        return { data: undefined };
      },
    })) as unknown as GithubClientFactory;
    const notifier = new StoryIntegrationNotifications(
      db,
      domain.backlog,
      config.previewSites ?? [],
      factory,
    );
    const scope = { orgId: "org_local", projectId, storyId },
      start = new Date();
    expect(await notifier.deliver(scope, start)).toEqual({ accepted: 0, failed: true });
    const [pending] = await db
      .select()
      .from(storyIntegrationNotifications)
      .where(eq(storyIntegrationNotifications.storyId, storyId));
    expect(pending?.pending).toHaveLength(2);
    expect(pending?.lastErrorCode).toBe("github_http_403");
    expect(JSON.stringify(pending)).not.toContain("secret");
    fail = false;
    const retries = await Promise.all([
      notifier.deliver(scope, new Date(start.getTime() + 61_000)),
      notifier.deliver(scope, new Date(start.getTime() + 61_000)),
    ]);
    expect(retries.filter(Boolean)).toEqual([{ accepted: 2, failed: false }]);
    expect(delivered[0]?.client_payload).toEqual(delivered[1]?.client_payload);
    expect(
      (
        await db
          .select()
          .from(storyIntegrationNotifications)
          .where(eq(storyIntegrationNotifications.storyId, storyId))
      )[0]?.pending,
    ).toEqual([]);
  });
});
