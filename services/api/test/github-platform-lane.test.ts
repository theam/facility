import { generateApiKey, hashKey, newId } from "@facility/core";
import {
  agentDefs,
  apiKeys,
  createDb,
  ghIssues,
  githubInstallations,
  migrate,
  orgs,
  outcomes,
  platformIssues,
  projects,
  registryItems,
  repos,
  runEvents,
  runs,
  seed,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { upsertGhIssueFromWebhook } from "../src/github/issues-sync.js";
import { finishRun } from "../src/sandbox/orchestrator.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const masterKey = Buffer.alloc(32, 10).toString("base64");

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("github platform lane", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; GitHub platform lane tests skipped", () =>
      undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4407,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let orgId = "";
  let projectId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `gh-platform-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "GitHub Platform Lane",
          slug: `gh-platform-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = project?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("upserts mirrored issues from webhooks with cross-org isolation", async () => {
    const owner = `mirror-${Date.now()}`;
    const name = "repo";
    const otherOrgId = newId("org");
    await db.insert(orgs).values({ id: otherOrgId, name: "Other", slug: `other-${Date.now()}` });
    const otherProjectId = newId("proj");
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: otherOrgId,
      name: "Other Project",
      slug: `other-${Date.now()}`,
      settings: {},
    });
    const repo = await insertRepo({ owner, name });
    const otherRepo = await insertRepo({
      orgId: otherOrgId,
      projectId: otherProjectId,
      owner,
      name,
    });

    await upsertGhIssueFromWebhook(db, orgId, {
      action: "opened",
      repository: { owner: { login: owner }, name },
      issue: {
        number: 7,
        title: "Mirror me",
        state: "open",
        user: { login: "ada" },
        labels: [{ name: "bug" }],
        assignees: [{ login: "grace" }],
        html_url: `https://github.com/${owner}/${name}/issues/7`,
        body: "body",
        comments: 2,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    });

    const rows = await db.select().from(ghIssues).where(eq(ghIssues.repoId, repo.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.labels).toEqual(["bug"]);
    const otherRows = await db.select().from(ghIssues).where(eq(ghIssues.repoId, otherRepo.id));
    expect(otherRows).toHaveLength(0);
  });

  it("lists mirrored issues with pagination, state filtering, and linked runs", async () => {
    const repo = await insertRepo({ owner: `list-${Date.now()}`, name: "repo" });
    await insertIssue(repo.id, 1, "open", "2026-02-01T00:00:00Z");
    await insertIssue(repo.id, 2, "open", "2026-02-02T00:00:00Z");
    await insertIssue(repo.id, 3, "closed", "2026-02-03T00:00:00Z");
    const run = await insertRun({ gh: { owner: repo.owner, repo: repo.name, issueNumber: 2 } });

    const first = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues?state=open&limit=1`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items[0].number).toBe(2);
    expect(first.json().items[0].linkedRuns[0].id).toBe(run.id);
    expect(first.json().nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues?state=open&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].number).toBe(1);

    const closed = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues?state=closed`,
      headers: { cookie },
    });
    expect(closed.json().items.map((item: { number: number }) => item.number)).toContain(3);
  });

  it("directly triggers an agent run for a mirrored issue", async () => {
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    app.enqueue = async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    };
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            createComment: async () => ({ data: { id: 1, html_url: "https://example.test/c" } }),
          },
          repos: {},
          git: {},
          pulls: {},
        },
      }) as never;
    const repo = await insertRepoWithInstallation(`trigger-${Date.now()}`);
    await insertIssue(repo.id, 44, "open", "2026-03-01T00:00:00Z");
    await insertAgent("builder");

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/44/trigger`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().gh.issueNumber).toBe(44);
    const event = (
      await db.select().from(runEvents).where(eq(runEvents.runId, response.json().id))
    )[0];
    expect(event?.seq).toBe(1);
    expect(event?.type).toBe("queued");
    expect(enqueued).toContainEqual({
      queue: "runs.dispatch",
      data: { runId: response.json().id, orgId },
    });

    const missing = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/404/trigger`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(missing.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/44/trigger`,
      headers: { cookie },
      payload: { agent: "missing" },
    });
    expect(unknown.statusCode).toBe(400);

    const viewer = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: viewer.id,
      orgId,
      name: "viewer",
      prefix: viewer.lookup,
      last4: viewer.last4,
      hash: viewer.hash,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_viewer",
    });
    const denied = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/44/trigger`,
      headers: { authorization: `Bearer ${viewer.secret}` },
      payload: { agent: "builder" },
    });
    expect(denied.statusCode).toBe(403);
    app.githubClientFactory = undefined;
  });

  it("pins project-scoped keys to their project across the issue mirror (404 elsewhere)", async () => {
    // A key pinned to ANOTHER project — with full engineer permissions — must
    // not read this project's issues nor trigger runs in it.
    const otherProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Other Scope",
          slug: `gh-scope-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    const pinned = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: pinned.id,
      orgId,
      name: "pinned-elsewhere",
      prefix: pinned.lookup,
      last4: pinned.last4,
      hash: pinned.hash,
      scopeType: "project",
      projectId: otherProject?.id ?? "",
      // Maintainer carries every permission these routes gate on (runs:read,
      // runs:trigger, repos:write) — so a 404 can only come from the scope clamp.
      roleId: "role_bundled_maintainer",
    });
    const auth = { authorization: `Bearer ${pinned.secret}` };
    const list = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues`,
      headers: auth,
    });
    expect(list.statusCode).toBe(404);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues/44`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(404);
    const trigger = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/44/trigger`,
      headers: auth,
      payload: { agent: "builder" },
    });
    expect(trigger.statusCode).toBe(404);
    const sync = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/sync`,
      headers: auth,
    });
    expect(sync.statusCode).toBe(404);
  });

  it("lists installations and installation repositories with org isolation", async () => {
    const installation = await insertInstallation(`inst-${Date.now()}`);
    const otherOrgId = newId("org");
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Other Inst", slug: `inst-${Date.now()}` });
    const otherInstallationId = 9_999_000 + Math.floor(Math.random() * 1000);
    await db.insert(githubInstallations).values({
      id: newId("int"),
      orgId: otherOrgId,
      installationId: otherInstallationId,
      accountLogin: "other",
      targetType: "Organization",
    });
    app.githubClientFactory = async () =>
      ({
        request: async () => ({
          data: {
            repositories: [
              {
                name: "repo",
                full_name: `${installation.accountLogin}/repo`,
                private: true,
                default_branch: "main",
                html_url: "https://github.com/o/repo",
                owner: { login: installation.accountLogin },
              },
            ],
          },
        }),
        rest: { issues: {}, repos: {}, git: {}, pulls: {} },
      }) as never;

    const list = await app.inject({
      method: "GET",
      url: "/v1/github/installations",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((row: { id: string }) => row.id === installation.id)).toBe(true);

    const reposResponse = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${installation.installationId}/repos?query=repo`,
      headers: { cookie },
    });
    expect(reposResponse.statusCode).toBe(200);
    expect(reposResponse.json().items[0].fullName).toBe(`${installation.accountLogin}/repo`);

    const cross = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${otherInstallationId}/repos`,
      headers: { cookie },
    });
    expect(cross.statusCode).toBe(404);

    // A project-pinned key must NOT enumerate the org's whole installation repo
    // inventory (cross-project info leak) — even a maintainer key with
    // projects:kickstart. Kickstart creates org-level projects, so discovery is
    // an org operation, refused to project principals (404, not an oracle).
    const pinned = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: pinned.id,
      orgId,
      name: "pinned-kickstart",
      prefix: pinned.lookup,
      last4: pinned.last4,
      hash: pinned.hash,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_maintainer",
    });
    const pinnedAuth = { authorization: `Bearer ${pinned.secret}` };
    const pinnedList = await app.inject({
      method: "GET",
      url: "/v1/github/installations",
      headers: pinnedAuth,
    });
    expect(pinnedList.statusCode).toBe(404);
    const pinnedRepos = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${installation.installationId}/repos`,
      headers: pinnedAuth,
    });
    expect(pinnedRepos.statusCode).toBe(404);
    app.githubClientFactory = undefined;
  });

  it("guards push-token issuance", async () => {
    const token = "frt_push";
    const repo = await insertRepo({ owner: `push-${Date.now()}`, name: "repo" });
    const run = await insertRun({
      status: "running",
      sandbox: {
        runnerTokenHash: await hashKey(token),
        bundle: {
          repo: {
            cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
            branch: "main",
            installationTokenRef: null,
          },
        },
      },
    });
    const wrong = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/push-token`,
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.statusCode).toBe(401);

    const noInstallation = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/push-token`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(noInstallation.statusCode).toBe(409);
    expect(noInstallation.json().error.code).toBe("no_installation");

    await db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, run.id));
    const terminal = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/push-token`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(terminal.statusCode).toBe(409);
  });

  it("finishRun opens a PR and records the producing outcome", async () => {
    const repo = await insertRepoWithInstallation(`finish-${Date.now()}`);
    const run = await insertRun({
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 55 },
    });
    const finished = await finishRun(
      db,
      run,
      { status: "succeeded", git: { changed: true, branch: "facility/run-12345678" } },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async () => ({
                  data: { number: 12, html_url: "https://github.com/o/r/pull/12" },
                }),
              },
              issues: {
                createComment: async () => ({ data: { id: 1 } }),
              },
              repos: {},
              git: {},
            },
          }) as never,
      },
    );
    expect(finished.status).toBe("succeeded");
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect((stored?.gh as { pr?: { number?: number } }).pr?.number).toBe(12);
    const [outcome] = await db.select().from(outcomes).where(eq(outcomes.runId, run.id));
    expect(outcome?.prNumber).toBe(12);
  });

  it("finishRun PR failures leave the run succeeded and raise an artifact issue", async () => {
    const repo = await insertRepoWithInstallation(`finish-fail-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(
      db,
      run,
      { status: "succeeded", git: { changed: true, branch: "facility/run-deadbeef" } },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async () => {
                  throw new Error("github down");
                },
              },
              issues: {},
              repos: {},
              git: {},
            },
          }) as never,
      },
    );
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(stored?.status).toBe("succeeded");
    const [artifact] = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "artifact_error")));
    expect(artifact?.data).toMatchObject({ kind: "pr_open_failed" });
    const [issue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, `pr_open_failed:${run.id}`));
    expect(issue?.state).toBe("open");
  });

  async function insertInstallation(owner: string) {
    const row = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!row) throw new Error("installation insert failed");
    return row;
  }

  async function insertRepo(input: {
    orgId?: string;
    projectId?: string;
    owner: string;
    name: string;
    installationId?: string | null;
  }) {
    const row = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId: input.orgId ?? orgId,
          projectId: input.projectId ?? projectId,
          installationId: input.installationId,
          owner: input.owner,
          name: input.name,
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!row) throw new Error("repo insert failed");
    return row;
  }

  async function insertRepoWithInstallation(owner: string) {
    const installation = await insertInstallation(owner);
    return insertRepo({ owner, name: "repo", installationId: installation.id });
  }

  async function insertIssue(repoId: string, number: number, state: string, updatedAt: string) {
    await db.insert(ghIssues).values({
      id: newId("ghi"),
      orgId,
      projectId,
      repoId,
      number,
      title: `Issue ${number}`,
      state,
      labels: [],
      assignees: [],
      htmlUrl: `https://github.com/o/r/issues/${number}`,
      ghUpdatedAt: new Date(updatedAt),
    });
  }

  async function insertAgent(name: string) {
    const item = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `contract-${name}-${Date.now()}`,
          latestVersion: 1,
        })
        .returning()
    )[0];
    if (!item) throw new Error("registry item insert failed");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name,
          engine: "codex",
          model: { primary: "gpt-5.5" },
          contractItemId: item.id,
          triggers: [{ command: name }],
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent insert failed");
    return agent;
  }

  async function insertRun(
    input: {
      status?: string;
      gh?: Record<string, unknown>;
      sandbox?: Record<string, unknown>;
    } = {},
  ) {
    const row = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "codex",
          status: input.status ?? "queued",
          trigger: {},
          sandbox: input.sandbox ?? {},
          gh: input.gh ?? {},
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!row) throw new Error("run insert failed");
    return row;
  }
});
