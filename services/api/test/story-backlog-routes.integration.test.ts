import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentManifest } from "@facility/agents";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubInstallations,
  githubIssues,
  migrate,
  projectRepositories,
  projects,
  seed,
  stories,
  storyAssignees,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { buildApp } from "../src/app.js";
import { StoryTitleService } from "../src/stories/titles.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type {
  ProjectManifest,
  ProjectManifestSource,
} from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

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

function agent(
  name: string,
  engine: "claude_code" | "codex",
  enabled = true,
  triggers: Array<Record<string, unknown>> = [{ type: "ui" }, { type: "mcp" }, { type: "manual" }],
) {
  return renderAgentManifest(
    {
      name,
      description: `${name} agent`,
      engine,
      model: engine === "codex" ? "gpt-5.5" : "claude-sonnet-5",
      enabled,
      options: {},
      triggers: triggers as never,
      prompt: `Run the ${name} role.`,
    },
    `.agents/${name}.md`,
  );
}

describe("backlog and story creation routes", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; backlog route tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-backlog-routes-"));
  const suffix = randomUUID().slice(0, 8);
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const repositoryId = newId("repo");
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
  let credentials: Record<string, string> = { anthropic: "sk-ant-test" };
  const completions: string[] = [];
  const catalogSource: AgentCatalogSource = {
    load: async () => ({
      commitSha: "c".repeat(40),
      sources: [
        { file: ".agents/builder.md", source: agent("builder", "codex").source },
        { file: ".agents/architect.md", source: agent("architect", "claude_code").source },
        {
          file: ".agents/nightly.md",
          source: agent("nightly", "codex", true, [
            { type: "schedule", name: "nightly", cron: "0 2 * * *", timezone: "UTC" },
          ]).source,
        },
        { file: ".agents/retired.md", source: agent("retired", "codex", false).source },
      ],
    }),
  };
  const projectManifest: ProjectManifest = {
    version: 1,
    repositories: { primary: `acme/app-${suffix}`, related: [] },
    environment: { start: "true", secrets: [], variables: [], services: {} },
    hash: "project-manifest",
  } as ProjectManifest;
  const projectManifests: ProjectManifestSource = { load: async () => projectManifest };
  const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const base = createStoryDomain({
    db,
    config,
    runtime: new FakeWorkspaceRuntime(root),
    enqueue: async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    },
  });
  const domain = {
    ...base,
    catalog: new AgentCatalogService(db, catalogSource),
    projectManifests: projectManifests as typeof base.projectManifests,
    titles: new StoryTitleService(db, {
      credentials: async () => credentials,
      budget: base.costs,
      complete: async (call) => {
        completions.push(call.request);
        return { title: "Retry the nightly sync automatically", inputTokens: 10, outputTokens: 5 };
      },
      enqueue: async (data) => {
        enqueued.push({ queue: "stories.title", data });
      },
    }),
  };
  const app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
  let ownerCookie = "";
  let viewerSecret = "";
  let maintainerSecret = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db.insert(projects).values([
      {
        id: projectId,
        orgId: "org_local",
        name: "Backlog routes",
        slug: `backlog-routes-${suffix}`,
        settings: {},
      },
      {
        id: otherProjectId,
        orgId: "org_local",
        name: "Other",
        slug: `backlog-other-${suffix}`,
        settings: {},
      },
    ]);
    const installationId = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId: "org_local",
      installationId: Math.floor(Math.random() * 1_000_000_000) + 900_000,
      accountId: 3,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId: "org_local",
      projectId,
      installationId,
      owner: "acme",
      name: `app-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId: "org_local",
      projectId,
      repositoryId,
      number: 41,
      title: "Nightly sync fails on transient errors",
      state: "open",
      labels: ["bug"],
      assignees: ["dana"],
      htmlUrl: "https://github.com/acme/app/issues/41",
      githubUpdatedAt: new Date("2026-09-09T00:00:00Z"),
    });
    const viewer = await generateApiKey("fak");
    const maintainer = await generateApiKey("fak");
    viewerSecret = viewer.secret;
    maintainerSecret = maintainer.secret;
    await db.insert(apiKeys).values([
      {
        id: viewer.id,
        orgId: "org_local",
        name: "viewer",
        prefix: viewer.lookup,
        last4: viewer.last4,
        hash: viewer.hash,
        scopeType: "project",
        projectId,
        roleId: "role_bundled_viewer",
      },
      {
        id: maintainer.id,
        orgId: "org_local",
        name: "maintainer key",
        prefix: maintainer.lookup,
        last4: maintainer.last4,
        hash: maintainer.hash,
        scopeType: "project",
        projectId,
        roleId: "role_bundled_maintainer",
      },
    ]);
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    ownerCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("reports the default agent and title generation availability with the catalog", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/story-agents`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      defaults: { ui: "builder", mcp: "builder", manual: "builder" },
      title_generation: true,
    });
    expect(response.json().agents.map((entry: { name: string }) => entry.name)).toEqual([
      "architect",
      "builder",
      "nightly",
      "retired",
    ]);
  });

  it("creates a story from a request alone, generates its title later, and never duplicates it", async () => {
    const key = `ui-start-${suffix}`;
    const request = {
      message: "Please make the nightly sync retry transient errors before failing the run.",
      idempotency_key: key,
    };
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: { cookie: ownerCookie, "idempotency-key": key, "x-facility-surface": "ui" },
      payload: request,
    });
    expect(created.statusCode, created.body).toBe(202);
    const body = created.json();
    expect(body.story).toMatchObject({
      title: "Please make the nightly sync retry transient errors before failing the run.",
      titleSource: "pending",
      provider: "manual",
    });
    expect(body.queued.turn.agentName).toBe("builder");
    expect(body.assignees).toEqual([
      expect.objectContaining({ kind: "user", subject: "user_local_admin", source: "facility" }),
    ]);
    expect(enqueued).toContainEqual({
      queue: "stories.title",
      data: { orgId: "org_local", projectId, storyId: body.story.id },
    });

    // The same request again (network retry) returns the same story without a second message.
    const replayed = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: {
        cookie: ownerCookie,
        "idempotency-key": `${key}-again`,
        "x-facility-surface": "ui",
      },
      payload: request,
    });
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json().story.id).toBe(body.story.id);
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, body.story.id)),
    ).toHaveLength(1);
    expect(await db.select().from(turns).where(eq(turns.storyId, body.story.id))).toHaveLength(1);

    // The worker's job replaces the provisional title; the request text is preserved.
    expect(
      await domain.titles.generate({ orgId: "org_local", projectId, storyId: body.story.id }),
    ).toEqual({
      outcome: "generated",
      title: "Retry the nightly sync automatically",
    });
    expect(completions[0]).toContain("nightly sync retry");
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/workspace-stories/${body.story.id}`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(fetched.json().story).toMatchObject({
      title: "Retry the nightly sync automatically",
      titleSource: "generated",
    });
    const conversation = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/workspace-stories/${body.story.id}/conversation`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(conversation.json().messages[0].body).toBe(request.message);
  });

  it("settles the title immediately when no provider credential is configured", async () => {
    credentials = {};
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: {
        cookie: ownerCookie,
        "idempotency-key": `no-creds-${suffix}`,
        "x-facility-surface": "ui",
      },
      payload: { message: "Document the release process", idempotency_key: `no-creds-${suffix}` },
    });
    credentials = { anthropic: "sk-ant-test" };
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json().story).toMatchObject({
      title: "Document the release process",
      titleSource: "fallback",
    });
    expect(enqueued.filter((job) => job.data.storyId === created.json().story.id)).toHaveLength(0);
  });

  it("keeps explicit titles, honours the chosen agent, and refuses unavailable agents", async () => {
    const explicit = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: {
        cookie: ownerCookie,
        "idempotency-key": `explicit-${suffix}`,
        "x-facility-surface": "ui",
      },
      payload: {
        title: "Ship the release notes",
        agent: "architect",
        message: "Plan the release notes",
        idempotency_key: `explicit-${suffix}`,
      },
    });
    expect(explicit.statusCode, explicit.body).toBe(202);
    expect(explicit.json().story).toMatchObject({
      title: "Ship the release notes",
      titleSource: "user",
    });
    expect(explicit.json().queued.turn.agentName).toBe("architect");

    for (const [agentName, code] of [
      ["retired", "agent_disabled"],
      ["nightly", "agent_trigger_unavailable"],
      ["missing", "agent_not_found"],
    ]) {
      const refused = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/workspace-stories`,
        headers: {
          cookie: ownerCookie,
          "idempotency-key": `refused-${agentName}-${suffix}`,
          "x-facility-surface": "ui",
        },
        payload: {
          agent: agentName,
          message: "x",
          idempotency_key: `refused-${agentName}-${suffix}`,
        },
      });
      expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
      expect(refused.json().error.code, agentName).toBe(code);
    }
  });

  it("starts work on a mirrored issue without duplicating it and records participation", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/backlog?q=%2341`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(before.json().items).toMatchObject([
      { kind: "issue", phase: "not_started", assignees: [{ login: "dana" }] },
    ]);
    const started = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: {
        cookie: ownerCookie,
        "idempotency-key": `issue-41-${suffix}`,
        "x-facility-surface": "ui",
      },
      payload: {
        provider: "github",
        external_id: "issue:41",
        repository_id: repositoryId,
        title: "Nightly sync fails on transient errors",
        message: "Investigate and fix the retry logic.",
        idempotency_key: `issue-41-${suffix}`,
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json().story).toMatchObject({
      provider: "github",
      externalId: "issue:41",
      titleSource: "github",
    });
    const after = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/backlog?q=%2341&phase=all`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(after.json().items).toHaveLength(1);
    expect(after.json().items[0]).toMatchObject({
      kind: "story",
      phase: "in_progress",
      reason: "queued",
      issue: { number: 41 },
      story: { id: started.json().story.id },
    });
    // GitHub's assignee stays; the person who started the work is added, not substituted.
    expect(after.json().items[0].assignees).toEqual([
      expect.objectContaining({ key: "github:dana", sources: ["github"] }),
      expect.objectContaining({ key: "user:user_local_admin", sources: ["facility"] }),
    ]);

    // A service key continuing the story does not become an assignee.
    const serviceMessage = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories/${started.json().story.id}/messages`,
      headers: { authorization: `Bearer ${maintainerSecret}`, "idempotency-key": `svc-${suffix}` },
      payload: { message: "Also add a test.", idempotency_key: `svc-${suffix}` },
    });
    expect(serviceMessage.statusCode, serviceMessage.body).toBe(202);
    expect(
      await db
        .select()
        .from(storyAssignees)
        .where(eq(storyAssignees.storyId, started.json().story.id)),
    ).toHaveLength(1);
    const unknownRepository = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: {
        cookie: ownerCookie,
        "idempotency-key": `bad-repo-${suffix}`,
        "x-facility-surface": "ui",
      },
      payload: {
        provider: "github",
        external_id: "issue:41",
        repository_id: "repo_missing",
        message: "x",
        idempotency_key: `bad-repo-${suffix}`,
      },
    });
    expect(unknownRepository.statusCode).toBe(404);
  });

  it("serves the backlog to readers only within their project scope", async () => {
    const listed = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/backlog?phase=all&limit=2&offset=1&assignee=me`,
      headers: { cookie: ownerCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ limit: 2, offset: 1 });
    expect(listed.json().items.length).toBeLessThanOrEqual(2);
    expect(listed.json().total).toBeGreaterThanOrEqual(3);
    const malformed = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/backlog?limit=500`,
      headers: { cookie: ownerCookie },
    });
    expect(malformed.statusCode).toBe(400);
    const crossProject = await app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/backlog`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(crossProject.statusCode).toBe(404);
    const anonymous = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/backlog` });
    expect(anonymous.statusCode).toBe(401);
    const pipeline = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/pipeline`,
      headers: { cookie: ownerCookie },
    });
    expect(pipeline.statusCode).toBe(404);
    // Reads never provisioned anything beyond the stories the tests started.
    expect(
      (await db.select().from(workspaces).where(eq(workspaces.projectId, projectId))).length,
    ).toBe((await db.select().from(stories).where(eq(stories.projectId, projectId))).length);
  });
});
