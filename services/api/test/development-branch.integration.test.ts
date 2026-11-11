import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubInstallations,
  migrate,
  orgs,
  projectRepositories,
  projects,
  roles,
  stories,
  storyConversations,
  turns,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AgentCatalogService, GithubAgentCatalogSource } from "../src/agents/catalog.js";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { repositoryDevelopmentBranch } from "../src/github/development-branch.js";
import { kickstartRepo } from "../src/github/kickstart.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import type { AppConfig, Principal } from "../src/types.js";
import { GithubProjectManifestSource } from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const orgId = newId("org"),
  foreignOrgId = newId("org"),
  projectId = newId("proj"),
  otherProjectId = newId("proj"),
  foreignProjectId = newId("proj");
const installationId = newId("ghi"),
  repositoryId = newId("repo"),
  storyId = newId("story"),
  conversationId = newId("msg"),
  turnId = newId("turn");
const config: AppConfig = {
  databaseUrl,
  secretMasterKey: Buffer.alloc(32, 14).toString("base64"),
  port: 4400,
  publicUrl: "https://api.facility.test",
  facilityInsecureDev: true,
  workspaceDriver: "docker",
  workspaceImage: "test",
  logLevel: "silent",
};
let app: Awaited<ReturnType<typeof buildApp>>;
let writer: string, reader: string, projectWriter: string;
const mainSha = "a".repeat(40),
  developSha = "b".repeat(40);
const source = (label: string) =>
  `---\nname: builder\ndescription: ${label}\nengine: codex\nmodel: gpt-5.5\nenabled: true\ntriggers:\n  - type: manual\n---\nBuild ${label}.\n`;
const manifest = (label: string) =>
  `version: 1\nrepositories:\n  primary: github.com/acme/app\nenvironment:\n  setup: echo ${label}\n  start: 'true'\n`;
const getBranch = vi.fn(async ({ branch }: Record<string, unknown>) => {
  if (branch === "develop" && developmentUnavailable)
    throw Object.assign(new Error("missing"), { status: 404 });
  if (branch === "missing") throw Object.assign(new Error("missing"), { status: 404 });
  if (branch === "denied") throw Object.assign(new Error("denied"), { status: 403 });
  return { data: { commit: { sha: branch === "main" ? mainSha : developSha } } };
});
let kickstart = false;
let developmentUnavailable = false;
const getContent = vi.fn(async ({ path, ref }: Record<string, unknown>) => {
  const label = ref === mainSha ? "stable" : "development";
  let content: unknown;
  if (kickstart) {
    if (path === "package.json") content = { type: "file", content: '{"scripts":{"dev":"vite"}}' };
    else throw Object.assign(new Error("missing"), { status: 404 });
  } else if (path === ".agents") content = [{ type: "file", path: ".agents/builder.md" }];
  else if (path === ".agents/builder.md") content = { type: "file", content: source(label) };
  else if (path === ".facility.yml") content = { type: "file", content: manifest(label) };
  else if (path === ".claude/skills") content = [{ type: "dir", path: ".claude/skills/planning" }];
  else if (path === ".claude/skills/planning")
    content = [{ type: "file", path: ".claude/skills/planning/SKILL.md" }];
  else if (path === ".claude/skills/planning/SKILL.md")
    content = { type: "file", content: `---\nname: planning\ndescription: ${label}\n---\nPlan.` };
  else throw Object.assign(new Error("missing"), { status: 404 });
  return { data: content };
});
const createPullRequest = vi.fn(async () => ({
  data: { number: 42, html_url: "https://github.com/acme/app/pull/42" },
}));
const createRef = vi.fn(async () => ({ data: {} }));
const createCommit = vi.fn(async () => ({ data: { sha: "c".repeat(40) } }));
const factory = (async () => ({
  rest: {
    repos: { getBranch, getContent },
    git: {
      getCommit: async () => ({ data: { sha: developSha, tree: { sha: "d".repeat(40) } } }),
      createBlob: async () => ({ data: { sha: "e".repeat(40) } }),
      createTree: async () => ({ data: { sha: "f".repeat(40) } }),
      createCommit,
      createRef,
      updateRef: async () => ({ data: {} }),
    },
    pulls: { list: async () => ({ data: [] }), create: createPullRequest },
  },
})) as unknown as GithubClientFactory;
beforeAll(async () => {
  await migrate(databaseUrl);
  await db.insert(orgs).values([orgId, foreignOrgId].map((id) => ({ id, name: id, slug: id })));
  await db.insert(projects).values([
    { id: projectId, orgId, name: "Development", slug: projectId, settings: { retained: true } },
    { id: otherProjectId, orgId, name: "Other", slug: otherProjectId },
    { id: foreignProjectId, orgId: foreignOrgId, name: "Foreign", slug: foreignProjectId },
  ]);
  await db.insert(githubInstallations).values({
    id: installationId,
    orgId,
    installationId: Math.floor(Math.random() * 1e9),
    accountLogin: "acme",
    accountId: 1234,
    targetType: "Organization",
  });
  await db.insert(projectRepositories).values({
    id: repositoryId,
    orgId,
    projectId,
    installationId,
    owner: "acme",
    name: "app",
    defaultBranch: "main",
    role: "primary",
  });
  for (const [permissions, assign] of [
    [
      ["projects:read", "projects:write", "repos:write"],
      (token: string) => {
        writer = token;
      },
    ],
    [
      ["projects:read"],
      (token: string) => {
        reader = token;
      },
    ],
    [
      ["projects:write"],
      (token: string) => {
        projectWriter = token;
      },
    ],
  ] as const) {
    const roleId = newId("role"),
      generated = await generateApiKey("fak");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: roleId, permissions: [...permissions] });
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      roleId,
      projectId,
      scopeType: "project",
      name: "branch-test",
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
    });
    assign(generated.secret);
  }
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    title: "Retained story",
    provider: "manual",
    externalId: storyId,
    branch: "feature/retained",
    createdBy: { type: "key", id: "test" },
  });
  await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
  await db.insert(turns).values({
    id: turnId,
    orgId,
    projectId,
    storyId,
    conversationId,
    agentName: "builder",
    manifestHash: "old-hash",
    manifest: { prompt: "immutable" },
    engine: "codex",
    model: "gpt-5.5",
    state: "queued",
    triggerType: "manual",
    createdBy: { type: "key", id: "test" },
  });
  app = await buildApp(config);
  app.githubClientFactory = factory;
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await client.end();
});
const patch = (
  payload: Record<string, unknown>,
  target = projectId,
  token = writer,
  key = randomUUID(),
) =>
  app.inject({
    method: "PATCH",
    url: `/v1/projects/${target}`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
    payload,
  });
it("selects development sources and preserves metadata, settings, stories and queued/running snapshots", async () => {
  const catalog = new GithubAgentCatalogSource(db, factory);
  expect((await catalog.load(orgId, projectId)).sources[0]?.source).toContain("stable");
  const key = randomUUID();
  const response = await patch({ developmentBranch: "develop" }, projectId, writer, key);
  expect(response.statusCode).toBe(200);
  expect(response.json().settings).toEqual({ retained: true, developmentBranch: "develop" });
  expect((await patch({ developmentBranch: "develop" }, projectId, writer, key)).json()).toEqual(
    response.json(),
  );
  const snapshot = await catalog.load(orgId, projectId);
  expect(snapshot.commitSha).toBe(developSha);
  expect(snapshot.sources[0]?.source).toContain("development");
  expect(snapshot.skills?.[0]?.source).toContain("development");
  expect(
    (await new GithubProjectManifestSource(db, factory).load(orgId, projectId)).environment.setup,
  ).toBe("echo development");
  const tokenFactory = vi.fn(async () => ({
    token: "fake-installation-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    gitIdentity: { name: "test[bot]", email: "test@example.com" },
  }));
  expect(
    (await new GithubWorkspaceCredentialBroker(db, tokenFactory).issue(orgId, projectId))
      .repositories[0],
  ).toMatchObject({ defaultBranch: "main", developmentBranch: "develop" });
  expect(
    await repositoryDevelopmentBranch(db, {
      orgId,
      projectId,
      role: "related",
      defaultBranch: "stable",
    }),
  ).toBe("stable");
  expect(
    (await db.select().from(projectRepositories).where(eq(projectRepositories.id, repositoryId)))[0]
      ?.defaultBranch,
  ).toBe("main");
  expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0]?.branch).toBe(
    "feature/retained",
  );
  expect((await db.select().from(turns).where(eq(turns.id, turnId)))[0]).toMatchObject({
    manifestHash: "old-hash",
    manifest: { prompt: "immutable" },
    state: "queued",
  });
  await db.update(turns).set({ state: "running" }).where(eq(turns.id, turnId));
  expect((await patch({ developmentBranch: "main" })).statusCode).toBe(200);
  expect((await db.select().from(turns).where(eq(turns.id, turnId)))[0]).toMatchObject({
    manifestHash: "old-hash",
    manifest: { prompt: "immutable" },
    state: "running",
  });
  expect((await patch({ developmentBranch: "develop" })).statusCode).toBe(200);
});
it("targets agent and kickstart configuration PRs at the selected development base", async () => {
  await patch({ developmentBranch: "develop" });
  const catalog = new GithubAgentCatalogSource(db, factory);
  await catalog.proposeUpdate(orgId, projectId, {
    name: "builder",
    source: source("edited"),
    expectedCommitSha: developSha,
  });
  expect(createPullRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({
      base: "develop",
      head: expect.stringMatching(/^facility\/agent-builder-[a-f0-9]{12}$/),
    }),
  );
  expect(createCommit).toHaveBeenLastCalledWith(expect.objectContaining({ parents: [developSha] }));
  const repo = (
    await db.select().from(projectRepositories).where(eq(projectRepositories.id, repositoryId))
  )[0];
  if (!repo) throw Error("Missing fixture");
  kickstart = true;
  try {
    await kickstartRepo({
      db,
      factory,
      config,
      principal: { orgId } as Principal,
      projectId,
      repo,
      answers: {},
    });
    expect(createPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        base: "develop",
        head: expect.stringMatching(/^facility\/kickstart-0\.12-[a-f0-9]{12}$/),
      }),
    );
    expect(createCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({ parents: [developSha] }),
    );
  } finally {
    kickstart = false;
  }
});
it("rejects unauthorized, cross-project, cross-tenant, malformed and unavailable branch changes", async () => {
  for (const [target, token] of [
    [projectId, reader],
    [projectId, projectWriter],
    [otherProjectId, writer],
    [foreignProjectId, writer],
  ]) {
    getBranch.mockClear();
    expect((await patch({ developmentBranch: "other" }, target, token)).statusCode).toBe(
      target === projectId ? 403 : 404,
    );
    expect(getBranch).not.toHaveBeenCalled();
  }
  for (const branch of ["refs/heads/dev", "", "dev~1", "a//b", 1, true])
    expect((await patch({ developmentBranch: branch })).statusCode).toBe(400);
  expect((await patch({ developmentBranch: "develop", settings: {} })).statusCode).toBe(400);
  expect((await patch({ developmentBranch: "missing" })).statusCode).toBe(400);
  expect((await patch({ developmentBranch: "denied" })).statusCode).toBe(503);
  expect((await patch({ settings: {} }, projectId, projectWriter)).statusCode).toBe(403);
  const previous = (await db.select().from(projects).where(eq(projects.id, projectId)))[0]
    ?.settings;
  expect(previous).toMatchObject({ developmentBranch: "develop" });
  await db
    .update(githubInstallations)
    .set({ suspendedAt: new Date() })
    .where(eq(githubInstallations.id, installationId));
  try {
    expect((await patch({ developmentBranch: "other" })).statusCode).toBe(503);
    await expect(
      new GithubAgentCatalogSource(db, factory).load(orgId, projectId),
    ).rejects.toMatchObject({ code: "github_installation_unavailable" });
  } finally {
    await db
      .update(githubInstallations)
      .set({ suspendedAt: null })
      .where(eq(githubInstallations.id, installationId));
  }
});
it("does not dispatch a cached catalog from another source when the selected branch is removed", async () => {
  await patch({ developmentBranch: "develop" });
  const catalog = new AgentCatalogService(db, new GithubAgentCatalogSource(db, factory));
  await catalog.sync(orgId, projectId);
  developmentUnavailable = true;
  try {
    await expect(catalog.get(orgId, projectId, "builder")).rejects.toMatchObject({
      code: "agent_catalog_branch_unavailable",
    });
    await expect(
      new GithubProjectManifestSource(db, factory).load(orgId, projectId),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    developmentUnavailable = false;
  }
});
it("clears the override atomically and restores default-branch discovery", async () => {
  expect((await patch({ developmentBranch: null })).json().settings).toEqual({
    retained: true,
    developmentBranch: null,
  });
  expect((await new GithubAgentCatalogSource(db, factory).load(orgId, projectId)).commitSha).toBe(
    mainSha,
  );
  await expect(
    new GithubAgentCatalogSource(db, factory).load(foreignOrgId, projectId),
  ).rejects.toMatchObject({ code: "primary_repository_not_found" });
});
