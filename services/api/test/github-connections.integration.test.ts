import { createHmac, generateKeyPairSync } from "node:crypto";
import { generateApiKey, newId, open, seal } from "@facility/core";
import {
  apiKeys,
  auditEvents,
  createDb,
  githubConnections,
  githubInstallations,
  githubPullRequests,
  githubWebhookEvents,
  migrate,
  orgs,
  projectRepositories,
  projects,
  seed,
  stories,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCatalogService } from "../src/agents/catalog.js";
import { GithubAgentTriggerService } from "../src/agents/github-triggers.js";
import { buildApp } from "../src/app.js";
import {
  createGithubClientFactory,
  createGithubMaintainerTokenFactory,
} from "../src/github/client.js";
import { installationConfig } from "../src/github/connections.js";
import { GithubMirrorService } from "../src/github/mirror.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import type { StoryWorkspaceService } from "../src/stories/service.js";
import type { AppConfig } from "../src/types.js";
import type { ProjectManifestSource } from "../src/workspaces/project-environment.js";

const fake = vi.hoisted(() => ({
  installations: new Map<number, { appId: number; owner: string }>(),
  calls: [] as Array<{
    appId: number;
    installationId: number;
    repositories?: unknown;
    repositoryIds?: unknown;
    permissions?: unknown;
  }>,
  revoked: new Set<number>(),
  invalidKeys: new Set<string>(),
  excludedRepositories: new Set<string>(),
  beforeApp: undefined as undefined | ((appId: number, privateKey: string) => Promise<void>),
}));
vi.mock("@octokit/app", () => ({
  App: class {
    id: number;
    key: string;
    constructor(options: { appId: string | number; privateKey: string }) {
      this.id = Number(options.appId);
      this.key = options.privateKey;
    }
    octokit = {
      request: async (route: string, args: Record<string, unknown> = {}) => {
        if (route === "GET /app") {
          await fake.beforeApp?.(this.id, this.key);
          if (fake.invalidKeys.has(this.key))
            throw new Error("invalid app key with sensitive context");
          return { data: { id: this.id, slug: `app-${this.id}` } };
        }
        if (route === "GET /repos/{owner}/{repo}/installation") {
          if (fake.excludedRepositories.has(`${this.id}/${args.repo}`))
            throw new Error("not installed");
          const entry = [...fake.installations.entries()].find(
            ([, row]) => row.appId === this.id && row.owner === args.owner,
          );
          if (!entry) throw new Error("not installed");
          return { data: { id: entry[0] } };
        }
        const id = Number(args.installation_id);
        const entry = fake.installations.get(id);
        if (!entry || entry.appId !== this.id || fake.revoked.has(id))
          throw new Error("provider rejection with sensitive context");
        if (route.includes("access_tokens")) {
          fake.calls.push({
            appId: this.id,
            installationId: id,
            repositories: args.repositories,
            repositoryIds: args.repository_ids,
            permissions: args.permissions,
          });
          return { data: { token: `token-${this.id}`, expires_at: "2099-01-01T00:00:00Z" } };
        }
        return {
          data: {
            id,
            app_id: this.id,
            account: { id: id + 1, login: entry.owner },
            target_type: "Organization",
            permissions: { contents: "write", issues: "write" },
          },
        };
      },
    };
    async getInstallationOctokit(id: number) {
      const entry = fake.installations.get(id);
      if (!entry || entry.appId !== this.id || fake.revoked.has(id))
        throw new Error("revoked installation");
      fake.calls.push({ appId: this.id, installationId: id });
      return {
        request: async () => ({
          data: {
            repositories: [
              {
                name: "nau",
                owner: { login: entry.owner },
                full_name: `${entry.owner}/nau`,
                default_branch: "dev",
                private: true,
              },
            ],
          },
        }),
        rest: {
          repos: {
            get: async ({ repo }: { repo: string }) => ({
              data: {
                id: repo === "unrelated" ? 987 : 123,
                name: repo,
                owner: { login: entry.owner },
                default_branch: "dev",
              },
            }),
          },
        },
      };
    }
  },
}));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      git: {},
      pulls: {},
      repos: {
        get: async ({ owner, repo }: { owner: string; repo: string }) => ({
          data: { id: 123, name: repo, owner: { login: owner } },
        }),
      },
    };
    async request(_route: string, args: { username: string }) {
      return { data: { id: 42, login: args.username, type: "Bot" } };
    }
  },
}));

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const key = Buffer.alloc(32, 29).toString("base64");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const webhookSecret = "new-app-webhook-secret-".repeat(3);
const otherSecret = "second-app-webhook-secret-".repeat(3);
const legacySecret = "legacy-webhook-secret";
const base = 20_000_000 + Math.floor(Math.random() * 1_000_000);
const legacyOwner = `legacy-${base}`;
const newOwner = `new-${base}`;
const relatedOwner = `related-${base}`;
const config: AppConfig = {
  databaseUrl,
  secretMasterKey: key,
  publicUrl: "http://localhost:4400",
  port: 4400,
  workspaceImage: "runner:test",
  workspaceDriver: "docker",
  facilityInsecureDev: true,
  logLevel: "silent",
  githubAppId: String(base),
  githubAppPrivateKey: privateKey,
  githubAppWebhookSecret: legacySecret,
};

describe("multiple GitHub Apps: authenticated API, worker credentials and signed webhooks", () => {
  const { db, client } = createDb(databaseUrl);
  const projectId = newId("proj");
  const repoId = newId("repo");
  const storyId = newId("story");
  const otherOrg = newId("org");
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";
  let expired = "";
  const tokens: Record<string, string> = {};
  let connectionId = "";
  let secondConnection = "";
  const queued: unknown[] = [];
  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({ id: otherOrg, name: "Other tenant", slug: otherOrg });
    await db
      .insert(projects)
      .values({ id: projectId, orgId: "org_local", name: "Connections", slug: projectId });
    for (const kind of ["viewer", "scoped", "revoked", "other"] as const) {
      const token = await generateApiKey("fak");
      tokens[kind] = token.secret;
      await db.insert(apiKeys).values({
        id: token.id,
        orgId: kind === "other" ? otherOrg : "org_local",
        name: kind,
        prefix: token.lookup,
        last4: token.last4,
        hash: token.hash,
        scopeType: kind === "scoped" ? "project" : "org",
        projectId: kind === "scoped" ? projectId : null,
        roleId: kind === "viewer" ? "role_bundled_viewer" : "role_bundled_owner",
        revokedAt: kind === "revoked" ? new Date() : null,
      });
    }
    fake.installations.set(base, { appId: base, owner: legacyOwner });
    fake.installations.set(base + 1, { appId: base + 1, owner: newOwner });
    fake.installations.set(base + 2, { appId: base + 2, owner: relatedOwner });
    await db.insert(githubInstallations).values({
      id: `ghi_${base}`,
      orgId: "org_local",
      installationId: base,
      accountId: base,
      accountLogin: legacyOwner,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repoId,
      orgId: "org_local",
      projectId,
      installationId: `ghi_${base}`,
      githubRepositoryId: 123,
      owner: legacyOwner,
      name: "nau",
      defaultBranch: "dev",
      role: "primary",
    });
    await db.insert(stories).values({
      id: storyId,
      orgId: "org_local",
      projectId,
      repositoryId: repoId,
      provider: "manual",
      externalId: storyId,
      title: "Retain me",
      createdBy: {},
    });
    app = await buildApp(config, { rateLimitMax: 10000 });
    app.enqueue = async (...args) => {
      queued.push(args);
      return null;
    };
    await app.ready();
    cookie = (await app.inject({ method: "GET", url: "/auth/dev-login" })).cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const session = JSON.parse(
      await open((cookie.split("facility_session=")[1] ?? "").split(";")[0] ?? "", key),
    );
    expired = `facility_session=${await seal(JSON.stringify({ ...session, exp: 1 }), key)}`;
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
  });
  const input = () => ({
    name: "NAU",
    appId: base + 1,
    installationId: base + 1,
    privateKey,
    webhookSecret,
  });
  const auth = () => ({ cookie });

  it("denies anonymous, expired, revoked, viewer and project-scoped administration", async () => {
    for (const headers of [
      {},
      { cookie: expired },
      ...["revoked", "viewer", "scoped"].map((kind) => ({
        authorization: `Bearer ${tokens[kind]}`,
      })),
    ]) {
      const result = await app.inject({
        method: "POST",
        url: "/v1/github/connections",
        headers,
        payload: input(),
      });
      expect([401, 403]).toContain(result.statusCode);
      expect(result.body).not.toContain(privateKey);
    }
  });
  it("verifies installation ownership, encrypts secrets and never returns them", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/v1/github/connections",
      headers: auth(),
      payload: { ...input(), installationId: base + 2 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("sensitive context");
    const result = await app.inject({
      method: "POST",
      url: "/v1/github/connections",
      headers: auth(),
      payload: input(),
    });
    expect(result.statusCode, result.body).toBe(200);
    connectionId = result.json().id;
    expect(result.body).not.toContain(privateKey);
    expect(result.body).not.toContain(webhookSecret);
    expect(result.json().webhookUrl).toContain(`/webhooks/github/${connectionId}`);
    const row = (
      await db.select().from(githubConnections).where(eq(githubConnections.id, connectionId))
    )[0];
    if (!row) throw new Error("Missing connection fixture");
    expect(row.credentials).not.toContain(privateKey);
    expect((await installationConfig(db, config, base + 1)).githubAppId).toBe(String(base + 1));
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/github/connections",
      headers: auth(),
      payload: input(),
    });
    expect(duplicate.statusCode).toBe(409);
    const second = await app.inject({
      method: "POST",
      url: "/v1/github/connections",
      headers: auth(),
      payload: {
        ...input(),
        appId: base + 2,
        installationId: base + 2,
        webhookSecret: otherSecret,
      },
    });
    expect(second.statusCode).toBe(200);
    secondConnection = second.json().id;
    const listed = await app.inject({ url: "/v1/github/connections", headers: auth() });
    expect(listed.body).not.toContain(privateKey);
    expect(listed.body).not.toContain(webhookSecret);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "github.connection.created"));
    expect(JSON.stringify(audit)).not.toContain(webhookSecret);
  });
  it("keeps connection and installation access tenant scoped", async () => {
    const headers = { authorization: `Bearer ${tokens.other}` };
    expect((await app.inject({ url: "/v1/github/connections", headers })).json()).toEqual([]);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/github/connections/${connectionId}`,
          headers,
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/v1/github/installations/${base + 1}/repos`, headers })).statusCode,
    ).toBe(404);
  });
  it("adds only verified installations of the selected App and rejects duplicate or foreign bindings", async () => {
    const url = `/v1/github/connections/${connectionId}/installations`;
    const foreign = await app.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { installationId: base + 2 },
    });
    expect(foreign.statusCode).toBe(400);
    fake.installations.set(base + 3, { appId: base + 1, owner: `extra-${base}` });
    const payload = { installationId: base + 3 };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${tokens.other}` },
          payload,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${tokens.scoped}` },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: auth(), payload })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "POST", url, headers: auth(), payload })).statusCode).toBe(
      409,
    );
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, base + 3))
    )[0];
    expect(installation?.connectionId).toBe(connectionId);
    expect(installation?.orgId).toBe("org_local");
  });

  it("enforces connection tenant scope in PostgreSQL and works without a default App", async () => {
    await expect(
      db.insert(githubInstallations).values({
        id: newId("ghi"),
        orgId: otherOrg,
        connectionId,
        installationId: base + 90,
        accountLogin: "foreign",
        targetType: "Organization",
      }),
    ).rejects.toThrow();
    await expect(
      createGithubClientFactory(
        { ...config, githubAppId: undefined, githubAppPrivateKey: undefined },
        db,
      )(base + 1),
    ).resolves.toBeDefined();
  });

  it("routes clients and repository-scoped tokens through their own App, including legacy", async () => {
    const factory = createGithubClientFactory(config, db);
    for (const number of [base, base + 1, base + 2]) await factory(number);
    expect(fake.calls.slice(-3).map((c) => c.appId)).toEqual([base, base + 1, base + 2]);
    const token = await createGithubMaintainerTokenFactory(
      config,
      db,
    )({
      installationId: base + 1,
      repositories: ["nau"],
      permissions: { contents: "read", checks: "read" },
    });
    expect(token.gitIdentity.name).toBe(`app-${base + 1}[bot]`);
    expect(fake.calls.at(-1)).toEqual({
      appId: base + 1,
      installationId: base + 1,
      repositories: ["nau"],
      permissions: { contents: "read" },
    });
    await expect(factory(base + 100)).rejects.toThrow("unavailable");
    const repos = await app.inject({
      url: `/v1/github/installations/${base + 1}/repos`,
      headers: auth(),
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json().items[0].owner).toBe(newOwner);
  });
  it("rebinds a transferred repository without replacing its retained story references", async () => {
    const url = `/v1/projects/${projectId}/repos/${repoId}`;
    const headers = { ...auth(), "idempotency-key": `rebind-${projectId}` };
    const payload = { installationId: base + 1, owner: newOwner, name: "nau" };
    const result = await app.inject({ method: "PATCH", url, headers, payload });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().id).toBe(repoId);
    expect(result.json().owner).toBe(newOwner);
    expect((await app.inject({ method: "PATCH", url, headers, payload })).json()).toEqual(
      result.json(),
    );
    expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0]?.repositoryId).toBe(
      repoId,
    );
    const rejected = await app.inject({
      method: "PATCH",
      url,
      headers: auth(),
      payload: { ...payload, name: "unrelated" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(
      (await db.select().from(projectRepositories).where(eq(projectRepositories.id, repoId)))[0]
        ?.name,
    ).toBe("nau");
  });
  it("refuses legacy identity guesses and public repositories outside the selected installation", async () => {
    const url = `/v1/projects/${projectId}/repos/${repoId}`;
    const payload = { installationId: base + 1, owner: newOwner, name: "nau" };
    await db
      .update(projectRepositories)
      .set({ githubRepositoryId: null })
      .where(eq(projectRepositories.id, repoId));
    const legacy = await app.inject({ method: "PATCH", url, headers: auth(), payload });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().error.code).toBe("repository_identity_required");
    await db
      .update(projectRepositories)
      .set({ githubRepositoryId: 123 })
      .where(eq(projectRepositories.id, repoId));
    fake.excludedRepositories.add(`${base + 1}/nau`);
    try {
      const excluded = await app.inject({ method: "PATCH", url, headers: auth(), payload });
      expect(excluded.statusCode).toBe(409);
    } finally {
      fake.excludedRepositories.delete(`${base + 1}/nau`);
    }
  });
  it("issues separate repository-limited credentials for a project spanning two Apps", async () => {
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, base + 2))
    )[0];
    if (!installation) throw new Error("Missing second installation");
    const relatedId = newId("repo");
    await db.insert(projectRepositories).values({
      id: relatedId,
      orgId: "org_local",
      projectId,
      installationId: installation.id,
      owner: relatedOwner,
      name: "related",
      defaultBranch: "main",
      role: "related",
    });
    const broker = new GithubWorkspaceCredentialBroker(
      db,
      createGithubMaintainerTokenFactory(config, db),
    );
    const result = await broker.issue("org_local", projectId);
    expect(JSON.parse(result.environment.FACILITY_GITHUB_CREDENTIALS ?? "{}")).toEqual({
      [`${newOwner}/nau`]: `token-${base + 1}`,
      [`${relatedOwner}/related`]: `token-${base + 2}`,
    });
    expect(result.repositories.map((repo) => repo.gitIdentity?.name)).toEqual([
      `app-${base + 1}[bot]`,
      `app-${base + 2}[bot]`,
    ]);
    expect(
      fake.calls
        .slice(-2)
        .map((call) => ({ appId: call.appId, scope: call.repositoryIds ?? call.repositories }))
        .sort((a, b) => a.appId - b.appId),
    ).toEqual([
      { appId: base + 1, scope: [123] },
      { appId: base + 2, scope: ["related"] },
    ]);
    await db.delete(projectRepositories).where(eq(projectRepositories.id, relatedId));
  });

  async function webhook(
    connection: string | null,
    number: number,
    secret: string,
    delivery = crypto.randomUUID(),
    repositoryId = 123,
  ) {
    const payload = JSON.stringify({
      action: "opened",
      installation: { id: number },
      repository: { id: repositoryId, name: "nau", owner: { login: newOwner } },
      issue: { number: 1 },
    });
    return app.inject({
      method: "POST",
      url: `/webhooks/github${connection ? `/${connection}` : ""}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
      },
      payload,
    });
  }
  it("rejects cross-App signatures and signed installation substitution, and deduplicates replay", async () => {
    const initial = queued.length;
    expect((await webhook(connectionId, base + 1, otherSecret)).statusCode).toBe(401);
    expect((await webhook(connectionId, base + 2, webhookSecret)).statusCode).toBe(202);
    expect((await webhook(null, base + 1, legacySecret)).statusCode).toBe(202);
    expect((await webhook(secondConnection, base + 1, otherSecret)).statusCode).toBe(202);
    expect(queued.length).toBe(initial);
    const delivery = crypto.randomUUID();
    expect((await webhook(connectionId, base + 1, webhookSecret, delivery)).statusCode).toBe(202);
    expect((await webhook(connectionId, base + 1, webhookSecret, delivery)).json().replayed).toBe(
      true,
    );
    expect(queued.length).toBe(initial + 1);
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, base + 1))
    )[0];
    if (!installation) throw new Error("Missing installation fixture");
    const events = await db
      .select()
      .from(githubWebhookEvents)
      .where(eq(githubWebhookEvents.installationId, installation.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.repositoryId).toBe(repoId);
    expect((await webhook(null, base, legacySecret)).statusCode).toBe(202);
    // The legacy installation no longer owns this repository after the rebind.
    expect(queued.length).toBe(initial + 1);
  });
  it("rejects a genuine webhook for a replacement repository at the same slug", async () => {
    const before = queued.length;
    expect(
      (await webhook(connectionId, base + 1, webhookSecret, crypto.randomUUID(), 999)).statusCode,
    ).toBe(202);
    expect(queued.length).toBe(before);
  });
  it("checks installation membership on initial connection, including public repositories", async () => {
    const payload = { installationId: base + 1, owner: newOwner, name: "public-excluded" };
    fake.excludedRepositories.add(`${base + 1}/public-excluded`);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/repos`,
        headers: auth(),
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("github_repo_not_found");
      expect(
        (
          await db
            .select()
            .from(projectRepositories)
            .where(eq(projectRepositories.projectId, projectId))
        ).some((row) => row.name === payload.name),
      ).toBe(false);
    } finally {
      fake.excludedRepositories.delete(`${base + 1}/public-excluded`);
    }
  });
  it("uses immutable repository scopes for API clients and rejects unbounded maintainer tokens", async () => {
    await createGithubClientFactory(config, db)(base + 1, 123);
    expect(fake.calls.at(-1)).toMatchObject({ installationId: base + 1, repositoryIds: [123] });
    const factory = createGithubMaintainerTokenFactory(config, db);
    await expect(factory({ installationId: base + 1, repositories: [] })).rejects.toThrow(
      "repository scope",
    );
    await expect(
      factory({ installationId: base + 1, repositories: ["nau"], repositoryIds: [123] }),
    ).rejects.toThrow("repository scope");
  });
  it("runs the real worker only for the currently selected App, including queued receipts across a switch", async () => {
    fake.installations.set(base + 5, { appId: base + 2, owner: newOwner });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/github/connections/${secondConnection}/installations`,
          headers: auth(),
          payload: { installationId: base + 5 },
        })
      ).statusCode,
    ).toBe(200);
    const otherInstallation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, base + 5))
    )[0];
    if (!otherInstallation) throw new Error("Missing overlap installation");
    await db
      .update(stories)
      .set({ pullRequestNumber: 88, branch: "feature/review" })
      .where(eq(stories.id, storyId));
    const markMerged = vi.fn(async () => undefined);
    const mirror = new GithubMirrorService(db, createGithubClientFactory(config, db));
    const worker = new GithubAgentTriggerService(
      db,
      {} as AgentCatalogService,
      { markMerged } as unknown as StoryWorkspaceService,
      {} as ProjectManifestSource,
      "runner:test",
      mirror,
    );
    async function delivery(connection: string, installation: number, secret: string) {
      const id = crypto.randomUUID();
      const payload = JSON.stringify({
        action: "closed",
        installation: { id: installation },
        repository: { id: 123, name: "nau", owner: { login: newOwner } },
        pull_request: {
          number: 88,
          title: "Reviewed change",
          state: "closed",
          merged: true,
          html_url: "https://github.test/pull/88",
          head: { ref: "feature/review", sha: "a".repeat(40) },
          base: { ref: "dev" },
        },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/webhooks/github/${connection}`,
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-github-delivery": id,
              "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
            },
            payload,
          })
        ).statusCode,
      ).toBe(202);
      const receipt = (await db.select().from(githubWebhookEvents)).find((row) =>
        row.id.endsWith(id),
      );
      if (!receipt) throw new Error("Missing receipt");
      return receipt.id;
    }
    const before = queued.length;
    const other = await delivery(secondConnection, base + 5, otherSecret);
    expect(queued.length).toBe(before);
    expect(await worker.handleInbound(other)).toEqual({ matched: 0, queued: 0, merged: 0 });
    expect(markMerged).not.toHaveBeenCalled();
    const stale = await delivery(connectionId, base + 1, webhookSecret);
    expect(queued.length).toBe(before + 1);
    const current = (
      await db.select().from(projectRepositories).where(eq(projectRepositories.id, repoId))
    )[0];
    await db
      .update(projectRepositories)
      .set({ installationId: otherInstallation.id })
      .where(eq(projectRepositories.id, repoId));
    try {
      expect(await worker.handleInbound(stale)).toEqual({ matched: 0, queued: 0, merged: 0 });
      expect(markMerged).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(githubPullRequests)
          .where(eq(githubPullRequests.repositoryId, repoId)),
      ).toHaveLength(0);
      const accepted = await delivery(secondConnection, base + 5, otherSecret);
      expect((await worker.handleInbound(accepted)).merged).toBe(1);
      expect(markMerged).toHaveBeenCalledOnce();
      expect(
        await db
          .select()
          .from(githubPullRequests)
          .where(eq(githubPullRequests.repositoryId, repoId)),
      ).toHaveLength(1);
    } finally {
      await db
        .update(projectRepositories)
        .set({ installationId: current?.installationId })
        .where(eq(projectRepositories.id, repoId));
    }
  });

  it("disables credentials and webhooks without falling back; rotation immediately uses the new secret", async () => {
    const url = `/v1/github/connections/${connectionId}`;
    expect(
      (await app.inject({ method: "PATCH", url, headers: auth(), payload: { disabled: true } }))
        .statusCode,
    ).toBe(200);
    await expect(createGithubClientFactory(config, db)(base + 1)).rejects.toThrow("disabled");
    await expect(
      createGithubMaintainerTokenFactory(
        config,
        db,
      )({ installationId: base + 1, repositories: ["nau"] }),
    ).rejects.toThrow("disabled");
    expect((await webhook(connectionId, base + 1, webhookSecret)).statusCode).toBe(401);
    const rotated = "rotated-webhook-secret-".repeat(3);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: auth(),
          payload: { disabled: false, secrets: { privateKey, webhookSecret: rotated } },
        })
      ).statusCode,
    ).toBe(200);
    expect((await webhook(connectionId, base + 1, webhookSecret)).statusCode).toBe(401);
    expect((await webhook(connectionId, base + 1, rotated)).statusCode).toBe(202);
    fake.invalidKeys.add(privateKey);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: auth(),
          payload: { secrets: { privateKey, webhookSecret: rotated } },
        })
      ).statusCode,
    ).toBe(400);
    fake.invalidKeys.delete(privateKey);
  });
  it("rotates and recovers an App after its old installations have been removed", async () => {
    const url = `/v1/github/connections/${connectionId}`;
    fake.revoked.add(base + 1);
    const secrets = { privateKey, webhookSecret };
    // The second installation remains active; the first one cannot veto App rotation.
    expect(
      (await app.inject({ method: "PATCH", url, headers: auth(), payload: { secrets } }))
        .statusCode,
    ).toBe(200);
    fake.revoked.add(base + 3);
    await app.inject({ method: "PATCH", url, headers: auth(), payload: { disabled: true } });
    expect(
      (await app.inject({ method: "PATCH", url, headers: auth(), payload: { disabled: false } }))
        .statusCode,
    ).toBe(200);
    fake.installations.set(base + 4, { appId: base + 1, owner: `replacement-${base}` });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/installations`,
          headers: auth(),
          payload: { installationId: base + 4 },
        })
      ).statusCode,
    ).toBe(200);
    await expect(createGithubClientFactory(config, db)(base + 1)).rejects.toThrow("revoked");
    fake.revoked.delete(base + 1);
    fake.revoked.delete(base + 3);
  });
  it("does not let a delayed enable overwrite a successful credential rotation", async () => {
    const url = `/v1/github/connections/${connectionId}`;
    await app.inject({ method: "PATCH", url, headers: auth(), payload: { disabled: true } });
    const replacement = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.beforeApp = async (_appId, key) => {
      if (key === privateKey) {
        entered();
        await paused;
      }
    };
    const enable = app.inject({
      method: "PATCH",
      url,
      headers: auth(),
      payload: { disabled: false },
    });
    try {
      await checking;
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers: auth(),
            payload: { secrets: { privateKey: replacement, webhookSecret: otherSecret } },
          })
        ).statusCode,
      ).toBe(200);
      release();
      const result = await enable;
      expect(result.statusCode).toBe(409);
      const row = (
        await db.select().from(githubConnections).where(eq(githubConnections.id, connectionId))
      )[0];
      expect(row?.disabledAt).not.toBeNull();
      const decoded = JSON.parse(await open(row?.credentials ?? "", key));
      expect(decoded.privateKey).toBe(replacement);
      expect(decoded.webhookSecret).toBe(otherSecret);
    } finally {
      release();
      fake.beforeApp = undefined;
      await enable;
    }
  });
});
