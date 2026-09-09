import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  agentSchedules,
  auditEvents,
  createDb,
  githubInstallations,
  githubWebhookEvents,
  migrate,
  orgs,
  projectRepositories,
  projects,
  stories,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubAgentTriggerService } from "../src/agents/github-triggers.js";
import { AgentScheduler } from "../src/agents/scheduler.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { registerGithubWebhookWorker } from "../src/github/webhook-worker.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type {
  ProjectManifest,
  ProjectManifestSource,
} from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function manifest(name: string, trigger: string, engine: "claude_code" | "codex" = "codex") {
  return parseAgentManifest(
    `---
name: ${name}
description: ${name} automation.
engine: ${engine}
model: ${engine === "codex" ? "gpt-5.5" : "claude-opus-4-8"}
enabled: true
options: {}
triggers:
${trigger}
---
Run the ${name} role, make the required repository changes, and verify the result.
`,
    `.agents/${name}.md`,
  );
}

describe("agent automations use persistent story workspaces", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; agent automation tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-agent-automation-"));
  const runtime = new FakeWorkspaceRuntime(root);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const repositoryId = newId("repo");
  const installationRowId = newId("ghi");
  const otherOrgId = newId("org");
  const otherInstallationRowId = newId("ghi");
  const installationNumber = 12_000_000 + Math.floor(Math.random() * 100_000);
  let permission = "write";
  let failPermissionFor: string | undefined;
  let rateLimitFor: string | undefined;
  const permissionRequests: Array<Record<string, unknown> | undefined> = [];
  const githubFactory: GithubClientFactory = async (requestedInstallation) => {
    if (requestedInstallation !== installationNumber)
      throw new Error("cross-installation credential request");
    return {
      request: async (route, args) => {
        if (route !== "GET /repos/{owner}/{repo}/collaborators/{username}/permission")
          throw new Error("unexpected GitHub route");
        permissionRequests.push(args);
        if (args?.username === rateLimitFor) {
          rateLimitFor = undefined;
          throw {
            status: 403,
            response: {
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 3_600),
              },
            },
          };
        }
        if (args?.username === failPermissionFor) {
          failPermissionFor = undefined;
          throw Object.assign(new Error("provider failure with private headers"), { status: 503 });
        }
        return { data: { permission } };
      },
    } as Awaited<ReturnType<GithubClientFactory>>;
  };
  const dispatched: string[] = [];
  const agents = [
    manifest(
      "architect",
      "  - type: github\n    name: plan-ready-issue\n    event: issues\n    actions: [opened]\n    labels: [ready]\n  - type: github\n    name: plan-command\n    event: issue_comment\n    actions: [created]\n    command: /architect",
      "claude_code",
    ),
    manifest(
      "builder",
      "  - type: github\n    name: build-ready-issue\n    event: issues\n    actions: [opened]\n    labels: [ready]\n  - type: github\n    name: build-command\n    event: issue_comment\n    actions: [created]\n    command: /builder",
    ),
    manifest(
      "pr-reviewer",
      "  - type: github\n    name: review-open-pr\n    event: pull_request\n    actions: [opened, synchronize]",
      "claude_code",
    ),
    manifest(
      "address-review",
      "  - type: github\n    name: review-submitted\n    event: pull_request_review\n    actions: [submitted]",
    ),
    manifest(
      "ci-doctor",
      "  - type: github\n    name: workflow-completed\n    event: workflow_run\n    actions: [completed]",
    ),
    manifest(
      "security-audit",
      "  - type: schedule\n    name: nightly\n    cron: '0 2 * * *'\n    timezone: UTC",
    ),
  ];
  const source: AgentCatalogSource = {
    load: async (requestedOrgId, requestedProjectId) => {
      if (requestedOrgId !== orgId || requestedProjectId !== projectId) {
        throw new Error("project outside this test fixture");
      }
      return {
        commitSha: "a".repeat(40),
        sources: agents.map((agent) => ({
          file: agent.file,
          source: render(agent),
        })),
      };
    },
  };
  const catalog = new AgentCatalogService(db, source);
  const storiesService = new StoryWorkspaceService(db, runtime, async (turn) => {
    dispatched.push(turn.id);
  });
  const projectManifest: ProjectManifest = {
    version: 1,
    repositories: { primary: `acme/app-${suffix}`, related: [] },
    environment: {
      start: "true",
      secrets: [],
      variables: [],
      services: { web: { port: 3000, protocol: "http", websocket: true } },
    },
    hash: "project-manifest",
  };
  const projectManifests: ProjectManifestSource = {
    load: async (requestedOrgId, requestedProjectId) => {
      if (requestedOrgId !== orgId || requestedProjectId !== projectId) {
        throw new Error("project outside this test fixture");
      }
      return projectManifest;
    },
  };
  const github = new GithubAgentTriggerService(
    db,
    catalog,
    storiesService,
    projectManifests,
    "facility-runner:test",
    undefined,
    githubFactory,
  );
  const scheduler = new AgentScheduler(
    db,
    catalog,
    storiesService,
    projectManifests,
    "facility-runner:test",
  );

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({
      id: orgId,
      name: "Agent automation",
      slug: `agent-automation-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Agent automation",
      slug: `agent-automation-${suffix}`,
      settings: {},
    });
    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Other tenant",
      slug: `other-automation-${suffix}`,
      settings: {},
    });
    await db.insert(githubInstallations).values([
      {
        id: installationRowId,
        orgId,
        installationId: installationNumber,
        accountId: 1,
        accountLogin: "acme",
        targetType: "Organization",
      },
      {
        id: otherInstallationRowId,
        orgId: otherOrgId,
        installationId: installationNumber + 1,
        accountId: 2,
        accountLogin: "other",
        targetType: "Organization",
      },
    ]);
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      installationId: installationRowId,
      owner: "acme",
      name: `app-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("matches repository-defined GitHub triggers, serializes agents, and deduplicates replay", async () => {
    const event = {
      id: `delivery-${randomUUID()}`,
      orgId,
      eventType: "issues",
      payload: {
        action: "opened",
        repository: { owner: { login: "acme" }, name: `app-${suffix}` },
        issue: {
          number: 72,
          title: "Persistent issue workspace",
          body: "Implement the requested behavior",
          labels: [{ name: "ready" }],
        },
        sender: { type: "User", login: "contributor" },
      },
    };
    await expect(github.handle(event)).resolves.toEqual({ matched: 2, queued: 2, merged: 0 });
    await expect(github.handle(event)).resolves.toEqual({ matched: 2, queued: 0, merged: 0 });

    const storyRows = await db
      .select()
      .from(stories)
      .where(and(eq(stories.projectId, projectId), eq(stories.externalId, "issue:72")));
    expect(storyRows).toHaveLength(1);
    const story = storyRows[0];
    if (!story) throw new Error("expected triggered story");
    expect(await db.select().from(workspaces).where(eq(workspaces.storyId, story.id))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, story.id)),
    ).toHaveLength(2);
    expect(await db.select().from(turns).where(eq(turns.storyId, story.id))).toHaveLength(1);
    expect(dispatched).toHaveLength(1);

    await expect(
      github.handle({
        ...event,
        id: `delivery-${randomUUID()}`,
        payload: { ...event.payload, issue: { ...event.payload.issue, number: 73, labels: [] } },
      }),
    ).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
  });

  function commandEvent(body: string, number = 501) {
    return {
      id: `delivery-${randomUUID()}`,
      orgId,
      eventType: "issue_comment",
      payload: {
        action: "created",
        repository: { owner: { login: "acme" }, name: `app-${suffix}` },
        issue: { number, state: "open", title: "Command-driven work", labels: [] },
        comment: { id: number + 1000, body },
        sender: { type: "User", login: "maintainer" },
      },
    };
  }

  async function persistedCounts() {
    return {
      stories: (
        await db.select({ id: stories.id }).from(stories).where(eq(stories.projectId, projectId))
      ).length,
      workspaces: (
        await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.projectId, projectId))
      ).length,
      messages: (
        await db
          .select({ id: storyMessages.id })
          .from(storyMessages)
          .where(eq(storyMessages.projectId, projectId))
      ).length,
      turns: (await db.select({ id: turns.id }).from(turns).where(eq(turns.projectId, projectId)))
        .length,
      dispatched: dispatched.length,
    };
  }

  it("rejects ineligible commands before creating any workspace, message, or turn", async () => {
    const before = await persistedCounts();
    const event = commandEvent("/builder");
    for (const denied of [
      commandEvent("Please use /builder later"),
      commandEvent("/architect\n/builder"),
      commandEvent("```\n/builder\n```"),
      { ...event, eventType: "issues", payload: { ...event.payload, action: "assigned" } },
      { ...event, payload: { ...event.payload, action: "edited" } },
      {
        ...event,
        payload: { ...event.payload, sender: { type: "Bot", login: "automation[bot]" } },
      },
      {
        ...event,
        payload: { ...event.payload, issue: { ...event.payload.issue, state: "closed" } },
      },
      { ...event, orgId: otherOrgId },
    ]) {
      await expect(github.handle(denied)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
    }
    try {
      permission = "read";
      await expect(github.handle(event)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
      permission = "triage";
      await expect(github.handle(event)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
    } finally {
      permission = "write";
    }
    expect(await persistedCounts()).toEqual(before);
  });

  it("does not admit an unverified inbound delivery", async () => {
    const event = commandEvent("/builder");
    const before = await persistedCounts();
    const requestsBefore = permissionRequests.length;
    await db.insert(githubWebhookEvents).values({
      id: event.id,
      orgId,
      projectId,
      repositoryId,
      installationId: installationRowId,
      eventType: event.eventType,
      payload: event.payload,
      verified: false,
    });
    await expect(github.handleInbound(event.id)).resolves.toEqual({
      matched: 0,
      queued: 0,
      merged: 0,
    });
    expect(permissionRequests).toHaveLength(requestsBefore);
    expect(await persistedCounts()).toEqual(before);
  });

  it("denies missing credentials before loading the catalog and records replay-safe audit evidence", async () => {
    const before = await persistedCounts();
    const unavailableCatalog = { list: vi.fn().mockRejectedValue(new Error("must not load")) };
    const withoutCredentials = new GithubAgentTriggerService(
      db,
      unavailableCatalog as unknown as AgentCatalogService,
      storiesService,
      projectManifests,
      "facility-runner:test",
    );
    const event = commandEvent("/builder", 503);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(withoutCredentials.handle(event)).resolves.toEqual({
        matched: 0,
        queued: 0,
        merged: 0,
      });
    }
    expect(unavailableCatalog.list).not.toHaveBeenCalled();
    expect(await persistedCounts()).toEqual(before);
    const denial = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, `github-trigger-denied:${orgId}:${event.id}`));
    expect(denial).toHaveLength(1);
    expect(denial[0]).toMatchObject({
      action: "github.agent_trigger.denied",
      payload: { reason: "github_credentials_unavailable" },
    });
  });

  it("records transient failures and retries only their own queued delivery", async () => {
    const schema = `webhook_${suffix.replaceAll("-", "")}`;
    const boss = new PgBoss({ connectionString: databaseUrl, schema });
    const queueErrors: unknown[] = [];
    boss.on("error", (error) => queueErrors.push(error));
    const retryEvent = commandEvent("/architect", 504);
    retryEvent.payload.sender.login = "retry-contributor";
    const otherEvent = commandEvent("/architect", 505);
    for (const event of [retryEvent, otherEvent]) {
      await db.insert(githubWebhookEvents).values({
        id: event.id,
        orgId,
        projectId,
        repositoryId,
        installationId: installationRowId,
        eventType: event.eventType,
        payload: event.payload,
        verified: true,
      });
    }
    const failureEvidence: unknown[] = [];
    try {
      await boss.start();
      await boss.createQueue("github.webhook", {
        name: "github.webhook",
        retryLimit: 2,
        retryDelay: 1,
      });
      const retryJob = await boss.send("github.webhook", { inboundEventId: retryEvent.id });
      const otherJob = await boss.send("github.webhook", { inboundEventId: otherEvent.id });
      if (!retryJob || !otherJob) throw new Error("expected queued webhook jobs");
      failPermissionFor = "retry-contributor";
      await registerGithubWebhookWorker(
        boss,
        async (id) => {
          try {
            return await github.handleInbound(id);
          } catch (error) {
            failureEvidence.push(
              (
                await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, id))
              )[0],
            );
            throw error;
          }
        },
        { info: () => undefined },
      );
      await vi.waitFor(
        async () => {
          expect((await boss.getJobById("github.webhook", retryJob))?.state).toBe("completed");
          expect((await boss.getJobById("github.webhook", otherJob))?.state).toBe("completed");
        },
        { timeout: 15_000, interval: 100 },
      );
      expect((await boss.getJobById("github.webhook", retryJob))?.retryCount).toBe(1);
      expect((await boss.getJobById("github.webhook", otherJob))?.retryCount).toBe(0);
      expect(failureEvidence).toEqual([
        expect.objectContaining({
          id: retryEvent.id,
          processedAt: null,
          error: "github_webhook_processing_failed",
        }),
      ]);
      expect(
        (
          await db
            .select()
            .from(githubWebhookEvents)
            .where(eq(githubWebhookEvents.id, retryEvent.id))
        )[0],
      ).toMatchObject({ error: null, processedAt: expect.any(Date) });
      expect(queueErrors).toEqual([]);
    } finally {
      failPermissionFor = undefined;
      await boss.stop({ graceful: true, timeout: 5_000 });
      await client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }, 25_000);

  it.each([
    "write",
    "read",
  ])("defers throttled receipts durably and rechecks %s permission after reset", async (afterReset) => {
    const schema = `rate_${suffix.replaceAll("-", "")}_${afterReset}`;
    const boss = new PgBoss({ connectionString: databaseUrl, schema });
    boss.on("error", () => undefined);
    const event = commandEvent("/builder", afterReset === "write" ? 550 : 551);
    event.payload.sender.login = "throttled-contributor";
    const before = await persistedCounts();
    await db.insert(githubWebhookEvents).values({
      id: event.id,
      orgId,
      projectId,
      repositoryId,
      installationId: installationRowId,
      eventType: event.eventType,
      payload: event.payload,
      verified: true,
    });
    try {
      await boss.start();
      await boss.createQueue("github.webhook");
      const initialJob = await boss.send("github.webhook", { inboundEventId: event.id });
      if (!initialJob) throw new Error("expected initial delivery job");
      rateLimitFor = event.payload.sender.login;
      await registerGithubWebhookWorker(boss, (id) => github.handleInbound(id), {
        info: () => undefined,
      });
      await vi.waitFor(
        async () => {
          expect((await boss.getJobById("github.webhook", initialJob))?.state).toBe("completed");
        },
        { timeout: 5_000, interval: 100 },
      );
      const deferred = await client.unsafe(
        `SELECT id, data, start_after FROM "${schema}".job WHERE id <> $1 AND name = 'github.webhook'`,
        [initialJob],
      );
      expect(deferred).toHaveLength(1);
      expect(deferred[0]?.data).toEqual({ inboundEventId: event.id });
      expect(new Date(deferred[0]?.start_after).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
      expect(await boss.fetch("github.webhook")).toEqual([]);
      expect(await persistedCounts()).toEqual(before);
      expect(
        (
          await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, event.id))
        )[0],
      ).toMatchObject({ processedAt: null, error: "github_webhook_processing_failed" });
      expect(
        await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, `github-trigger-denied:${orgId}:${event.id}`)),
      ).toHaveLength(0);

      // Advance only this isolated queue's persisted deadline; external calls
      // remain deterministic fakes, and no wall-clock hour elapses in CI.
      permission = afterReset;
      await client.unsafe(`UPDATE "${schema}".job SET start_after = now() WHERE id = $1`, [
        deferred[0]?.id,
      ]);
      await vi.waitFor(
        async () => {
          expect((await boss.getJobById("github.webhook", deferred[0]?.id))?.state).toBe(
            "completed",
          );
        },
        { timeout: 5_000, interval: 100 },
      );
      const after = await persistedCounts();
      expect(after.turns).toBe(before.turns + (afterReset === "write" ? 1 : 0));
      if (afterReset === "read") expect(after).toEqual(before);
      const denials = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, `github-trigger-denied:${orgId}:${event.id}`));
      expect(denials).toHaveLength(afterReset === "read" ? 1 : 0);
      if (afterReset === "read")
        expect(denials[0]?.payload).toEqual({
          reason: "github_sender_not_authorized",
          eventType: "issue_comment",
        });
      expect(
        (
          await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, event.id))
        )[0],
      ).toMatchObject({ processedAt: expect.any(Date), error: null });
      await github.handleInbound(event.id);
      expect(await persistedCounts()).toEqual(after);
    } finally {
      permission = "write";
      rateLimitFor = undefined;
      await boss.stop({ graceful: true, timeout: 5_000 });
      await client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }, 15_000);

  it("maintains linked PR metadata on comments that match no agent", async () => {
    const agent = agents[0];
    if (!agent) throw new Error("expected agent fixture");
    const linked = await storiesService.start({
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "pull-request:506",
      title: "Existing PR",
      agent,
      message: "Plan the work",
      messageDedupeKey: `pr-comment-${suffix}`,
      actor: { type: "service", id: "github:maintainer" },
      workspace: workspaceInput(projectManifest),
      trigger: { type: "github", key: "issues:opened" },
    });
    await storiesService.associatePullRequest({
      orgId,
      projectId,
      storyId: linked.story.id,
      pullRequestNumber: 506,
    });
    const before = await persistedCounts();
    const event = commandEvent("Ordinary PR discussion", 506);
    await expect(
      github.handle({
        ...event,
        payload: {
          ...event.payload,
          issue: {
            ...event.payload.issue,
            pull_request: { html_url: "https://github.test/acme/app/pull/506" },
          },
        },
      }),
    ).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
    expect((await storiesService.get(orgId, projectId, linked.story.id)).story.pullRequestUrl).toBe(
      "https://github.test/acme/app/pull/506",
    );
    expect(await persistedCounts()).toEqual(before);
  });

  it("denies suspended, cross-tenant, and unlinked installations before requesting credentials", async () => {
    const before = await persistedCounts();
    const requestsBefore = permissionRequests.length;
    const event = commandEvent("/builder");
    try {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date() })
        .where(eq(githubInstallations.id, installationRowId));
      await expect(github.handle(event)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
      await expect(
        db
          .update(projectRepositories)
          .set({ installationId: otherInstallationRowId })
          .where(eq(projectRepositories.id, repositoryId)),
      ).rejects.toMatchObject({
        cause: { code: "23503", constraint_name: "project_repositories_installation_scope_fk" },
      });
      await expect(github.handle(event)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
      await db
        .update(projectRepositories)
        .set({ installationId: null })
        .where(eq(projectRepositories.id, repositoryId));
      await expect(github.handle(event)).resolves.toEqual({ matched: 0, queued: 0, merged: 0 });
    } finally {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null })
        .where(eq(githubInstallations.id, installationRowId));
      await db
        .update(projectRepositories)
        .set({ installationId: installationRowId })
        .where(eq(projectRepositories.id, repositoryId));
    }
    expect(permissionRequests).toHaveLength(requestsBefore);
    expect(await persistedCounts()).toEqual(before);
  });

  it("starts the requested role once and keeps builder acceptance in the same issue workspace", async () => {
    const plan = commandEvent("/architect plan this work", 502);
    await expect(github.handle(plan)).resolves.toEqual({ matched: 1, queued: 1, merged: 0 });
    await expect(github.handle(plan)).resolves.toEqual({ matched: 1, queued: 0, merged: 0 });
    const build = commandEvent("/builder implement the accepted plan", 502);
    await expect(github.handle(build)).resolves.toEqual({ matched: 1, queued: 1, merged: 0 });
    const issueStories = await db
      .select()
      .from(stories)
      .where(and(eq(stories.projectId, projectId), eq(stories.externalId, "issue:502")));
    expect(issueStories).toHaveLength(1);
    const story = issueStories[0];
    if (!story) throw new Error("expected command story");
    expect(await db.select().from(workspaces).where(eq(workspaces.storyId, story.id))).toHaveLength(
      1,
    );
    const messages = await db
      .select()
      .from(storyMessages)
      .where(eq(storyMessages.storyId, story.id));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.requestedAgentName)).toEqual(
      expect.arrayContaining(["architect", "builder"]),
    );
    const before = await persistedCounts();
    try {
      permission = "read";
      await expect(github.handle(commandEvent("/builder", 502))).resolves.toEqual({
        matched: 0,
        queued: 0,
        merged: 0,
      });
    } finally {
      permission = "write";
    }
    expect(await persistedCounts()).toEqual(before);
  });

  it("reuses an issue workspace for its pull request and only suspends it after merge", async () => {
    const builderAgent = agents.find((agent) => agent.name === "builder");
    if (!builderAgent) throw new Error("expected builder agent");
    const issueStory = await storiesService.start({
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:91",
      title: "Build this change",
      branch: "feature/review-me",
      agent: builderAgent,
      message: "Implement the issue before opening its pull request.",
      messageDedupeKey: `issue-pr-link-${suffix}`,
      actor: { type: "service", id: "github:contributor" },
      workspace: workspaceInput(projectManifest),
      trigger: { type: "github", key: "issues:opened" },
    });
    const opened = {
      id: `delivery-${randomUUID()}`,
      orgId,
      eventType: "pull_request",
      payload: {
        action: "opened",
        repository: { owner: { login: "acme" }, name: `app-${suffix}` },
        pull_request: {
          number: 91,
          title: "Review this change",
          html_url: "https://github.com/acme/app/pull/91",
          head: { ref: "feature/review-me" },
          merged: false,
        },
        sender: { type: "User", login: "contributor" },
      },
    };
    await expect(github.handle(opened)).resolves.toEqual({ matched: 1, queued: 1, merged: 0 });
    const story = (
      await db
        .select()
        .from(stories)
        .where(and(eq(stories.projectId, projectId), eq(stories.externalId, "issue:91")))
        .limit(1)
    )[0];
    if (!story) throw new Error("expected pull-request story");
    expect(story.id).toBe(issueStory.story.id);
    expect(story.pullRequestNumber).toBe(91);
    expect(
      await db
        .select()
        .from(stories)
        .where(and(eq(stories.projectId, projectId), eq(stories.externalId, "pull-request:91"))),
    ).toHaveLength(0);
    const workspace = (
      await db.select().from(workspaces).where(eq(workspaces.storyId, story.id)).limit(1)
    )[0];
    if (!workspace?.externalRef) throw new Error("expected running pull-request workspace");

    await expect(
      github.handle({
        ...opened,
        id: `delivery-${randomUUID()}`,
        payload: {
          ...opened.payload,
          action: "closed",
          pull_request: { ...opened.payload.pull_request, merged: true },
        },
      }),
    ).resolves.toEqual({ matched: 0, queued: 0, merged: 1 });
    await expect(storiesService.get(orgId, projectId, story.id)).resolves.toMatchObject({
      story: { status: "done", pullRequestNumber: 91 },
      workspace: { id: workspace.id, state: "sleeping", destroyedAt: null },
    });
    await expect(
      runtime.inspect({
        id: workspace.id,
        image: "facility-runner:test",
        externalRef: workspace.externalRef,
        volumeRef: workspace.volumeRef,
      }),
    ).resolves.toMatchObject({ state: "sleeping", volumeRef: workspace.volumeRef });
  });

  it("routes review and workflow payloads to the matching standard agents", async () => {
    const reviewDelivery = `delivery-${randomUUID()}`;
    await expect(
      github.handle({
        id: reviewDelivery,
        orgId,
        eventType: "pull_request_review",
        payload: {
          action: "submitted",
          repository: { owner: { login: "acme" }, name: `app-${suffix}` },
          pull_request: {
            number: 141,
            title: "Address this review",
            html_url: "https://github.test/acme/app/pull/141",
            head: { ref: "feature/address-review" },
          },
          review: {
            id: 901,
            state: "changes_requested",
            body: "Please cover the empty input path.",
            html_url: "https://github.test/acme/app/pull/141#review-901",
          },
          sender: { type: "User", login: "reviewer" },
        },
      }),
    ).resolves.toEqual({ matched: 1, queued: 1, merged: 0 });

    const workflowDelivery = `delivery-${randomUUID()}`;
    await expect(
      github.handle({
        id: workflowDelivery,
        orgId,
        eventType: "workflow_run",
        payload: {
          action: "completed",
          repository: { owner: { login: "acme" }, name: `app-${suffix}` },
          workflow_run: {
            id: 902,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.test/acme/app/actions/runs/902",
            head_branch: "feature/repair-ci",
            head_sha: "f".repeat(40),
            pull_requests: [{ number: 142 }],
          },
          sender: { type: "Bot", login: "github-actions" },
        },
      }),
    ).resolves.toEqual({ matched: 1, queued: 1, merged: 0 });

    const routedTurns = await db
      .select()
      .from(turns)
      .where(and(eq(turns.projectId, projectId), eq(turns.triggerType, "github")));
    expect(routedTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentName: "address-review",
          triggerKey: "pull_request_review:review-submitted",
        }),
        expect.objectContaining({
          agentName: "ci-doctor",
          triggerKey: "workflow_run:workflow-completed",
        }),
      ]),
    );
    const routedMessages = await db
      .select()
      .from(storyMessages)
      .where(eq(storyMessages.projectId, projectId));
    const reviewPrompt = routedMessages.find((message) => message.body.includes(reviewDelivery));
    const workflowPrompt = routedMessages.find((message) =>
      message.body.includes(workflowDelivery),
    );
    expect(reviewPrompt?.body).toContain('"state":"changes_requested"');
    expect(reviewPrompt?.body).toContain('"body":"Please cover the empty input path."');
    expect(workflowPrompt?.body).toContain('"conclusion":"failure"');
    expect(workflowPrompt?.body).toContain('"head_branch":"feature/repair-ci"');
  });

  it("claims each due schedule once while preserving one long-lived scheduled story", async () => {
    const initial = new Date("2026-01-01T00:00:00.000Z");
    await scheduler.tick(initial);
    const dueAt = new Date("2026-01-01T02:00:00.000Z");
    await db
      .update(agentSchedules)
      .set({ nextRunAt: dueAt })
      .where(
        and(
          eq(agentSchedules.projectId, projectId),
          eq(agentSchedules.agentName, "security-audit"),
        ),
      );
    const now = dueAt;
    const results = await Promise.all([scheduler.tick(now), scheduler.tick(now)]);
    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);

    const scheduledStory = (
      await db
        .select()
        .from(stories)
        .where(
          and(
            eq(stories.projectId, projectId),
            eq(stories.provider, "schedule"),
            eq(stories.externalId, "security-audit:nightly"),
          ),
        )
    )[0];
    if (!scheduledStory) throw new Error("expected scheduled story");
    expect(
      await db.select().from(workspaces).where(eq(workspaces.storyId, scheduledStory.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, scheduledStory.id)),
    ).toHaveLength(1);
  });

  it("runs a schedule that fell behind once, not once per missed occurrence", async () => {
    // security-audit:nightly is `0 2 * * *` UTC. Put it a week in arrears, the
    // shape of a worker that was down: seven occurrences have come due.
    const dueAt = new Date("2026-01-03T02:00:00.000Z");
    const now = new Date("2026-01-10T02:00:00.000Z");
    const scheduleRow = and(
      eq(agentSchedules.projectId, projectId),
      eq(agentSchedules.agentName, "security-audit"),
      eq(agentSchedules.triggerName, "nightly"),
    );
    await db
      .update(agentSchedules)
      .set({ nextRunAt: dueAt, lastScheduledAt: null })
      .where(scheduleRow);

    const scheduledStory = (
      await db
        .select()
        .from(stories)
        .where(
          and(
            eq(stories.projectId, projectId),
            eq(stories.provider, "schedule"),
            eq(stories.externalId, "security-audit:nightly"),
          ),
        )
    )[0];
    if (!scheduledStory) throw new Error("expected scheduled story");
    const messagesBefore = (
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, scheduledStory.id))
    ).length;

    // Three ticks at the same instant: the worker runs `* * * * *`, so the
    // backlog would drain a turn per minute until it caught up.
    const results = [];
    for (let tick = 0; tick < 3; tick += 1) results.push(await scheduler.tick(now));

    // `scheduled` is attributable to this fixture: the catalog and manifest
    // sources throw for any project but this one, so a schedule left in the
    // shared test database by another suite becomes a failure, never a run.
    // The tick counters are global for the same reason, so the rest of the
    // assertions read this project's own rows.
    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, scheduledStory.id)),
    ).toHaveLength(messagesBefore + 1);

    // The claim satisfies the occurrence it observed and leaves the schedule
    // ahead of the clock, so the catch-up cannot restart on the next tick.
    const [after] = await db.select().from(agentSchedules).where(scheduleRow);
    expect(after?.lastScheduledAt).toEqual(dueAt);
    expect(after?.nextRunAt).toEqual(new Date("2026-01-11T02:00:00.000Z"));
  });
});

function render(agent: ReturnType<typeof manifest>) {
  const triggers = agent.triggers
    .map((trigger) => {
      if (!("name" in trigger)) {
        return `  - type: ${trigger.type}`;
      }
      if (trigger.type === "schedule") {
        return `  - type: schedule\n    name: ${trigger.name}\n    cron: '${trigger.cron}'\n    timezone: ${trigger.timezone}`;
      }
      const actions = trigger.actions ? `\n    actions: [${trigger.actions.join(", ")}]` : "";
      const labels = trigger.labels ? `\n    labels: [${trigger.labels.join(", ")}]` : "";
      const command = trigger.command ? `\n    command: ${trigger.command}` : "";
      return `  - type: github\n    name: ${trigger.name}\n    event: ${trigger.event}${actions}${labels}${command}`;
    })
    .join("\n");
  return `---
name: ${agent.name}
description: ${agent.description}
engine: ${agent.engine}
model: ${agent.model}
enabled: ${agent.enabled}
options: {}
triggers:
${triggers}
---
${agent.prompt}
`;
}

function workspaceInput(manifest: ProjectManifest) {
  return {
    image: "facility-runner:test",
    ports: Object.entries(manifest.environment.services).map(([service, value]) => ({
      service,
      port: value.port,
      protocol: value.protocol,
      websocket: value.websocket,
    })),
  };
}
