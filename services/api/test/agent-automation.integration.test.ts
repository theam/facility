import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  agentSchedules,
  createDb,
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
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubAgentTriggerService } from "../src/agents/github-triggers.js";
import { AgentScheduler } from "../src/agents/scheduler.js";
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
  const dispatched: string[] = [];
  const agents = [
    manifest(
      "architect",
      "  - type: github\n    name: plan-ready-issue\n    event: issues\n    actions: [opened]\n    labels: [ready]",
      "claude_code",
    ),
    manifest(
      "builder",
      "  - type: github\n    name: build-ready-issue\n    event: issues\n    actions: [opened]\n    labels: [ready]",
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
    await db.insert(projectRepositories).values({
      id: newId("repo"),
      orgId,
      projectId,
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
        sender: { login: "contributor" },
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

  it("reuses an issue workspace for its pull request and only suspends it after merge", async () => {
    const builderAgent = agents.find((agent) => agent.name === "builder");
    if (!builderAgent) throw new Error("expected builder agent");
    const issueStory = await storiesService.start({
      orgId,
      projectId,
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
        sender: { login: "contributor" },
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
          sender: { login: "reviewer" },
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
          sender: { login: "github-actions" },
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
      return `  - type: github\n    name: ${trigger.name}\n    event: ${trigger.event}${actions}${labels}`;
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
