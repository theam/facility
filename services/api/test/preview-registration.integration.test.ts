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
  seed,
  stories,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
// Unlike an optional provider E2E, this critical read/tenant contract must not skip.
describe("preview registration API with persisted lifecycle and real authorization", () => {
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
  let secret: string, otherSecret: string, revokedSecret: string;
  const url = (project = projectId, story = storyId) =>
    `/v1/projects/${project}/workspace-stories/${story}/preview-registration`;
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
    for (const kind of ["valid", "other", "revoked"] as const) {
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
        roleId: "role_bundled_viewer",
        revokedAt: kind === "revoked" ? new Date() : null,
      });
      if (kind === "valid") secret = key.secret;
      else if (kind === "other") otherSecret = key.secret;
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
    expect(response.json()).toMatchObject({
      orgId: "org_local",
      projectId,
      storyId,
      workspaceId,
      registration: { state: "active" },
      sites: [{ id: "site", service: "app", origin: site.origin }],
    });
    expect(response.json().sites).toHaveLength(1);
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
    expect((await read()).json().registration.state).toBe("closed");
    expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0]?.status).toBe(
      "working",
    );
    await db
      .update(githubIssues)
      .set({ state: "open", syncedAt: new Date() })
      .where(eq(githubIssues.id, issueId));
    expect((await read()).json().revision).toBe(initial.revision);
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
    expect((await read()).json().registration.state).toBe("active");
  });
  it("refuses to infer cleanup from stale mirrors or missing stories", async () => {
    await db
      .update(githubIssues)
      .set({ state: "closed", syncedAt: new Date(0) })
      .where(eq(githubIssues.id, issueId));
    expect((await read()).json().registration.state).toBe("unknown");
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
});
