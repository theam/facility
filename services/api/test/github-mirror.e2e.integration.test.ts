import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubInstallations,
  githubPullRequests,
  migrate,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  head_sha: string;
};

type Scenario = {
  pull: { number: number; title: string; sha: string; ref: string; updatedAt: string };
  statusError: unknown;
  checkRuns: CheckRun[];
};

describe("GitHub mirror sync route", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = "org_local";
  const projectId = newId("proj");
  const otherOrgId = newId("org");
  const otherProjectId = newId("proj");
  const installationRowId = newId("ghi");
  const repositoryId = newId("repo");
  const ownerRole = newId("role");
  const credentials: Record<string, string> = {};
  let scenario: Scenario = {
    pull: {
      number: 0,
      title: "unset",
      sha: "0".repeat(40),
      ref: "unset",
      updatedAt: "2026-09-04T00:00:00Z",
    },
    statusError: { status: 500 },
    checkRuns: [],
  };
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
  const githubFactory: GithubClientFactory = async () => ({
    request: async (route: string) => {
      if (route.endsWith("/branches") || route.endsWith("/issues")) return { data: [] };
      if (route.endsWith("/pulls")) {
        return {
          data: [
            {
              number: scenario.pull.number,
              title: scenario.pull.title,
              state: "open",
              html_url: `https://github.com/acme/app/pull/${scenario.pull.number}`,
              head: { ref: scenario.pull.ref, sha: scenario.pull.sha },
              base: { ref: "main" },
              updated_at: scenario.pull.updatedAt,
            },
          ],
        };
      }
      if (route.endsWith("/status")) throw scenario.statusError;
      if (route.endsWith("/check-runs")) return { data: { check_runs: scenario.checkRuns } };
      throw new Error(`unexpected GitHub route ${route}`);
    },
    rest: {} as Octokit["rest"],
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function key(name: string, selectedProject: string, roleId: string, tenant = orgId) {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId: tenant,
      name,
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: "project",
      projectId: selectedProject,
      roleId,
    });
    credentials[name] = generated.secret;
  }

  function sync(name?: string) {
    return app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/github/sync`,
      headers: {
        ...(name ? { authorization: `Bearer ${credentials[name]}` } : {}),
        "idempotency-key": randomUUID(),
      },
    });
  }

  async function savedPull(number: number) {
    const [pull] = await db
      .select()
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.repositoryId, repositoryId),
          eq(githubPullRequests.number, number),
        ),
      );
    return pull;
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Mirror route",
      slug: `mirror-route-${suffix}`,
      settings: {},
    });
    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Other tenant",
      slug: `mirror-other-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: otherOrgId,
      name: "Other",
      slug: `mirror-other-proj-${suffix}`,
      settings: {},
    });
    await db.insert(roles).values({
      id: ownerRole,
      orgId: otherOrgId,
      name: "owner",
      permissions: ["*"],
    });
    await db.insert(githubInstallations).values({
      id: installationRowId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 500_000,
      accountId: 1,
      accountLogin: "acme",
      targetType: "Organization",
    });
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
    await key("owner", projectId, "role_bundled_owner");
    await key("viewer", projectId, "role_bundled_viewer");
    await key("other", otherProjectId, ownerRole, otherOrgId);
    app = await buildApp(config, {
      rateLimitMax: 10_000,
      storyDomain: createStoryDomain({
        db,
        config,
        runtime: new FakeWorkspaceRuntime(),
        enqueue: async () => undefined,
        githubFactory,
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  it("rejects an anonymous or read-only sync and hides the project from another tenant", async () => {
    expect((await sync()).statusCode).toBe(401);
    expect((await sync("viewer")).statusCode).toBe(403);
    expect((await sync("other")).statusCode).toBe(404);
  });

  it("does not record success when the sync route cannot read commit statuses", async () => {
    const sha = "d".repeat(40);
    scenario = {
      pull: {
        number: 51,
        title: "Unreadable statuses",
        sha,
        ref: "facility/unreadable-success",
        updatedAt: "2026-09-04T12:00:00Z",
      },
      statusError: { status: 403 },
      checkRuns: [
        { id: 5101, name: "verify", status: "completed", conclusion: "success", head_sha: sha },
      ],
    };

    const response = await sync("owner");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pullRequests: 1, ciUpdates: 0 });
    const pull = await savedPull(51);
    expect(pull?.ciState).toBeNull();
    expect(pull?.ciHeadSha).toBe(sha);
  });

  it("reports a failing check run through the sync route when statuses are unreadable", async () => {
    const sha = "e".repeat(40);
    scenario = {
      pull: {
        number: 52,
        title: "Unreadable statuses with a failure",
        sha,
        ref: "facility/unreadable-failure",
        updatedAt: "2026-09-04T13:00:00Z",
      },
      statusError: { status: 403 },
      checkRuns: [
        { id: 5201, name: "verify", status: "completed", conclusion: "failure", head_sha: sha },
      ],
    };

    const response = await sync("owner");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pullRequests: 1, ciUpdates: 1 });
    const pull = await savedPull(52);
    expect(pull?.ciState).toBe("failure");
    expect(pull?.ciFailureNames).toEqual(["verify"]);
  });

  it("keeps an in-progress check pending through the sync route", async () => {
    const sha = "1".repeat(40);
    scenario = {
      pull: {
        number: 53,
        title: "Unreadable statuses with a running check",
        sha,
        ref: "facility/unreadable-pending",
        updatedAt: "2026-09-04T15:00:00Z",
      },
      statusError: { status: 403 },
      checkRuns: [{ id: 5301, name: "verify", status: "in_progress", head_sha: sha }],
    };

    const response = await sync("owner");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pullRequests: 1, ciUpdates: 1 });
    const pull = await savedPull(53);
    expect(pull?.ciState).toBe("pending");
    expect(pull?.ciHeadSha).toBe(sha);
  });

  it("fails the sync route when the statuses 403 is a rate limit", async () => {
    const sha = "f".repeat(40);
    scenario = {
      pull: {
        number: 54,
        title: "Rate limited statuses",
        sha,
        ref: "facility/rate-limit",
        updatedAt: "2026-09-04T14:00:00Z",
      },
      statusError: {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      },
      checkRuns: [
        { id: 5401, name: "verify", status: "completed", conclusion: "success", head_sha: sha },
      ],
    };

    const response = await sync("owner");
    expect(response.statusCode).toBe(500);
    const pull = await savedPull(54);
    expect(pull?.ciState ?? null).toBeNull();
  });

  it("fails the sync route when commit statuses fail for another reason", async () => {
    const sha = "c".repeat(40);
    scenario = {
      pull: {
        number: 55,
        title: "Status upstream failed",
        sha,
        ref: "facility/status-error",
        updatedAt: "2026-09-04T16:00:00Z",
      },
      statusError: Object.assign(new Error("status upstream failed"), { status: 500 }),
      checkRuns: [],
    };

    const response = await sync("owner");
    expect(response.statusCode).toBe(500);
    const pull = await savedPull(55);
    expect(pull?.ciState ?? null).toBeNull();
  });
});
