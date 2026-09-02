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
              return { data: [{ type: "file", path: ".agents/skills/ignored.md" }] };
            }
            return {
              data: { type: "file", path, encoding: "base64", content: encoded("ignored") },
            };
          },
        },
      },
    })) as unknown as GithubClientFactory;
    const snapshot = await new GithubAgentCatalogSource(db, factory).load(orgId, projectId);
    expect(snapshot).toEqual({
      commitSha: "d".repeat(40),
      sources: [{ file: ".agents/builder.md", source: source("builder") }],
    });
  });

  it("issues one un-narrowed installation token to every configured repository", async () => {
    const calls: number[] = [];
    const broker = new GithubWorkspaceCredentialBroker(db, async ({ installationId: githubId }) => {
      calls.push(githubId);
      return {
        token: "full-installation-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    });
    const issued = await broker.issue(orgId, projectId);
    expect(calls).toHaveLength(1);
    expect(issued.repositories).toHaveLength(2);
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
});
