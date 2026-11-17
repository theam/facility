import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  githubIssues,
  migrate,
  orgs,
  projectRepositories,
  projects,
  turns,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type { ComputeObserver, StoryScope } from "../src/workspaces/lifecycle.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

const builder = parseAgentManifest(
  `---
name: builder
description: Implements a story in its persistent workspace.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Implement the story.
`,
  "builder.md",
);

describe("story workspace compute notifications", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const repositoryId = newId("repo");
  let root: string;
  let service: StoryWorkspaceService;
  const observed: Array<{ change: "suspended" | "resumed"; scope: StoryScope }> = [];
  const observer: ComputeObserver = {
    computeSuspended: async (scope) => {
      observed.push({ change: "suspended", scope });
    },
    computeResumed: async (scope) => {
      observed.push({ change: "resumed", scope });
    },
  };

  beforeAll(async () => {
    await migrate(databaseUrl);
    root = await mkdtemp(join(tmpdir(), "facility-compute-observer-"));
    service = new StoryWorkspaceService(
      db,
      new FakeWorkspaceRuntime(root),
      async () => undefined,
      observer,
    );
    await db.insert(orgs).values({ id: orgId, name: "Observer", slug: `observer-${suffix}` });
    await db
      .insert(projects)
      .values({ id: projectId, orgId, name: "Observer", slug: `observer-${suffix}` });
    const installationId = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 20_000,
      accountId: 123,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      installationId,
      owner: "acme",
      name: `app-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
  });

  beforeEach(() => {
    observed.length = 0;
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  async function startIssueStory(issueNumber: number, dedupeKey = "start") {
    const started = await service.start({
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: `issue:${issueNumber}`,
      title: `Issue ${issueNumber}`,
      agent: builder,
      message: "Implement this issue",
      messageDedupeKey: `${issueNumber}:${dedupeKey}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [{ service: "web", port: 3000 }] },
    });
    return { started, scope: { orgId, projectId, storyId: started.story.id } };
  }

  async function workspaceState(storyId: string) {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.storyId, storyId));
    return row?.state;
  }

  it("reports running compute when a story starts and again when start wakes it", async () => {
    const { started, scope } = await startIssueStory(101);
    expect(observed).toEqual([{ change: "resumed", scope }]);

    await service.suspend(orgId, projectId, started.story.id);
    expect(await workspaceState(started.story.id)).toBe("sleeping");
    observed.length = 0;

    await startIssueStory(101, "second-message");
    expect(await workspaceState(started.story.id)).toBe("running");
    expect(observed).toEqual([{ change: "resumed", scope }]);
  });

  it("reports suspension and resumption across suspend and restore", async () => {
    const { started, scope } = await startIssueStory(102);
    observed.length = 0;

    await service.suspend(orgId, projectId, started.story.id);
    await service.restore(orgId, projectId, started.story.id);
    expect(observed).toEqual([
      { change: "suspended", scope },
      { change: "resumed", scope },
    ]);
  });

  it("reports suspension when a closed issue stops compute, once the work is settled", async () => {
    const { started, scope } = await startIssueStory(103);
    await db
      .update(turns)
      .set({ state: "succeeded", endedAt: new Date() })
      .where(eq(turns.storyId, started.story.id));
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId,
      projectId,
      repositoryId,
      number: 103,
      title: "Issue 103",
      state: "closed",
      closedAt: new Date(),
      htmlUrl: "https://example.invalid/103",
    });
    observed.length = 0;

    await service.reconcileIssue(orgId, projectId, started.story.id);
    expect(await workspaceState(started.story.id)).toBe("sleeping");
    expect(observed).toEqual([{ change: "suspended", scope }]);

    observed.length = 0;
    await service.reconcileIssue(orgId, projectId, started.story.id);
    expect(observed).toEqual([]);
  });

  it("reports a failed stop on an explicit suspend but not on issue reconciliation", async () => {
    const failingStop = new StoryWorkspaceService(
      db,
      new FakeWorkspaceRuntime(root),
      async () => undefined,
      {
        computeSuspended: async () => {
          throw new Error("preview compute was not retired");
        },
        computeResumed: async () => undefined,
      },
    );
    const { started } = await startIssueStory(104);
    await expect(failingStop.suspend(orgId, projectId, started.story.id)).rejects.toThrow(
      "preview compute was not retired",
    );
    expect(await workspaceState(started.story.id)).toBe("sleeping");

    const closed = await startIssueStory(105);
    await db
      .update(turns)
      .set({ state: "succeeded", endedAt: new Date() })
      .where(eq(turns.storyId, closed.started.story.id));
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId,
      projectId,
      repositoryId,
      number: 105,
      title: "Issue 105",
      state: "closed",
      closedAt: new Date(),
      htmlUrl: "https://example.invalid/105",
    });
    await expect(
      failingStop.reconcileIssue(orgId, projectId, closed.started.story.id),
    ).resolves.toBeUndefined();
    expect(await workspaceState(closed.started.story.id)).toBe("sleeping");
  });
});
