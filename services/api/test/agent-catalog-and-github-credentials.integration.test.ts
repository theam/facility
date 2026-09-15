import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { newId } from "@facility/core";
import {
  agentManifests,
  createDb,
  githubInstallations,
  migrate,
  orgs,
  projectRepositories,
  projectSkills,
  projects,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentCatalogError,
  AgentCatalogService,
  type AgentCatalogSnapshot,
  type AgentCatalogSource,
  GithubAgentCatalogSource,
} from "../src/agents/catalog.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";

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

function source(name: string, engine: "claude_code" | "codex" = "codex") {
  return `---
name: ${name}
description: ${name} agent.
engine: ${engine}
model: ${engine === "codex" ? "gpt-5.5" : "claude-opus-4-8"}
enabled: true
options: {}
triggers:
  - type: manual
---
Execute the ${name} role and verify the result.
`;
}

function catalogGithub() {
  const state = { sha: "a".repeat(40), denied: 0, childFailure: 0, empty: false };
  const reads: Array<{ path: string; ref: string }> = [];
  let branchReads = 0;
  const factory = (async () => ({
    rest: {
      repos: {
        getBranch: async () => {
          branchReads++;
          if (state.denied)
            throw Object.assign(new Error("Access denied"), { status: state.denied });
          return { data: { commit: { sha: state.sha } } };
        },
        getContent: async ({ path, ref }: { path: string; ref: string }) => {
          reads.push({ path, ref });
          if (state.empty) throw Object.assign(new Error("Missing root"), { status: 404 });
          if (path === ".agents") return { data: [{ type: "file", path: ".agents/builder.md" }] };
          if (path === ".agents/builder.md")
            return { data: { type: "file", content: source("builder") } };
          if (path === ".claude/skills")
            return { data: [{ type: "dir", path: ".claude/skills/review" }] };
          if (path === ".claude/skills/review")
            return { data: [{ type: "file", path: ".claude/skills/review/SKILL.md" }] };
          if (path === ".claude/skills/review/SKILL.md") {
            if (state.childFailure)
              throw Object.assign(new Error("Failed child"), { status: state.childFailure });
            return {
              data: {
                type: "file",
                content: "---\nname: review\ndescription: Reviews changes.\n---\nReview.",
              },
            };
          }
          throw new Error("Unexpected path");
        },
      },
    },
  })) as unknown as GithubClientFactory;
  return { state, reads, factory, branchReads: () => branchReads };
}

describe("agent catalog and full GitHub workspace credentials", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; agent catalog tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const installationId = newId("ghi");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Agents", slug: `agents-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Agents",
      slug: `agents-${suffix}`,
      settings: {},
    });
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 10_000,
      accountId: 123,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: newId("repo"),
        orgId,
        projectId,
        installationId,
        owner: "acme",
        name: `app-${suffix}`,
        defaultBranch: "main",
        role: "primary",
      },
      {
        id: newId("repo"),
        orgId,
        projectId,
        installationId,
        owner: "acme",
        name: `shared-${suffix}`,
        defaultBranch: "main",
        role: "related",
      },
    ]);
  });

  afterAll(async () => {
    await client.end();
  });

  it("projects one canonical .agents snapshot and removes stale definitions", async () => {
    class MutableSource implements AgentCatalogSource {
      snapshot: AgentCatalogSnapshot = {
        commitSha: "a".repeat(40),
        sources: [
          { file: ".agents/architect.md", source: source("architect", "claude_code") },
          { file: ".agents/builder.md", source: source("builder") },
        ],
      };
      async load() {
        return this.snapshot;
      }
    }
    const canonical = new MutableSource();
    const catalog = new AgentCatalogService(db, canonical);
    expect((await catalog.list(orgId, projectId)).map((row) => row.name)).toEqual([
      "architect",
      "builder",
    ]);

    canonical.snapshot = {
      commitSha: "b".repeat(40),
      sources: [{ file: ".agents/builder.md", source: source("builder") }],
    };
    expect((await catalog.list(orgId, projectId)).map((row) => row.name)).toEqual(["builder"]);
    expect(
      (await db.select().from(agentManifests).where(eq(agentManifests.projectId, projectId)))[0],
    ).toMatchObject({ name: "builder", commitSha: "b".repeat(40) });

    canonical.snapshot = {
      commitSha: "c".repeat(40),
      sources: [{ file: ".agents/builder.md", source: source("architect") }],
    };
    await expect(catalog.sync(orgId, projectId)).rejects.toMatchObject({
      code: "agent_manifest_invalid",
    });
    expect((await catalog.list(orgId, projectId, { refresh: false }))[0]).toMatchObject({
      name: "builder",
      commitSha: "b".repeat(40),
    });
  });

  it("serves the last valid catalog while GitHub is unavailable", async () => {
    const cachedProjectId = newId("proj");
    await db.insert(projects).values({
      id: cachedProjectId,
      orgId,
      name: "Cached agents",
      slug: `cached-agents-${suffix}`,
      settings: {},
    });
    const available: AgentCatalogSource = {
      load: async () => ({
        commitSha: "e".repeat(40),
        sources: [{ file: ".agents/builder.md", source: source("builder") }],
      }),
    };
    await new AgentCatalogService(db, available).sync(orgId, cachedProjectId);

    const unavailable: AgentCatalogSource = {
      load: async () => {
        throw new AgentCatalogError(
          "agent_catalog_unavailable",
          "Agent catalog could not be refreshed from GitHub",
          503,
        );
      },
    };
    const catalog = new AgentCatalogService(db, unavailable);
    await expect(catalog.list(orgId, cachedProjectId)).resolves.toMatchObject([
      { name: "builder", commitSha: "e".repeat(40) },
    ]);
    await expect(catalog.get(orgId, cachedProjectId, "builder")).resolves.toMatchObject({
      name: "builder",
      commitSha: "e".repeat(40),
    });
  });

  it("keeps an explicit unavailable error when no cached catalog exists", async () => {
    const emptyProjectId = newId("proj");
    await db.insert(projects).values({
      id: emptyProjectId,
      orgId,
      name: "Unavailable agents",
      slug: `unavailable-agents-${suffix}`,
      settings: {},
    });
    const unavailable: AgentCatalogSource = {
      load: async () => {
        throw new AgentCatalogError(
          "agent_catalog_unavailable",
          "Agent catalog could not be refreshed from GitHub",
          503,
        );
      },
    };
    await expect(
      new AgentCatalogService(db, unavailable).list(orgId, emptyProjectId),
    ).rejects.toMatchObject({ code: "agent_catalog_unavailable", statusCode: 503 });
  });

  it("reads .agents from the primary repository commit", async () => {
    const encoded = (value: string) => Buffer.from(value).toString("base64");
    const factory = (async () => ({
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: "d".repeat(40) } } }),
          getContent: async ({ path }: { path: string }) => {
            if (path === ".agents") {
              return {
                data: [
                  { type: "file", path: ".agents/builder.md" },
                  { type: "dir", path: ".agents/skills" },
                ],
              };
            }
            if (path === ".agents/builder.md") {
              return {
                data: {
                  type: "file",
                  path,
                  encoding: "base64",
                  content: encoded(source("builder")),
                },
              };
            }
            if (path === ".agents/skills") {
              return { data: [{ type: "dir", path: ".agents/skills/review" }] };
            }
            if (path === ".agents/skills/review") {
              return { data: [{ type: "file", path: ".agents/skills/review/SKILL.md" }] };
            }
            if (path === ".agents/skills/review/SKILL.md") {
              return {
                data: {
                  type: "file",
                  path,
                  encoding: "base64",
                  content: encoded(
                    "---\nname: review\ndescription: Reviews project changes.\n---\n\n# Review\n",
                  ),
                },
              };
            }
            throw Object.assign(new Error("Optional directory missing"), { status: 404 });
          },
        },
      },
    })) as unknown as GithubClientFactory;
    const snapshot = await new GithubAgentCatalogSource(db, factory).load(orgId, projectId);
    expect(snapshot).toEqual({
      commitSha: "d".repeat(40),
      sources: [{ file: ".agents/builder.md", source: source("builder") }],
      skills: [
        {
          file: ".agents/skills/review/SKILL.md",
          source: "---\nname: review\ndescription: Reviews project changes.\n---\n\n# Review\n",
        },
      ],
    });
    const catalog = new AgentCatalogService(db, { load: async () => snapshot });
    await catalog.sync(orgId, projectId);
    await expect(catalog.listSkills(orgId, projectId, { refresh: false })).resolves.toMatchObject([
      { name: "review", directory: ".agents" },
    ]);
    expect(
      await db.select().from(projectSkills).where(eq(projectSkills.projectId, projectId)),
    ).toHaveLength(1);
  });

  it("shares complete immutable snapshots across concurrent refreshes while checking access and branch each time", async () => {
    const github = catalogGithub();
    const canonical = new GithubAgentCatalogSource(db, github.factory);
    const snapshots = await Promise.all(
      Array.from({ length: 20 }, () => canonical.load(orgId, projectId)),
    );
    expect(github.branchReads()).toBe(20);
    expect(github.reads).toHaveLength(5);
    expect(
      snapshots.every((snapshot) => snapshot.sources.length === 1 && snapshot.skills?.length === 1),
    ).toBe(true);
    const first = snapshots[0];
    if (!first) throw new Error("Expected a completed catalog snapshot");
    first.sources.splice(0);
    expect((await canonical.load(orgId, projectId)).sources).toHaveLength(1);
    expect(github.reads).toHaveLength(5);

    github.state.sha = "b".repeat(40);
    expect((await canonical.load(orgId, projectId)).commitSha).toBe(github.state.sha);
    expect(github.reads).toHaveLength(10);
    expect(github.reads.slice(5).every((read) => read.ref === github.state.sha)).toBe(true);

    for (const status of [401, 403, 404]) {
      github.state.denied = status;
      await expect(canonical.load(orgId, projectId)).rejects.toMatchObject({
        code: "agent_catalog_unavailable",
      });
      expect(github.reads).toHaveLength(10);
    }
    github.state.denied = 0;
    await db
      .update(githubInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubInstallations.id, installationId));
    try {
      await expect(canonical.load(orgId, projectId)).rejects.toMatchObject({
        code: "github_installation_unavailable",
      });
    } finally {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null })
        .where(eq(githubInstallations.id, installationId));
    }
    await expect(canonical.load(newId("org"), projectId)).rejects.toMatchObject({
      code: "primary_repository_not_found",
    });
    await expect(canonical.load(orgId, newId("proj"))).rejects.toMatchObject({
      code: "primary_repository_not_found",
    });
  });

  it.each([
    403, 404, 429, 500,
  ])("preserves complete projections after a partial refresh failure (%s) and retries the same commit", async (status) => {
    const github = catalogGithub();
    const canonical = new GithubAgentCatalogSource(db, github.factory);
    const catalog = new AgentCatalogService(db, canonical);
    await catalog.sync(orgId, projectId);
    github.state.sha = "b".repeat(40);
    github.state.childFailure = status;
    await expect(catalog.sync(orgId, projectId)).rejects.toMatchObject({
      code: "agent_catalog_unavailable",
    });
    expect(await catalog.list(orgId, projectId)).toMatchObject([
      { name: "builder", commitSha: "a".repeat(40) },
    ]);
    expect(await catalog.listSkills(orgId, projectId)).toMatchObject([
      { name: "review", commitSha: "a".repeat(40) },
    ]);
    github.state.childFailure = 0;
    await catalog.sync(orgId, projectId);
    expect(await catalog.list(orgId, projectId, { refresh: false })).toMatchObject([
      { name: "builder", commitSha: "b".repeat(40) },
    ]);
    expect(await catalog.listSkills(orgId, projectId, { refresh: false })).toMatchObject([
      { name: "review", commitSha: "b".repeat(40) },
    ]);
    // A successfully read new commit that actually removes both optional roots is authoritative.
    github.state.sha = "c".repeat(40);
    github.state.empty = true;
    await catalog.sync(orgId, projectId);
    expect(await catalog.list(orgId, projectId, { refresh: false })).toEqual([]);
    expect(await catalog.listSkills(orgId, projectId, { refresh: false })).toEqual([]);
  });

  it("validates an agent edit and writes it to a reviewable Git branch", async () => {
    const baseCommitSha = "a".repeat(40);
    const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
    const record = (operation: string, data: unknown) => async (args: Record<string, unknown>) => {
      calls.push({ operation, args });
      return { data };
    };
    const factory = (async () => ({
      rest: {
        repos: {
          getBranch: record("getBranch", { commit: { sha: baseCommitSha } }),
          getContent: record("getContent", {
            type: "file",
            path: ".agents/builder.md",
            encoding: "base64",
            content: Buffer.from(source("builder")).toString("base64"),
          }),
        },
        git: {
          getCommit: record("getCommit", { sha: baseCommitSha, tree: { sha: "b".repeat(40) } }),
          createBlob: record("createBlob", { sha: "c".repeat(40) }),
          createTree: record("createTree", { sha: "d".repeat(40) }),
          createCommit: record("createCommit", { sha: "e".repeat(40) }),
          createRef: record("createRef", {}),
          updateRef: record("updateRef", {}),
        },
        pulls: {
          list: record("listPullRequests", []),
          create: record("createPullRequest", {
            number: 41,
            html_url: "https://github.com/acme/app/pull/41",
          }),
        },
      },
    })) as unknown as GithubClientFactory;
    const catalog = new AgentCatalogService(db, new GithubAgentCatalogSource(db, factory));
    const edited = source("builder").replace("model: gpt-5.5", "model: gpt-5.6-sol");

    await expect(
      catalog.proposeUpdate(orgId, projectId, {
        name: "builder",
        source: edited,
        expectedCommitSha: baseCommitSha,
      }),
    ).resolves.toMatchObject({
      branch: "facility/agent-builder",
      baseCommitSha,
      commitSha: "e".repeat(40),
      agent: { name: "builder", model: "gpt-5.6-sol" },
      pullRequest: { number: 41, url: "https://github.com/acme/app/pull/41" },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "createRef",
          args: expect.objectContaining({ ref: "refs/heads/facility/agent-builder" }),
        }),
        expect.objectContaining({
          operation: "createPullRequest",
          args: expect.objectContaining({ head: "facility/agent-builder", base: "main" }),
        }),
      ]),
    );

    await expect(
      catalog.proposeUpdate(orgId, projectId, {
        name: "builder",
        source: edited,
        expectedCommitSha: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "agent_catalog_changed" });
  });

  it("reuses an identical proposal and appends later edits without force-pushing", async () => {
    const baseCommitSha = "1".repeat(40);
    const pullHeadSha = "2".repeat(40);
    const nextCommitSha = "6".repeat(40);
    const firstEdit = source("builder").replace("model: gpt-5.5", "model: gpt-5.6-sol");
    const secondEdit = firstEdit.replace("model: gpt-5.6-sol", "model: gpt-5.6-terra");
    const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
    const record = (operation: string, data: unknown) => async (args: Record<string, unknown>) => {
      calls.push({ operation, args });
      return { data };
    };
    const factory = (async () => ({
      rest: {
        repos: {
          getBranch: record("getBranch", { commit: { sha: baseCommitSha } }),
          getContent: async (args: Record<string, unknown>) => {
            calls.push({ operation: "getContent", args });
            const content = args.ref === pullHeadSha ? firstEdit : source("builder");
            return {
              data: {
                type: "file",
                path: ".agents/builder.md",
                encoding: "base64",
                content: Buffer.from(content).toString("base64"),
              },
            };
          },
        },
        git: {
          getCommit: record("getCommit", { sha: pullHeadSha, tree: { sha: "3".repeat(40) } }),
          createBlob: record("createBlob", { sha: "4".repeat(40) }),
          createTree: record("createTree", { sha: "5".repeat(40) }),
          createCommit: record("createCommit", { sha: nextCommitSha }),
          createRef: record("createRef", {}),
          updateRef: record("updateRef", {}),
        },
        pulls: {
          list: record("listPullRequests", [
            {
              number: 42,
              html_url: "https://github.com/acme/app/pull/42",
              head: { ref: "facility/agent-builder", sha: pullHeadSha },
              base: { ref: "main" },
            },
          ]),
          create: record("createPullRequest", {
            number: 43,
            html_url: "https://github.com/acme/app/pull/43",
          }),
        },
      },
    })) as unknown as GithubClientFactory;
    const catalog = new AgentCatalogService(db, new GithubAgentCatalogSource(db, factory));

    await expect(
      catalog.proposeUpdate(orgId, projectId, {
        name: "builder",
        source: firstEdit,
        expectedCommitSha: baseCommitSha,
      }),
    ).resolves.toMatchObject({
      branch: "facility/agent-builder",
      commitSha: pullHeadSha,
      pullRequest: { number: 42 },
    });
    expect(calls.some(({ operation }) => operation === "createCommit")).toBe(false);

    calls.length = 0;
    await expect(
      catalog.proposeUpdate(orgId, projectId, {
        name: "builder",
        source: secondEdit,
        expectedCommitSha: baseCommitSha,
      }),
    ).resolves.toMatchObject({
      branch: "facility/agent-builder",
      commitSha: nextCommitSha,
      pullRequest: { number: 42 },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "getCommit",
          args: expect.objectContaining({ commit_sha: pullHeadSha }),
        }),
        expect.objectContaining({
          operation: "createCommit",
          args: expect.objectContaining({ parents: [pullHeadSha] }),
        }),
        expect.objectContaining({
          operation: "updateRef",
          args: expect.objectContaining({
            ref: "heads/facility/agent-builder",
            sha: nextCommitSha,
            force: false,
          }),
        }),
      ]),
    );
    expect(calls.some(({ operation }) => operation === "createPullRequest")).toBe(false);
  });

  it("rejects unsafe agent names before constructing a Git path", async () => {
    const factory = (() => {
      throw new Error("GitHub must not be called");
    }) as unknown as GithubClientFactory;
    const catalog = new AgentCatalogService(db, new GithubAgentCatalogSource(db, factory));

    await expect(
      catalog.proposeUpdate(orgId, projectId, {
        name: "../builder",
        source: source("builder"),
        expectedCommitSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "agent_name_invalid", statusCode: 400 });
  });

  it("keeps maintainer permissions while narrowing installation tokens to project repositories", async () => {
    const calls: Array<{ installationId: number; repositories: string[] }> = [];
    const broker = new GithubWorkspaceCredentialBroker(db, async (request) => {
      calls.push(request);
      return {
        token: "full-installation-token",
        gitIdentity: { name: "my-app[bot]", email: "12345+my-app[bot]@users.noreply.github.com" },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    });
    const issued = await broker.issue(orgId, projectId);
    expect(calls).toEqual([
      {
        installationId: expect.any(Number),
        repositories: [`app-${suffix}`, `shared-${suffix}`],
      },
    ]);
    expect(issued.repositories).toHaveLength(2);
    expect(issued.gitIdentity).toEqual({
      name: "my-app[bot]",
      email: "12345+my-app[bot]@users.noreply.github.com",
    });
    const serializedCredentials = issued.environment.FACILITY_GITHUB_CREDENTIALS;
    if (!serializedCredentials) throw new Error("expected serialized GitHub credentials");
    expect(JSON.parse(serializedCredentials)).toEqual({
      [`acme/app-${suffix}`]: "full-installation-token",
      [`acme/shared-${suffix}`]: "full-installation-token",
    });
    expect(issued.environment).toMatchObject({
      GH_TOKEN: "full-installation-token",
      GIT_CONFIG_VALUE_0: "!facility-git-credential",
    });
  });

  it("credential helper releases only the token for the requested configured repository", () => {
    const helper = fileURLToPath(
      new URL("../../../runner/facility-git-credential.mjs", import.meta.url),
    );
    const credentials = JSON.stringify({ "acme/app": "app-token" });
    const allowed = spawnSync(process.execPath, [helper], {
      input: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
      encoding: "utf8",
      env: { ...process.env, FACILITY_GITHUB_CREDENTIALS: credentials },
    });
    expect(allowed).toMatchObject({
      status: 0,
      stdout: "username=x-access-token\npassword=app-token\n\n",
    });

    const denied = spawnSync(process.execPath, [helper], {
      input: "protocol=https\nhost=github.com\npath=another/repo.git\n\n",
      encoding: "utf8",
      env: { ...process.env, FACILITY_GITHUB_CREDENTIALS: credentials },
    });
    expect(denied).toMatchObject({ status: 0, stdout: "" });
  });

  it("does not issue workspace credentials when the App identity lookup fails", async () => {
    const broker = new GithubWorkspaceCredentialBroker(db, async () => {
      throw new Error("GitHub App bot identity could not be verified");
    });
    await expect(broker.issue(orgId, projectId)).rejects.toThrow("could not be verified");
  });
});
