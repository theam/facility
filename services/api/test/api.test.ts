import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { hashKey, newId, seal } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  auditEvents,
  budgets,
  conversationMessages,
  conversations,
  createDb,
  githubInstallations,
  inboundEvents,
  insertAuditEvent,
  integrations,
  llmRequests,
  migrate,
  orgMembers,
  orgs,
  platformIssues,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  providerCredentials,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runs,
  sandboxProfiles,
  seed,
  steerMessages,
  users,
  verifyAuditChain,
} from "@facility/db";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { ensureWorkosUser } from "../src/routes/auth.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 9).toString("base64");

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

function sourceFilesContaining(root: URL, text: string): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, root);
    if (entry.isDirectory()) {
      matches.push(...sourceFilesContaining(child, text));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const content = readFileSync(child, "utf8");
      if (content.includes(text)) matches.push(child.pathname);
    }
  }
  return matches;
}

// A stand-in GitHub App factory so task_creation executions can be exercised
// end-to-end without a real installation. Production has no such factory unless
// GitHub is configured, so unconfigured deployments still fail closed.
function fakeGithubFactory(): GithubClientFactory {
  const octokit = {
    rest: {
      issues: {
        create: async () => ({
          data: { number: 1, html_url: "https://github.com/facility/repo/issues/1" },
        }),
      },
    },
  };
  return (async () => octokit) as unknown as GithubClientFactory;
}

describe("api", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; API integration tests skipped", () =>
      undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4400,
    publicUrl: "http://localhost:4400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let approverCookie = "";
  let orgId = "";
  const ownerRole = "role_bundled_owner";
  const viewerRole = "role_bundled_viewer";
  let projectId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `api-${Date.now()}@example.com` },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    const approverLogin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `api-approver-${Date.now()}@example.com` },
    });
    expect(approverLogin.statusCode).toBe(200);
    approverCookie = approverLogin.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    await db.delete(auditEvents).where(eq(auditEvents.orgId, orgId));
    const setupProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "API Setup Project",
          slug: `api-setup-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = setupProject?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  async function createProjectWithAgent(name: string) {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name, slug: `${name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}` },
    });
    expect(project.statusCode).toBe(200);
    const agent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, project.json().id)).limit(1)
    )[0];
    expect(agent).toBeTruthy();
    if (!agent) throw new Error("agent fixture missing");
    return { projectId: project.json().id as string, agent };
  }

  it("dev-login resolves /v1/me", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().org.slug).toBe("the-agile-monkeys");
  });

  it("bootstraps the first WorkOS user as owner when no orgs exist", async () => {
    const rollback = new Error("rollback bootstrap test");
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`TRUNCATE TABLE orgs, users, roles CASCADE`);
        await tx.insert(roles).values({
          id: "role_bundled_owner",
          orgId: null,
          name: "owner",
          description: "Full organization control.",
          permissions: ["*"],
        });

        const session = await ensureWorkosUser(
          tx as unknown as Parameters<typeof ensureWorkosUser>[0],
          {
            workosUserId: "workos_first_admin",
            email: "first@theagilemonkeys.com",
            name: "First Admin",
          },
        );

        const membership = (
          await tx
            .select({ org: orgs, member: orgMembers, role: roles, user: users })
            .from(orgMembers)
            .innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
            .innerJoin(roles, eq(orgMembers.roleId, roles.id))
            .innerJoin(users, eq(orgMembers.userId, users.id))
            .where(eq(orgMembers.userId, session.userId))
            .limit(1)
        )[0];
        expect(membership?.org.slug).toBe("theagilemonkeys");
        expect(membership?.role.name).toBe("owner");
        expect(membership?.user.workosUserId).toBe("workos_first_admin");
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);
  });

  it("requires WorkOS users to be invited or admitted by org email domain", async () => {
    const rollback = new Error("rollback workos admission test");
    await expect(
      db.transaction(async (tx) => {
        await expect(
          ensureWorkosUser(
            tx as unknown as Parameters<typeof ensureWorkosUser>[0],
            {
              workosUserId: `workos_uninvited_${Date.now()}`,
              email: `uninvited-${Date.now()}@blocked.example`,
              name: "Uninvited",
            },
            { autoJoin: false },
          ),
        ).rejects.toMatchObject({ statusCode: 403, code: "not_invited" });

        await tx
          .update(orgs)
          .set({ settings: { allowedDomains: ["allowed.example"] }, updatedAt: new Date() })
          .where(eq(orgs.id, orgId));
        const admitted = await ensureWorkosUser(
          tx as unknown as Parameters<typeof ensureWorkosUser>[0],
          {
            workosUserId: `workos_allowed_${Date.now()}`,
            email: `allowed-${Date.now()}@allowed.example`,
            name: "Allowed",
          },
          { autoJoin: false },
        );
        expect(admitted.orgId).toBe(orgId);
        const membership = (
          await tx
            .select({ member: orgMembers, role: roles })
            .from(orgMembers)
            .innerJoin(roles, eq(orgMembers.roleId, roles.id))
            .where(eq(orgMembers.userId, admitted.userId))
            .limit(1)
        )[0];
        expect(membership?.role.name).toBe("viewer");
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);
  });

  it("denies viewer key project mutation with needed permission", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "viewer", roleId: viewerRole },
    });
    const secret = issued.json().secret;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
      payload: { name: "Denied", slug: `denied-${Date.now()}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.needed).toBe("projects:write");
  });

  it("issues, uses, and revokes an API key", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "owner", roleId: ownerRole },
    });
    expect(issued.json().secret).toMatch(/^fak_/);
    const secret = issued.json().secret;
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(me.statusCode).toBe(200);
    await app.inject({
      method: "DELETE",
      url: `/v1/keys/${issued.json().id}`,
      headers: { cookie },
    });
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("performs project CRUD", async () => {
    const slug = `project-${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Project", slug },
    });
    expect(created.statusCode).toBe(200);
    projectId = created.json().id;
    const listed = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } });
    expect(listed.json().some((row: { id: string }) => row.id === projectId)).toBe(true);
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { cookie },
      payload: { description: "updated" },
    });
    expect(patched.json().description).toBe("updated");
  });

  it("publishes registry drafts and keeps active content immutable", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: { scope: "org", kind: "skill", name: `skill-${Date.now()}`, content: "v1" },
    });
    const version = created.json().versions[0];
    const published = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${version.id}/publish`,
      headers: { cookie },
    });
    expect(published.statusCode).toBe(200);
    const republish = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${version.id}/publish`,
      headers: { cookie },
    });
    expect(republish.statusCode).toBe(400);
    const row = (
      await db.select().from(registryVersions).where(eq(registryVersions.id, version.id)).limit(1)
    )[0];
    expect(row?.content).toBe("v1");
  });

  it("publishing a new version deprecates the prior active version of the item", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: { scope: "org", kind: "skill", name: `supersede-${Date.now()}`, content: "v1" },
    });
    const itemId = created.json().id;
    const v1 = created.json().versions[0];
    await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${v1.id}/publish`,
      headers: { cookie },
    });
    const v2 = (
      await app.inject({
        method: "POST",
        url: `/v1/registry/items/${itemId}/versions`,
        headers: { cookie },
        payload: { content: "v2" },
      })
    ).json();
    const pub2 = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${v2.id}/publish`,
      headers: { cookie },
    });
    expect(pub2.statusCode).toBe(200);
    // The item now has exactly one active version (v2); v1 was superseded.
    const [v1row] = await db.select().from(registryVersions).where(eq(registryVersions.id, v1.id));
    const [v2row] = await db.select().from(registryVersions).where(eq(registryVersions.id, v2.id));
    expect(v1row?.status).toBe("deprecated");
    expect(v2row?.status).toBe("active");
  });

  it("rejects unsafe BYO provider base URLs on write", async () => {
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: {
        provider: "anthropic",
        name: `metadata-${Date.now()}`,
        baseUrl: "https://169.254.169.254/latest/meta-data",
        secret: "secret",
      },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("invalid_provider_base_url");

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: {
        provider: "openai",
        name: `openai-${Date.now()}`,
        baseUrl: "http://localhost:4411/v1",
        secret: "secret",
      },
    });
    expect(allowed.statusCode).toBe(200);
    await db.delete(providerCredentials).where(eq(providerCredentials.id, allowed.json().id));
  });

  it("requires a resolved agent before enqueuing a run", async () => {
    const target = await createProjectWithAgent("Run Resolution");
    const before = (await db.select().from(runs).where(eq(runs.projectId, target.projectId)))
      .length;
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const absent = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: { mode: "builder", engine: "codex" },
      });
      expect(absent.statusCode).toBe(400);
      expect(absent.json().error.code).toBe("agent_required");

      const unknown = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: {
          mode: "builder",
          engine: "codex",
          trigger: { agentName: "missing-agent" },
        },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe("agent_required");
      expect(dispatched).toHaveLength(0);
      expect(await db.select().from(runs).where(eq(runs.projectId, target.projectId))).toHaveLength(
        before,
      );

      const run = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: {
          mode: "builder",
          engine: "codex",
          trigger: { agentName: target.agent.name },
        },
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().agentDefId).toBe(target.agent.id);
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: run.json().id, orgId } },
      ]);

      const runById = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: { mode: "builder", engine: "codex", agentDefId: target.agent.id },
      });
      expect(runById.statusCode).toBe(200);
      expect(runById.json().agentDefId).toBe(target.agent.id);
      expect(dispatched).toHaveLength(2);

      const events = await app.inject({
        method: "GET",
        url: `/v1/runs/${run.json().id}/events`,
        headers: { cookie },
      });
      expect(events.json()[0].type).toBe("queued");
      const stream = await app.inject({
        method: "GET",
        url: `/v1/runs/${run.json().id}/stream?idleMs=50`,
        headers: { cookie },
      });
      expect(stream.body).toContain("event: heartbeat");
    } finally {
      app.enqueue = originalEnqueue;
    }
  });

  it("rejects cross-org project IDs on key, budget, and registry writes", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const foreignOrgId = newId("org");
    const foreignProjectId = newId("proj");
    await db.insert(orgs).values({
      id: foreignOrgId,
      name: "Foreign Org",
      slug: `foreign-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: foreignOrgId,
      name: "Foreign Project",
      slug: `foreign-project-${suffix}`,
      settings: {},
    });

    const key = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `foreign-key-${suffix}`, roleId: ownerRole, projectId: foreignProjectId },
    });
    expect(key.statusCode).toBe(400);
    expect(key.json().error.code).toBe("project_not_in_org");

    const budget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: foreignProjectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
      },
    });
    expect(budget.statusCode).toBe(400);
    expect(budget.json().error.code).toBe("project_not_in_org");

    const registry = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: foreignProjectId,
        kind: "skill",
        name: `foreign-skill-${suffix}`,
        content: "body",
      },
    });
    expect(registry.statusCode).toBe(400);
    expect(registry.json().error.code).toBe("project_not_in_org");

    const sameOrgKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `same-org-key-${suffix}`, roleId: ownerRole, projectId },
    });
    expect(sameOrgKey.statusCode).toBe(200);
  });

  it("forbids a project-scoped principal from creating an org-wide budget and rejects bad enums", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `proj-budget-key-${suffix}`, roleId: ownerRole, projectId },
    });
    expect(projectKey.statusCode).toBe(200);
    // A project-scoped principal must not create an org-wide budget (it would cap
    // the whole org's spend, since the gateway ignores projectId for org budgets).
    const orgBudget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "org", period: "monthly", limitCents: 1000, mode: "hard" },
    });
    expect(orgBudget.statusCode).toBe(403);
    expect(orgBudget.json().error.code).toBe("forbidden_budget_scope");
    // Unenforceable enum values are rejected up front, not silently stored.
    const badMode = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "org", period: "monthly", limitCents: 1000, mode: "medium" },
    });
    expect(badMode.statusCode).toBe(400);
    const badPeriod = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "org", period: "hourly", limitCents: 1000, mode: "hard" },
    });
    expect(badPeriod.statusCode).toBe(400);
    // PATCH must not be a back door: a project principal cannot widen an existing
    // budget to org scope, and bad enums are rejected there too.
    const projectBudget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "project", period: "monthly", limitCents: 500, mode: "soft" },
    });
    expect(projectBudget.statusCode).toBe(200);
    const widen = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${projectBudget.json().id}`,
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "org" },
    });
    expect(widen.statusCode).toBe(403);
    expect(widen.json().error.code).toBe("forbidden_budget_scope");
    const patchBadMode = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${projectBudget.json().id}`,
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { mode: "medium" },
    });
    expect(patchBadMode.statusCode).toBe(400);

    // Scope coherence: agent budgets need an agent def; project/agent budgets need
    // a project; and widening a project budget to org (by an org principal) nulls
    // the project so it becomes a true org-wide budget.
    const agentNoAgent = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "agent_def", projectId, period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(agentNoAgent.statusCode).toBe(400);
    expect(agentNoAgent.json().error.code).toBe("budget_agent_required");
    const projectNoProject = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "project", period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(projectNoProject.statusCode).toBe(400);
    expect(projectNoProject.json().error.code).toBe("budget_project_required");
    const orgOwned = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "project", projectId, period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(orgOwned.statusCode).toBe(200);
    const widened = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${orgOwned.json().id}`,
      headers: { cookie },
      payload: { scope: "org" },
    });
    expect(widened.statusCode).toBe(200);
    expect(widened.json().scope).toBe("org");
    expect(widened.json().projectId).toBeNull();

    // Relational coherence: an agent budget must name an agent def that lives in
    // the budget's project — a foreign/unknown agent id is rejected.
    const agentForeign = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "agent_def",
        projectId,
        agentDefId: newId("agent"),
        period: "daily",
        limitCents: 10,
        mode: "hard",
      },
    });
    expect(agentForeign.statusCode).toBe(400);
    expect(agentForeign.json().error.code).toBe("agent_not_in_project");
  });

  it("rejects agent references outside the agent project", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectA = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Agent Ref A",
          slug: `agent-ref-a-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const projectB = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Agent Ref B",
          slug: `agent-ref-b-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!projectA || !projectB) throw new Error("project setup failed");
    const contractA = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId: projectA.id,
          kind: "contract",
          name: `contract-a-${suffix}`,
        })
        .returning()
    )[0];
    const contractB = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId: projectB.id,
          kind: "contract",
          name: `contract-b-${suffix}`,
        })
        .returning()
    )[0];
    const sandboxA = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: projectA.id,
          name: `sandbox-a-${suffix}`,
          driver: "docker",
          image: "node:22",
        })
        .returning()
    )[0];
    const sandboxB = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: projectB.id,
          name: `sandbox-b-${suffix}`,
          driver: "docker",
          image: "node:22",
        })
        .returning()
    )[0];
    if (!contractA || !contractB || !sandboxA || !sandboxB) throw new Error("agent setup failed");

    const crossContract = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.id}/agents`,
      headers: { cookie },
      payload: {
        name: `cross-contract-${suffix}`,
        engine: "codex",
        model: {},
        contractItemId: contractB.id,
      },
    });
    expect(crossContract.statusCode).toBe(400);
    expect(crossContract.json().error.code).toBe("reference_not_in_project");

    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.id}/agents`,
      headers: { cookie },
      payload: {
        name: `agent-ok-${suffix}`,
        engine: "codex",
        model: {},
        contractItemId: contractA.id,
        sandboxProfileId: sandboxA.id,
      },
    });
    expect(created.statusCode).toBe(200);

    const crossSandbox = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectA.id}/agents/${created.json().id}`,
      headers: { cookie },
      payload: { sandboxProfileId: sandboxB.id },
    });
    expect(crossSandbox.statusCode).toBe(400);
    expect(crossSandbox.json().error.code).toBe("reference_not_in_project");
  });

  it("returns org-wide paginated runs with project metadata", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectA = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Runs Page A",
          slug: `runs-page-a-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const projectB = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Runs Page B",
          slug: `runs-page-b-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!projectA || !projectB) throw new Error("project setup failed");
    const oldRunId = newId("run");
    const newRunId = newId("run");
    const status = `runs_page_${suffix.replace(/[^a-z0-9]/g, "_")}`;
    await db.insert(runs).values([
      {
        id: oldRunId,
        orgId,
        projectId: projectA.id,
        mode: "builder",
        engine: "codex",
        status,
        queuedAt: new Date("2999-01-01T00:00:00Z"),
        createdBy: { type: "test", id: "api" },
      },
      {
        id: newRunId,
        orgId,
        projectId: projectB.id,
        mode: "builder",
        engine: "codex",
        status,
        queuedAt: new Date("2999-01-02T00:00:00Z"),
        createdBy: { type: "test", id: "api" },
      },
    ]);
    const page = await app.inject({
      method: "GET",
      url: `/v1/runs?status=${status}&limit=1&offset=0`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toHaveLength(1);
    expect(page.json()[0]).toMatchObject({
      id: newRunId,
      project: { id: projectB.id, name: projectB.name, slug: projectB.slug },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/runs?status=${status}&limit=1&offset=1`,
      headers: { cookie },
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()[0]?.id).toBe(oldRunId);
  });

  it("validates HITL payloads and appends decision ledger events", async () => {
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `test_action_${Date.now()}`,
          payloadSchema: { type: "object", required: ["answer"] },
          resolver: { type: "permission", config: {} },
          executor: { type: "none", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    const bad = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: { actionTypeId: type?.id, payload: {}, contextMd: "ctx" },
    });
    expect(bad.statusCode).toBe(400);
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: { actionTypeId: type?.id, payload: { answer: true }, contextMd: "ctx" },
    });
    const decided = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.json().id}/decide`,
      headers: { cookie },
      payload: { decision: "approve", note: "ok" },
    });
    expect(decided.json().state).toBe("approved");
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal.json().id}`,
      headers: { cookie },
    });
    expect(loaded.json().events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
  });

  it("refuses an mcp_tool_call proposal on the generic route (per-tool perm bypass)", async () => {
    const actionType =
      (
        await db
          .select()
          .from(actionTypes)
          .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
          .limit(1)
      )[0] ??
      (
        await db
          .insert(actionTypes)
          .values({
            id: newId("act"),
            orgId,
            name: "mcp_tool_call",
            payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
            resolver: { type: "permission", config: {} },
            executor: { type: "mcp_tool_call", config: {} },
            defaultTtlHours: 1,
          })
          .returning()
      )[0];
    // A hitl:write principal must not smuggle a privileged MCP op through the
    // generic route — mcp_tool_call is reserved for /v1/mcp/tool-proposals which
    // checks the specific tool's permission (e.g. agents:write).
    const forged = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        actionTypeId: actionType?.id,
        payload: {
          toolName: "facility_create_agent",
          args: {},
          requestedBy: { type: "key", id: "x" },
        },
        contextMd: "smuggled privileged op",
      },
    });
    expect(forged.statusCode).toBe(403);
  });

  it("fails closed when executing task creation without a GitHub installation", async () => {
    const actionType = (
      await db
        .select()
        .from(actionTypes)
        .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'task_creation'`)
        .limit(1)
    )[0];
    if (!actionType) throw new Error("task_creation action type fixture missing");
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "GitHub Fail Closed Project",
          slug: `github-fail-closed-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!project) throw new Error("project fixture missing");
    const repo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId: project.id,
          owner: `owner-${Date.now()}`,
          name: "fail-closed",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!repo) throw new Error("repo fixture missing");
    const task = (
      await db
        .insert(poTasks)
        .values({
          id: newId("task"),
          orgId,
          projectId: project.id,
          title: "Create real issue only",
          bodyMd: "Do not fabricate a GitHub issue.",
          wsjf: { costOfDelay: 3, jobSize: 1 },
        })
        .returning()
    )[0];
    if (!task) throw new Error("task fixture missing");
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId: project.id,
          actionTypeId: actionType.id,
          payload: {
            taskId: task.id,
            title: task.title,
            bodyMd: task.bodyMd,
            wsjf: task.wsjf,
            target: { repo: { owner: repo.owner, name: repo.name } },
          },
          contextMd: "Task creation should fail without GitHub installation",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    if (!proposal) throw new Error("proposal fixture missing");
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal.id,
      seq: 1,
      type: "open",
      actor: { type: "test", id: "api" },
      data: {},
    });

    const decided = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.id}/decide`,
      headers: { cookie },
      payload: { decision: "approve" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("execution_failed");

    const events = await db
      .select()
      .from(proposalEvents)
      .where(
        sql`${proposalEvents.orgId} = ${orgId} and ${proposalEvents.proposalId} = ${proposal.id}`,
      )
      .orderBy(sql`${proposalEvents.seq} asc`);
    const failure = events.find((event) => event.type === "execution_failed");
    expect(failure?.data).toMatchObject({ error: "github_repo_not_installed" });

    const loadedTask = (await db.select().from(poTasks).where(eq(poTasks.id, task.id)).limit(1))[0];
    const forbiddenHost = ["github", "example"].join(".");
    expect(loadedTask?.status).not.toBe("created");
    expect(loadedTask?.gh).toBeNull();
    expect(JSON.stringify(loadedTask?.gh ?? {})).not.toContain(forbiddenHost);
    expect(sourceFilesContaining(new URL("../src/", import.meta.url), forbiddenHost)).toEqual([]);
  });

  it("gates MCP writes behind a separate human HITL approval", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-steer-${Date.now()}`,
        description: "MCP key without approval permission",
        permissions: ["org:read", "runs:steer"],
      },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "mcp-steer", roleId: role.json().id },
    });
    expect(issued.statusCode).toBe(200);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "manual",
          engine: "codex",
          status: "running",
          trigger: {},
          createdBy: { type: "test", id: "fixture" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "started",
      data: {},
    });

    const mismatched = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_publish_registry_version",
        permission: "runs:steer",
        args: { versionId: "ver_unsafe" },
        summary: "attempt confused-deputy publish",
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe("mcp_permission_mismatch");

    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_steer_run",
        permission: "runs:steer",
        args: { runId: run.id, body: "continue after tests pass" },
        summary: `Steer run ${run.id}`,
        runId: run.id,
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().state).toBe("open");

    const selfDecision = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { decision: "approve" },
    });
    expect(selfDecision.statusCode).toBe(403);
    expect(selfDecision.json().error.details.needed).toBe("hitl:decide");
    const stillOpen = (
      await db.select().from(proposals).where(eq(proposals.id, proposed.json().id)).limit(1)
    )[0];
    expect(stillOpen?.state).toBe("open");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve", note: "approved by human" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");
    const steerEvents = await db
      .select()
      .from(runEvents)
      .where(sql`${runEvents.runId} = ${run.id} and ${runEvents.type} = 'steer'`);
    expect(steerEvents).toHaveLength(1);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.orgId} = ${orgId} and ${auditEvents.action} = 'mcp.tool.executed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.projectId).toBe(projectId);

    const otherProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "MCP Audit Other", slug: `mcp-audit-other-${Date.now()}` },
    });
    expect(otherProject.statusCode).toBe(200);
    const projectAuditKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `mcp-audit-reader-${Date.now()}`, roleId: ownerRole, projectId },
    });
    expect(projectAuditKey.statusCode).toBe(200);
    const otherAuditKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-audit-other-reader-${Date.now()}`,
        roleId: ownerRole,
        projectId: otherProject.json().id,
      },
    });
    expect(otherAuditKey.statusCode).toBe(200);

    type AuditRow = { projectId?: string | null; target: { id?: string }; action: string };
    const projectAudit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=mcp.tool.executed&limit=500",
      headers: { authorization: `Bearer ${projectAuditKey.json().secret}` },
    });
    expect(projectAudit.statusCode).toBe(200);
    const projectAuditItems = projectAudit.json().items as AuditRow[];
    expect(projectAuditItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp.tool.executed",
          projectId,
          target: expect.objectContaining({ id: proposed.json().id }),
        }),
      ]),
    );

    const otherAudit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=mcp.tool.executed&limit=500",
      headers: { authorization: `Bearer ${otherAuditKey.json().secret}` },
    });
    expect(otherAudit.statusCode).toBe(200);
    const otherAuditItems = otherAudit.json().items as AuditRow[];
    expect(otherAuditItems.some((row) => row.target.id === proposed.json().id)).toBe(false);
  });

  it("refuses approved MCP execution when the resolved target project differs", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "MCP Other", slug: `mcp-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: other.json().id,
          mode: "manual",
          engine: "codex",
          status: "running",
          trigger: {},
          createdBy: { type: "test", id: "fixture" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    const actionType =
      (
        await db
          .select()
          .from(actionTypes)
          .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
          .limit(1)
      )[0] ??
      (
        await db
          .insert(actionTypes)
          .values({
            id: newId("act"),
            orgId,
            name: "mcp_tool_call",
            payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
            resolver: { type: "permission", config: {} },
            executor: { type: "mcp_tool_call", config: {} },
            defaultTtlHours: 1,
          })
          .returning()
      )[0];
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId,
          runId: run.id,
          actionTypeId: actionType?.id ?? "",
          payload: {
            toolName: "facility_steer_run",
            permission: "runs:steer",
            args: { runId: run.id, body: "cross project steer" },
            targetProjectId: projectId,
            requestedBy: { type: "key", id: "malicious" },
          },
          contextMd: "malicious cross-project MCP proposal",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal?.id ?? "",
      seq: 1,
      type: "open",
      actor: { type: "key", id: "malicious" },
      data: {},
    });

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal?.id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("execution_failed");
    const steerEvents = await db
      .select()
      .from(runEvents)
      .where(sql`${runEvents.runId} = ${run.id} and ${runEvents.type} = 'steer'`);
    expect(steerEvents).toHaveLength(0);
  });

  it("does not move an existing budget across projects on MCP set_budget", async () => {
    const suffix = `${Date.now()}`;
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Budget Move B", slug: `budget-move-b-${suffix}` },
    });
    expect(projectB.statusCode).toBe(200);
    const budget = (
      await db
        .insert(budgets)
        .values({
          id: newId("bud"),
          orgId,
          projectId,
          scope: "project",
          period: "monthly",
          limitCents: 1000,
          mode: "soft",
        })
        .returning()
    )[0];
    if (!budget) throw new Error("budget fixture missing");
    const actionType = (
      await db
        .select()
        .from(actionTypes)
        .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
        .limit(1)
    )[0];
    if (!actionType) throw new Error("mcp_tool_call action type missing");
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId,
          actionTypeId: actionType.id,
          payload: {
            toolName: "facility_set_budget",
            permission: "budgets:write",
            // args tries to move the budget to project B and raise the limit.
            args: {
              budgetId: budget.id,
              scope: "project",
              projectId: projectB.json().id,
              period: "monthly",
              limitCents: 9999,
              mode: "soft",
            },
            targetProjectId: projectId,
            requestedBy: { type: "key", id: "mover" },
          },
          contextMd: "set_budget across projects",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal?.id ?? "",
      seq: 1,
      type: "open",
      actor: { type: "key", id: "mover" },
      data: {},
    });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal?.id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");
    const after = (await db.select().from(budgets).where(eq(budgets.id, budget.id)).limit(1))[0];
    // Project pinned to its original scope; the non-project fields still update.
    expect(after?.projectId).toBe(projectId);
    expect(after?.projectId).not.toBe(projectB.json().id);
    expect(after?.limitCents).toBe(9999);
  });

  it("rejects MCP proposal creation by keys that can decide HITL", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "mcp-owner", roleId: ownerRole },
    });
    expect(issued.statusCode).toBe(200);
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_steer_run",
        permission: "runs:steer",
        args: { runId: "run_any", body: "do it" },
        summary: "unsafe owner-key proposal",
        runId: "run_any",
      },
    });
    expect(proposed.statusCode).toBe(403);
    expect(proposed.json().error.code).toBe("mcp_key_can_decide");
  });

  it("marks failed HITL execution explicitly and can retry it", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "HITL Failure", slug: `hitl-failure-${suffix}` },
    });
    expect(project.statusCode).toBe(200);
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/tasks`,
      headers: { cookie },
      payload: { title: "Needs retry", bodyMd: "body", wsjf: {} },
    });
    expect(task.statusCode).toBe(200);
    const proposed = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.json().id}/propose`,
      headers: { cookie },
    });
    expect(proposed.statusCode).toBe(200);

    const failed = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie },
      payload: { decision: "approve" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().state).toBe("execution_failed");
    const failedLoaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposed.json().id}`,
      headers: { cookie },
    });
    expect(failedLoaded.json().events.map((event: { type: string }) => event.type)).toContain(
      "execution_failed",
    );

    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `facility-retry-${suffix}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId: project.json().id,
      installationId: installation?.id,
      owner: `facility-retry-${suffix}`,
      name: "repo",
      defaultBranch: "main",
    });
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = fakeGithubFactory();
    try {
      const retried = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/execute`,
        headers: { cookie },
      });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().state).toBe("executed");
      const executed = await db
        .select()
        .from(proposalEvents)
        .where(
          sql`${proposalEvents.proposalId} = ${proposed.json().id} and ${proposalEvents.type} = 'executed'`,
        );
      expect(executed).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("audit verify detects a manually corrupted row", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Project", slug: `audit-${Date.now()}` },
    });
    const ok = await app.inject({ method: "GET", url: "/v1/audit/verify", headers: { cookie } });
    expect(ok.json().ok).toBe(true);
    const last = (
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.orgId, orgId))
        .orderBy(sql`${auditEvents.seq} desc`)
        .limit(1)
    )[0];
    if (!last) throw new Error("expected audit row");
    await db
      .update(auditEvents)
      .set({ payload: { corrupted: true } })
      .where(eq(auditEvents.id, last.id));
    const broken = await app.inject({
      method: "GET",
      url: "/v1/audit/verify",
      headers: { cookie },
    });
    expect(broken.json().ok).toBe(false);
    await db.update(auditEvents).set({ payload: last.payload }).where(eq(auditEvents.id, last.id));
  });

  it("enforces KB parent DAG rule and writes bidirectional links", async () => {
    const space = await app.inject({
      method: "PUT",
      url: `/v1/projects/${projectId}/kb/space`,
      headers: { cookie },
      payload: {
        charterMd: "",
        activeMd: "",
        config: { artifact_types: [{ prefix: "H", name: "Hypothesis" }] },
      },
    });
    expect(space.statusCode).toBe(200);
    const fail = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "E", slug: "experiment", bodyMd: "body", links: [] },
    });
    expect(fail.statusCode).toBe(400);
    const parent = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "H", slug: "hypothesis", bodyMd: "body", links: [] },
    });
    const child = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "E", slug: "experiment", bodyMd: "body", links: [parent.json().id] },
    });
    expect(child.statusCode).toBe(200);
  });

  it("aggregates spend over llm request fixtures", async () => {
    await db.insert(llmRequests).values({
      id: newId("evt"),
      orgId,
      projectId,
      provider: "openai",
      model: "gpt-5.5",
      status: "ok",
      costCents: 123,
      latencyMs: 10,
    });
    const spend = await app.inject({
      method: "GET",
      url: "/v1/spend?groupBy=model",
      headers: { cookie },
    });
    expect(spend.statusCode).toBe(200);
    expect(
      spend
        .json()
        .some(
          (row: { bucket: string; cost_cents: number }) =>
            row.bucket === "gpt-5.5" && row.cost_cents >= 123,
        ),
    ).toBe(true);
  });

  it("lists raw llm requests with project clamping and pagination", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "LLM Other", slug: `llm-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    await db.insert(llmRequests).values([
      {
        id: newId("evt"),
        orgId,
        projectId,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        inputTokens: 10,
        outputTokens: 5,
        costCents: 1,
        latencyMs: 10,
        requestUri: "s3://facility/request-a",
        responseUri: "s3://facility/response-a",
      },
      {
        id: newId("evt"),
        orgId,
        projectId: other.json().id,
        provider: "openai",
        model: "gpt-5.5-mini",
        status: "ok",
        inputTokens: 20,
        outputTokens: 10,
        costCents: 2,
        latencyMs: 20,
      },
    ]);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "llm-reader", roleId: ownerRole, projectId },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/llm-requests?limit=1",
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0].projectId).toBe(projectId);
    expect(listed.json().items[0].requestUri).toBeTruthy();
  });

  it("reads a stored llm request envelope through the API", async () => {
    const envelope = { request: { body: { model: "gpt-5.5" } }, response: { id: "resp_1" } };
    // Envelopes are keyed under the owning org's prefix; the read path enforces
    // that the stored URI stays within envelopes/<orgId>/.
    const envelopeKey = `envelopes/${orgId}/evt.json.gz`;
    const server = createServer((request, response) => {
      if (request.url === `/facility-test/${envelopeKey}`) {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync(Buffer.from(JSON.stringify(envelope))));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previousBucket = config.s3Bucket;
    const previousEndpoint = config.s3Endpoint;
    const previousAccessKey = config.s3AccessKey;
    const previousSecretKey = config.s3SecretKey;
    const previousRegion = config.awsRegion;
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const requestId = newId("evt");
      await db.insert(llmRequests).values({
        id: requestId,
        orgId,
        projectId,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 123,
        latencyMs: 10,
        requestUri: `s3://facility-test/${envelopeKey}`,
        responseUri: `s3://facility-test/${envelopeKey}`,
      });
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "envelope-reader", roleId: ownerRole, projectId },
      });
      const response = await app.inject({
        method: "GET",
        url: `/v1/llm-requests/${requestId}/envelope`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().llmRequest.id).toBe(requestId);
      expect(response.json().envelope).toEqual(envelope);
    } finally {
      config.s3Bucket = previousBucket;
      config.s3Endpoint = previousEndpoint;
      config.s3AccessKey = previousAccessKey;
      config.s3SecretKey = previousSecretKey;
      config.awsRegion = previousRegion;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("requires the runner token for transcript uploads", async () => {
    const token = "frt_transcript_auth";
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "codex",
          status: "running",
          sandbox: { runnerTokenHash: await hashKey(token) },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run?.id}/transcript`,
      headers: { "content-type": "application/x-ndjson" },
      payload: '{"type":"result"}\n',
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects transcript uploads over 50 MB", async () => {
    const token = "frt_transcript_large";
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "codex",
          status: "running",
          sandbox: { runnerTokenHash: await hashKey(token) },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run?.id}/transcript`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-ndjson",
      },
      payload: Buffer.alloc(50 * 1024 * 1024 + 1, "x"),
    });
    expect(response.statusCode).toBe(413);
  });

  it("round trips a run transcript and hides it from another project-scoped key", async () => {
    const transcript = '{"type":"system","session_id":"sess_1"}\n{"type":"result"}\n';
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const token = "frt_transcript_roundtrip";
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId,
            mode: "builder",
            engine: "codex",
            status: "running",
            sandbox: { runnerTokenHash: await hashKey(token) },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const upload = await app.inject({
        method: "POST",
        url: `/internal/runs/${run?.id}/transcript`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
        },
        payload: transcript,
      });
      expect(upload.statusCode).toBe(200);
      const stored = (
        await db
          .select()
          .from(runs)
          .where(eq(runs.id, run?.id ?? ""))
          .limit(1)
      )[0];
      expect(stored?.transcriptUri).toBe(
        `s3://facility-test/transcripts/${orgId}/${run?.id}.jsonl`,
      );
      const loaded = await app.inject({
        method: "GET",
        url: `/v1/runs/${run?.id}/transcript`,
        headers: { cookie },
      });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.headers["content-type"]).toContain("application/x-ndjson");
      expect(loaded.body).toBe(transcript);

      const otherProject = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Transcript Other Project",
            slug: `transcript-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "transcript-other-key", roleId: ownerRole, projectId: otherProject?.id },
      });
      const crossProject = await app.inject({
        method: "GET",
        url: `/v1/runs/${run?.id}/transcript`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(crossProject.statusCode).toBe(404);
    } finally {
      Object.assign(config, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uploads session state and serves the parent archive only to a matching resume run", async () => {
    const archive = gzipSync(Buffer.from("claude state"));
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, { "content-type": "application/gzip" });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const target = await createProjectWithAgent("Session State");
      const parentToken = "frt_session_state_parent";
      const parent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: { runnerTokenHash: await hashKey(parentToken) },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const unauth = await app.inject({
        method: "POST",
        url: `/internal/runs/${parent?.id}/session-state`,
        headers: { "content-type": "application/gzip" },
        payload: archive,
      });
      expect(unauth.statusCode).toBe(401);
      const upload = await app.inject({
        method: "POST",
        url: `/internal/runs/${parent?.id}/session-state`,
        headers: {
          authorization: `Bearer ${parentToken}`,
          "content-type": "application/gzip",
        },
        payload: archive,
      });
      expect(upload.statusCode).toBe(200);
      const stored = (
        await db
          .select()
          .from(runs)
          .where(eq(runs.id, parent?.id ?? ""))
          .limit(1)
      )[0];
      expect(stored?.sessionStateUri).toBe(
        `s3://facility-test/session-state/${orgId}/${parent?.id}.tgz`,
      );

      const currentToken = "frt_session_state_current";
      const current = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: {
              runnerTokenHash: await hashKey(currentToken),
              bundle: {
                resume: { sessionId: "sess_1", sessionStateFrom: parent?.id, prompt: "go" },
              },
            },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const loaded = await app.inject({
        method: "GET",
        url: `/internal/runs/${current?.id}/session-state`,
        headers: { authorization: `Bearer ${currentToken}` },
      });
      expect(loaded.statusCode).toBe(200);
      expect(Buffer.compare(loaded.rawPayload, archive)).toBe(0);

      const otherProject = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Session State Other",
            slug: `session-state-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const mismatchToken = "frt_session_state_mismatch";
      const mismatched = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: otherProject?.id ?? projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: {
              runnerTokenHash: await hashKey(mismatchToken),
              bundle: {
                resume: { sessionId: "sess_1", sessionStateFrom: parent?.id, prompt: "go" },
              },
            },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const blocked = await app.inject({
        method: "GET",
        url: `/internal/runs/${mismatched?.id}/session-state`,
        headers: { authorization: `Bearer ${mismatchToken}` },
      });
      expect(blocked.statusCode).toBe(404);
    } finally {
      Object.assign(config, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("denies the llm envelope to a spend:read-only principal", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `spend-only-${Date.now()}`, permissions: ["spend:read"] },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "spend-only-key", roleId: role.json().id, projectId },
    });
    const requestId = newId("evt");
    await db.insert(llmRequests).values({
      id: requestId,
      orgId,
      projectId,
      provider: "openai",
      model: "gpt-5.5",
      status: "ok",
      costCents: 1,
      latencyMs: 1,
      requestUri: "s3://facility-test/x.json.gz",
      responseUri: "s3://facility-test/x.json.gz",
    });
    // spend:read sees cost (via /v1/spend + the request list) but NOT the full
    // request/response transcript — the envelope now requires audit:read.
    const denied = await app.inject({
      method: "GET",
      url: `/v1/llm-requests/${requestId}/envelope`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("runs the admin readiness doctor with object-store and audit-chain checks", async () => {
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-encoding": "gzip",
          });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
      githubAppWebhookSecret: config.githubAppWebhookSecret,
      githubAppSlug: config.githubAppSlug,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    config.githubAppId = "1";
    config.githubAppPrivateKey = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
    config.githubAppWebhookSecret = "secret";
    config.githubAppSlug = "facility-test";
    const first = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "doctor-test" },
      action: "doctor.audit.first",
      target: { type: "org", id: orgId },
    });
    const second = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "doctor-test" },
      action: "doctor.audit.second",
      target: { type: "org", id: orgId },
    });
    if (!first || !second) throw new Error("audit fixture setup failed");
    try {
      const healthy = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(healthy.statusCode).toBe(200);
      expect(healthy.json().ok).toBe(true);
      expect(checkStatus(healthy.json(), "object_storage")).toBe("pass");
      expect(checkStatus(healthy.json(), "audit_hash_chain")).toBe("pass");
      // The seeded default profile runs the configured runner image on the docker
      // driver (Docker reachable in the test env). Whether that image is present
      // locally is environmental, so the platform-lane check is pass (image
      // present) or warn (image absent, pulled on first run) — never fail.
      expect(["pass", "warn"]).toContain(checkStatus(healthy.json(), "sandbox_runner"));
      expect([...objects.keys()].some((key) => key.includes("/facility-test/envelopes/"))).toBe(
        true,
      );

      await db.update(auditEvents).set({ hash: "broken" }).where(eq(auditEvents.id, second.id));
      const broken = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(broken.statusCode).toBe(200);
      expect(broken.json().ok).toBe(false);
      expect(checkStatus(broken.json(), "audit_hash_chain")).toBe("fail");
    } finally {
      await db
        .update(auditEvents)
        .set({ hash: second.hash, prevHash: first.hash })
        .where(eq(auditEvents.id, second.id));
      Object.assign(config, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("filters audit rows by actor and returns newest-first pages", async () => {
    const action = `audit.filtered.${Date.now()}`;
    const first = await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "auditor" },
      action,
      target: { type: "test", id: "first" },
    });
    const second = await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "auditor" },
      action,
      target: { type: "test", id: "second" },
    });
    await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "other" },
      action,
      target: { type: "test", id: "other" },
    });

    const page = await app.inject({
      method: "GET",
      url: `/v1/audit?action=${action}&actor=key:auditor&limit=1`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.map((row: { id: string }) => row.id)).toEqual([second?.id]);
    expect(page.json().nextCursor).toBe(second?.seq);
    const next = await app.inject({
      method: "GET",
      url: `/v1/audit?action=${action}&actor=auditor&cursor=${page.json().nextCursor}`,
      headers: { cookie },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().items.map((row: { id: string }) => row.id)).toEqual([first?.id]);
  });

  it("filters audit rows to a project-scoped key's project and preserves the hash chain", async () => {
    const suffix = Date.now();
    const projectA = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Scoped A", slug: `audit-scoped-a-${suffix}` },
    });
    expect(projectA.statusCode).toBe(200);
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Scoped B", slug: `audit-scoped-b-${suffix}` },
    });
    expect(projectB.statusCode).toBe(200);

    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `audit-reader-${suffix}`, roleId: ownerRole, projectId: projectA.json().id },
    });
    expect(issued.statusCode).toBe(200);

    const updateA = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectA.json().id}`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { description: "project A audit event" },
    });
    expect(updateA.statusCode).toBe(200);
    const updateB = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectB.json().id}`,
      headers: { cookie },
      payload: { description: "project B audit event" },
    });
    expect(updateB.statusCode).toBe(200);

    await expect(verifyAuditChain(db, orgId)).resolves.toEqual({ ok: true, firstBreakSeq: null });

    type AuditRow = { projectId?: string | null; target: { id?: string } };
    const scoped = await app.inject({
      method: "GET",
      url: "/v1/audit?action=project.updated&limit=500",
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(scoped.statusCode).toBe(200);
    const scopedItems = scoped.json().items as AuditRow[];
    expect(scopedItems.every((row) => row.projectId === projectA.json().id)).toBe(true);
    expect(scopedItems.some((row) => row.target.id === projectA.json().id)).toBe(true);
    expect(scopedItems.some((row) => row.target.id === projectB.json().id)).toBe(false);

    const orgLevel = await app.inject({
      method: "GET",
      url: "/v1/audit?action=project.updated&limit=500",
      headers: { cookie },
    });
    expect(orgLevel.statusCode).toBe(200);
    const orgItems = orgLevel.json().items as AuditRow[];
    expect(orgItems.some((row) => row.target.id === projectA.json().id)).toBe(true);
    expect(orgItems.some((row) => row.target.id === projectB.json().id)).toBe(true);
  });

  it("groups spend by agent definition, not run id", async () => {
    const agent = (await db.select().from(agentDefs).where(eq(agentDefs.orgId, orgId)).limit(1))[0];
    expect(agent).toBeTruthy();
    if (!agent) throw new Error("agent fixture missing");
    const runA = newId("run");
    const runB = newId("run");
    await db.insert(runs).values([
      {
        id: runA,
        orgId,
        projectId: agent.projectId,
        agentDefId: agent.id,
        mode: "builder",
        engine: "codex",
        createdBy: { type: "test", id: "api" },
      },
      {
        id: runB,
        orgId,
        projectId: agent.projectId,
        agentDefId: agent.id,
        mode: "builder",
        engine: "codex",
        createdBy: { type: "test", id: "api" },
      },
    ]);
    await db.insert(llmRequests).values([
      {
        id: newId("evt"),
        orgId,
        projectId: agent.projectId,
        runId: runA,
        agentDefId: agent.id,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 100,
        latencyMs: 10,
      },
      {
        id: newId("evt"),
        orgId,
        projectId: agent.projectId,
        runId: runB,
        agentDefId: agent.id,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 125,
        latencyMs: 10,
      },
    ]);
    const spend = await app.inject({
      method: "GET",
      url: "/v1/spend?groupBy=agent",
      headers: { cookie },
    });
    expect(spend.statusCode).toBe(200);
    const row = spend
      .json()
      .find((item: { bucket: string; cost_cents: number }) => item.bucket === agent.id);
    expect(row?.cost_cents).toBeGreaterThanOrEqual(225);
  });

  it("startup assertion catches an undeclared protected route", async () => {
    const bad = await buildApp(config);
    bad.get("/v1/bad-test-route", async () => ({ ok: true }));
    await expect(bad.ready()).rejects.toThrow(/missing permission/i);
    await bad.close();
  });

  it("pins project-scoped keys to their project (404 elsewhere)", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Other", slug: `other-${Date.now()}` },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "pinned", roleId: ownerRole, projectId },
    });
    const secret = issued.json().secret;
    const own = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(own.statusCode).toBe(200);
    const projectList = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(projectList.statusCode).toBe(200);
    expect(projectList.json().map((row: { id: string }) => row.id)).toEqual([projectId]);
    const cross = await app.inject({
      method: "GET",
      url: `/v1/projects/${other.json().id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(cross.statusCode).toBe(404);
    // bare-id resources are pinned too
    const otherAgent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, other.json().id)).limit(1)
    )[0];
    expect(otherAgent).toBeTruthy();
    const crossRun = await app.inject({
      method: "POST",
      url: `/v1/projects/${other.json().id}/runs`,
      headers: { cookie },
      payload: { mode: "builder", engine: "codex", agentDefId: otherAgent?.id },
    });
    const denied = await app.inject({
      method: "GET",
      url: `/v1/runs/${crossRun.json().id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(denied.statusCode).toBe(404);
    await db.insert(budgets).values([
      {
        id: newId("bud"),
        orgId,
        scope: "project",
        projectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
        enabled: true,
      },
      {
        id: newId("bud"),
        orgId,
        scope: "project",
        projectId: other.json().id,
        period: "daily",
        limitCents: 100,
        mode: "hard",
        enabled: true,
      },
    ]);
    const budgetList = await app.inject({
      method: "GET",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(budgetList.statusCode).toBe(200);
    expect(
      budgetList.json().every((row: { projectId: string }) => row.projectId === projectId),
    ).toBe(true);
  });

  it("returns 404 when a project-scoped key mutates another project's sandbox profile", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Sandbox Other", slug: `sandbox-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    const ownKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "sandbox-project-key", roleId: ownerRole, projectId },
    });
    const otherProfile = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: other.json().id,
          name: "other sandbox",
          driver: "docker",
          image: "node:22",
          setup: {},
          resources: {},
          network: {},
        })
        .returning()
    )[0];
    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/sandbox-profiles/${otherProfile?.id}`,
      headers: { authorization: `Bearer ${ownKey.json().secret}` },
      payload: { image: "node:24" },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("stores unique key prefixes so auth is an indexed lookup", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "prefix-a", roleId: viewerRole },
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "prefix-b", roleId: viewerRole },
    });
    expect(a.json().prefix).not.toBe(b.json().prefix);
    expect(a.json().prefix).toBe(String(a.json().secret).slice(0, 12));
  });

  it("rejects issuing a more privileged role than the caller has", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `issuer-${Date.now()}`, permissions: ["keys:issue"] },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-issuer", roleId: role.json().id },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { name: "owner-escalation", roleId: ownerRole },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("privilege_escalation");
  });

  it("rejects assigning a member into a role more privileged than the caller", async () => {
    const mgrRole = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `mgr-${Date.now()}`, permissions: ["members:write", "members:read"] },
    });
    const mgrKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-mgr", roleId: mgrRole.json().id },
    });
    const token = mgrKey.json().secret;
    const target = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { cookie },
      payload: { email: `target-${Date.now()}@example.com`, roleId: viewerRole },
    });
    // The members-only manager cannot promote anyone (incl. itself) to owner(*).
    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/members/${target.json().userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { roleId: ownerRole },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("privilege_escalation");
  });

  it("rejects creating a role with permissions the caller does not hold", async () => {
    const rolerRole = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `roler-${Date.now()}`, permissions: ["roles:write", "roles:read"] },
    });
    const rolerKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-roler", roleId: rolerRole.json().id },
    });
    const token = rolerKey.json().secret;
    const wildcard = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `escalated-${Date.now()}`, permissions: ["*"] },
    });
    expect(wildcard.statusCode).toBe(403);
    expect(wildcard.json().error.code).toBe("privilege_escalation");
    const bogus = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `bogus-${Date.now()}`, permissions: ["not:aperm"] },
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error.code).toBe("invalid_permission");
  });

  it("blocks project-scoped keys from another project's proposal, task, key, budget, and registry item", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Scoped Other", slug: `scoped-other-${Date.now()}` },
    });
    const otherProjectId = other.json().id;
    const ownKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "own-project-owner", roleId: ownerRole, projectId },
    });
    const otherKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "other-project-owner", roleId: ownerRole, projectId: otherProjectId },
    });
    const orgKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "org-owner", roleId: ownerRole },
    });
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `scope_test_${Date.now()}`,
          payloadSchema: { type: "object", required: [] },
          resolver: { type: "permission", config: {} },
          executor: { type: "none", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId: otherProjectId,
          actionTypeId: type?.id ?? "",
          payload: {},
          contextMd: "cross project",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    const task = (
      await db
        .insert(poTasks)
        .values({
          id: newId("task"),
          orgId,
          projectId: otherProjectId,
          title: "Cross task",
          bodyMd: "body",
          wsjf: {},
        })
        .returning()
    )[0];
    const auth = { authorization: `Bearer ${ownKey.json().secret}` };
    const readProposal = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal?.id}`,
      headers: auth,
    });
    expect(readProposal.statusCode).toBe(404);
    const mutateTask = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task?.id}/transition`,
      headers: auth,
      payload: { status: "created" },
    });
    expect(mutateTask.statusCode).toBe(404);
    const revokeKey = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${otherKey.json().id}`,
      headers: auth,
    });
    expect(revokeKey.statusCode).toBe(404);
    const revokeOrgKey = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${orgKey.json().id}`,
      headers: auth,
    });
    expect(revokeOrgKey.statusCode).toBe(404);
    const budget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: otherProjectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
      },
    });
    expect(budget.statusCode).toBe(200);
    const registry = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: otherProjectId,
        kind: "skill",
        name: `cross-scope-skill-${Date.now()}`,
        content: "body",
      },
    });
    expect(registry.statusCode).toBe(200);
    const versionId = registry.json().versions[0].id;
    const readBudget = await app.inject({
      method: "GET",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
    });
    expect(readBudget.statusCode).toBe(404);
    const patchBudget = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
      payload: { limitCents: 200 },
    });
    expect(patchBudget.statusCode).toBe(404);
    const deleteBudget = await app.inject({
      method: "DELETE",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
    });
    expect(deleteBudget.statusCode).toBe(404);
    const readRegistry = await app.inject({
      method: "GET",
      url: `/v1/registry/items/${registry.json().id}`,
      headers: auth,
    });
    expect(readRegistry.statusCode).toBe(404);
    const versionRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/items/${registry.json().id}/versions`,
      headers: auth,
      payload: { content: "v2" },
    });
    expect(versionRegistry.statusCode).toBe(404);
    const publishRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${versionId}/publish`,
      headers: auth,
    });
    expect(publishRegistry.statusCode).toBe(404);
    const deprecateRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${versionId}/deprecate`,
      headers: auth,
    });
    expect(deprecateRegistry.statusCode).toBe(404);
  });

  it("returns 403 when project-scoped keys call org-admin endpoints", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "project-admin-denied", roleId: ownerRole, projectId },
    });
    const auth = { authorization: `Bearer ${issued.json().secret}` };
    for (const url of ["/v1/org", "/v1/members", "/v1/roles", "/v1/providers"]) {
      const response = await app.inject({ method: "GET", url, headers: auth });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("project_scope_forbidden");
    }
  });

  it("returns 409 for an already-approved proposal without re-executing it", async () => {
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `facility-test-${Date.now()}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installation?.id,
      owner: `facility-test-${Date.now()}`,
      name: "repo",
      defaultBranch: "main",
    });
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/tasks`,
      headers: { cookie },
      payload: { title: "Create issue once", bodyMd: "body", wsjf: {} },
    });
    const proposed = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.json().id}/propose`,
      headers: { cookie },
    });
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = fakeGithubFactory();
    try {
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      const repeated = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie },
        payload: { decision: "approve" },
      });
      expect(repeated.statusCode).toBe(409);
      const executed = await db
        .select()
        .from(proposalEvents)
        .where(
          sql`${proposalEvents.proposalId} = ${proposed.json().id} and ${proposalEvents.type} = 'executed'`,
        );
      expect(executed).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("ignores forbidden projectId and orgId fields on PATCH", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Patch Other", slug: `patch-other-${Date.now()}` },
    });
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/tasks`,
      headers: { cookie },
      payload: { title: "Patch guarded", bodyMd: "body", wsjf: {} },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/tasks/${task.json().id}`,
      headers: { cookie },
      payload: { title: "Patch guarded updated", projectId: other.json().id, orgId: "org_bad" },
    });
    expect(patched.statusCode).toBe(200);
    const row = (await db.select().from(poTasks).where(eq(poTasks.id, task.json().id)).limit(1))[0];
    expect(row?.title).toBe("Patch guarded updated");
    expect(row?.projectId).toBe(projectId);
    expect(row?.orgId).toBe(orgId);
  });

  it("rejects triggering a run with an agent definition from another project", async () => {
    const projectA = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Run A", slug: `run-a-${Date.now()}` },
    });
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Run B", slug: `run-b-${Date.now()}` },
    });
    const foreignAgent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, projectB.json().id)).limit(1)
    )[0];
    expect(foreignAgent).toBeTruthy();
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.json().id}/runs`,
      headers: { cookie },
      payload: { mode: "builder", engine: "codex", agentDefId: foreignAgent?.id },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().error.code).toBe("agent_not_in_project");
  });

  it("creates a greenfield GitHub repo through the App and connects the repo row", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Greenfield", slug: `greenfield-${Date.now()}` },
    });
    expect(project.statusCode).toBe(200);
    const installationId = Date.now();
    const owner = `octo-${installationId}`;
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!installation) throw new Error("installation fixture missing");
    let createArgs: Record<string, unknown> | undefined;
    app.githubClientFactory = async (actualInstallationId) => {
      expect(actualInstallationId).toBe(installationId);
      return {
        rest: {
          repos: {
            createInOrg: async (args: Record<string, unknown>) => {
              createArgs = args;
              return {
                data: {
                  name: String(args.name),
                  owner: { login: String(args.org) },
                  default_branch: "main",
                },
              };
            },
          },
        },
      } as never;
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/repos`,
      headers: { cookie },
      payload: {
        owner,
        name: "created-repo",
        defaultBranch: "main",
        mode: "create",
        private: true,
        autoInit: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createArgs).toEqual({
      org: owner,
      name: "created-repo",
      private: true,
      description: undefined,
      auto_init: false,
    });
    const repo = (
      await db.select().from(repos).where(eq(repos.id, response.json().id)).limit(1)
    )[0];
    expect(repo?.installationId).toBe(installation.id);
    expect(repo?.owner).toBe(owner);
    expect(repo?.name).toBe("created-repo");
    app.githubClientFactory = undefined;
  });

  it("accepts signed generic inbound payloads and rejects bad signatures", async () => {
    const secret = "generic-inbound-secret";
    const fingerprint = `generic:${Date.now()}`;
    const integration = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          projectId,
          kind: "generic_inbound",
          name: "Generic Inbound",
          config: { projectId },
          sealedSecret: await seal(secret, masterKey),
        })
        .returning()
    )[0];
    if (!integration) throw new Error("integration fixture missing");
    const payload = Buffer.from(
      JSON.stringify({
        eventType: "alert",
        title: "Generic alert",
        bodyMd: "Generic alert body",
        severity: "error",
        fingerprint,
      }),
    );
    const bad = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-signature": "sha256=bad",
      },
      payload,
    });
    expect(bad.statusCode).toBe(401);
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const valid = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": newId("evt"),
        "x-facility-signature": signature,
      },
      payload,
    });
    expect(valid.statusCode).toBe(202);
    const events = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.integrationId, integration.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.verified).toBe(true);
    expect(events[0]?.processedAt).toBeTruthy();
    const issue = (
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, fingerprint))
        .limit(1)
    )[0];
    expect(issue?.projectId).toBe(projectId);
    expect(issue?.title).toBe("Generic alert");
    expect(issue?.severity).toBe("error");
  });

  it("does not let one integration's delivery id suppress another's identical id", async () => {
    // Regression: inbound idempotency keys on `in_${integration.id}_${deliveryId}`,
    // not a global `in_${deliveryId}`. Two integrations that happen to emit the
    // same delivery id must BOTH process — the first must not shadow the second.
    const secret = "shared-inbound-secret";
    const delivery = newId("evt");
    const make = async (label: string) =>
      (
        await db
          .insert(integrations)
          .values({
            id: newId("int"),
            orgId,
            projectId,
            kind: "generic_inbound",
            name: label,
            config: { projectId },
            sealedSecret: await seal(secret, masterKey),
          })
          .returning()
      )[0];
    const a = await make("Inbound A");
    const b = await make("Inbound B");
    if (!a || !b) throw new Error("integration fixtures missing");

    const post = async (integrationId: string, fingerprint: string) => {
      const payload = Buffer.from(
        JSON.stringify({ eventType: "alert", title: fingerprint, bodyMd: "b", fingerprint }),
      );
      const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
      return app.inject({
        method: "POST",
        url: `/webhooks/inbound/${integrationId}`,
        headers: {
          "content-type": "application/json",
          "x-facility-delivery": delivery,
          "x-facility-signature": signature,
        },
        payload,
      });
    };

    const fpA = `shared-a:${delivery}`;
    const fpB = `shared-b:${delivery}`;
    expect((await post(a.id, fpA)).statusCode).toBe(202);
    expect((await post(b.id, fpB)).statusCode).toBe(202);

    expect(
      await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.id, `in_${a.id}_${delivery}`)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.id, `in_${b.id}_${delivery}`)),
    ).toHaveLength(1);
    // Both fully processed — each raised its own issue, so the second wasn't dropped.
    expect(
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fpA)),
    ).toHaveLength(1);
    expect(
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fpB)),
    ).toHaveLength(1);
  });

  it("refuses steering a finished run", async () => {
    const target = await createProjectWithAgent("Steering Run");
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${target.projectId}/runs`,
      headers: { cookie },
      payload: { mode: "builder", engine: "codex", agentDefId: target.agent.id },
    });
    await app.inject({
      method: "POST",
      url: `/v1/runs/${run.json().id}/cancel`,
      headers: { cookie },
    });
    const steer = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.json().id}/steer`,
      headers: { cookie },
      payload: { body: "hello?" },
    });
    expect(steer.statusCode).toBe(409);
  });

  it("interrupts live runs through steer_messages and rejects terminal or unauthorized calls", async () => {
    const target = await createProjectWithAgent("Interrupt Run");
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          mode: "builder",
          engine: "claude_code",
          status: "running",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const interrupted = await app.inject({
      method: "POST",
      url: `/v1/runs/${run?.id}/interrupt`,
      headers: { cookie },
    });
    expect(interrupted.statusCode).toBe(200);
    if (!run) throw new Error("interrupt run fixture missing");
    const messages = await db.select().from(steerMessages).where(eq(steerMessages.runId, run.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("interrupt");
    const steerEvent = (
      await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run?.id ?? ""))
        .orderBy(runEvents.seq)
    ).find((event) => event.type === "steer");
    expect(steerEvent?.data).toMatchObject({ kind: "interrupt" });

    const finished = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          mode: "builder",
          engine: "claude_code",
          status: "succeeded",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const terminal = await app.inject({
      method: "POST",
      url: `/v1/runs/${finished?.id}/interrupt`,
      headers: { cookie },
    });
    expect(terminal.statusCode).toBe(409);

    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `read-only-${Date.now()}`, permissions: ["runs:read"] },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "interrupt-read-only", roleId: role.json().id, projectId: target.projectId },
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/runs/${run?.id}/interrupt`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("resumes terminal claude_code runs with a session id and preserves parent scope", async () => {
    const target = await createProjectWithAgent("Resume Run");
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const parent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "succeeded",
            engineSessionId: "sess_resume_1",
            gh: { owner: "octo", repo: "repo", branch: "facility/old" },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const resumed = await app.inject({
        method: "POST",
        url: `/v1/runs/${parent?.id}/resume`,
        headers: { cookie },
        payload: { message: "continue this" },
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().trigger).toEqual({
        type: "resume",
        resumeOf: parent?.id,
        message: "continue this",
      });
      expect(resumed.json().gh).toEqual({ owner: "octo", repo: "repo", branch: "facility/old" });
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: resumed.json().id, orgId } },
      ]);

      const runningParent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            engineSessionId: "sess_resume_2",
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const running = await app.inject({
        method: "POST",
        url: `/v1/runs/${runningParent?.id}/resume`,
        headers: { cookie },
      });
      expect(running.statusCode).toBe(409);

      const codexParent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "codex",
            status: "succeeded",
            engineSessionId: "sess_codex",
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const codex = await app.inject({
        method: "POST",
        url: `/v1/runs/${codexParent?.id}/resume`,
        headers: { cookie },
      });
      expect(codex.statusCode).toBe(409);
      expect(codex.json().error.code).toBe("not_resumable");

      const other = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Resume Other",
            slug: `resume-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "resume-other-key", roleId: ownerRole, projectId: other?.id },
      });
      const scoped = await app.inject({
        method: "POST",
        url: `/v1/runs/${parent?.id}/resume`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(scoped.statusCode).toBe(404);
    } finally {
      app.enqueue = originalEnqueue;
    }
  });

  it("creates project-owner conversations, dispatches turns, and enforces project scope", async () => {
    const target = await createProjectWithAgent("Conversation Run");
    const ownerAgent = (
      await db
        .select()
        .from(agentDefs)
        .where(
          sql`${agentDefs.projectId} = ${target.projectId} and ${agentDefs.name} = 'project-owner'`,
        )
        .limit(1)
    )[0];
    expect(ownerAgent).toBeTruthy();
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const created = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/conversations`,
        headers: { cookie },
        payload: { title: "Owner chat" },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().agentDefId).toBe(ownerAgent?.id);
      expect(created.json().status).toBe("idle");

      const turn = await app.inject({
        method: "POST",
        url: `/v1/conversations/${created.json().id}/messages`,
        headers: { cookie },
        payload: { body: "What should we do next?" },
      });
      expect(turn.statusCode).toBe(200);
      const storedConversation = (
        await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, created.json().id))
          .limit(1)
      )[0];
      expect(storedConversation?.status).toBe("running");
      const userMessages = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, created.json().id));
      expect(userMessages.map((message) => message.seq)).toEqual([1]);
      expect(userMessages[0]?.role).toBe("user");
      const run = (await db.select().from(runs).where(eq(runs.id, turn.json().runId)).limit(1))[0];
      expect(run?.mode).toBe("conversation");
      expect(run?.trigger).toEqual({
        type: "conversation",
        conversationId: created.json().id,
        message: "What should we do next?",
      });
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: turn.json().runId, orgId } },
      ]);

      const second = await app.inject({
        method: "POST",
        url: `/v1/conversations/${created.json().id}/messages`,
        headers: { cookie },
        payload: { body: "Second turn" },
      });
      expect(second.statusCode).toBe(409);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/conversations/${created.json().id}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().messages).toHaveLength(1);

      const codexAgent = (
        await db
          .insert(agentDefs)
          .values({
            id: newId("agent"),
            orgId,
            projectId: target.projectId,
            name: `codex-owner-${Date.now()}`,
            engine: "codex",
            model: {},
            contractItemId: target.agent.contractItemId,
            harnessItemId: target.agent.harnessItemId,
            triggers: [],
            sandboxProfileId: target.agent.sandboxProfileId,
            permissions: [],
            enabled: true,
          })
          .returning()
      )[0];
      const unsupported = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/conversations`,
        headers: { cookie },
        payload: { agentDefId: codexAgent?.id },
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json().error.code).toBe("engine_unsupported");
    } finally {
      app.enqueue = originalEnqueue;
    }
  });
});

function checkStatus(payload: { checks: Array<{ id: string; status: string }> }, id: string) {
  return payload.checks.find((check) => check.id === id)?.status;
}
