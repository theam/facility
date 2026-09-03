import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  auditEvents,
  createDb,
  githubCiEvents,
  githubInstallations,
  githubIssues,
  githubPullRequests,
  migrate,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  stories,
  storyConversations,
  turns,
  turnUsage,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GithubMirrorService, restCiSignal, webhookCiSignal } from "../src/github/mirror.js";
import { GithubPipelineService } from "../src/github/pipeline.js";
import { BudgetPolicyError, CostBudgetService } from "../src/insights/costs.js";

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

describe("cost controls, GitHub mirror, and pipeline", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; insights tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const otherOrgId = newId("org");
  const projectId = newId("proj");
  const installationId = newId("ghi");
  const repositoryId = newId("repo");
  const storyId = newId("story");
  const conversationId = newId("sess");
  const turnId = newId("turn");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Insights", slug: `insights-${suffix}`, settings: {} },
      { id: otherOrgId, name: "Other", slug: `other-${suffix}`, settings: {} },
    ]);
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Insights",
      slug: `insights-${suffix}`,
      settings: {},
    });
    await db.insert(githubInstallations).values({
      id: installationId,
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
      installationId,
      owner: "acme",
      name: `app-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:17",
      title: "Mirror the delivery pipeline",
      status: "working",
      createdBy: { type: "user", id: "maintainer" },
    });
    await db.insert(storyConversations).values({
      id: conversationId,
      orgId,
      projectId,
      storyId,
    });
    await db.insert(turns).values({
      id: turnId,
      orgId,
      projectId,
      storyId,
      conversationId,
      agentName: "builder",
      manifestHash: "hash",
      manifest: {},
      engine: "codex",
      model: "gpt-5.6-sol",
      state: "succeeded",
      triggerType: "mcp",
      createdBy: { type: "user", id: "maintainer" },
    });
  });

  afterAll(async () => {
    await client.end();
  });

  it("accounts one turn idempotently and blocks later turns after the monthly limit", async () => {
    const costs = new CostBudgetService(db);
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId,
      monthlyLimitCents: 1,
      warningPercent: 50,
      enabled: true,
    });
    const record = {
      orgId,
      projectId,
      storyId,
      turnId,
      agentName: "builder",
      engine: "codex",
      model: "gpt-5.6-sol",
      usage: {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      durationMs: 10,
      status: "succeeded" as const,
    };
    await costs.record(record);
    await costs.record(record);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, turnId))).toHaveLength(1);
    await expect(costs.assertTurnAllowed(orgId, projectId, "gpt-5.6-sol")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await expect(
      costs.assertTurnAllowed(orgId, projectId, "private-unpriced-model"),
    ).rejects.toBeInstanceOf(BudgetPolicyError);
    expect(await costs.budgetState(otherOrgId, projectId)).toMatchObject({
      budget: null,
      spentCents: 0,
    });
  });

  it("mirrors issue, pull request, and CI webhooks into the story pipeline", async () => {
    const mirror = new GithubMirrorService(db, async () => {
      throw new Error("reconciliation is not used in this test");
    });
    const repository = {
      id: 1,
      full_name: `acme/app-${suffix}`,
      name: `app-${suffix}`,
      owner: { login: "acme" },
    };
    await mirror.handleWebhook({
      id: "delivery-issue",
      orgId,
      eventType: "issues",
      payload: {
        action: "opened",
        repository,
        issue: {
          number: 17,
          title: "Mirror the delivery pipeline",
          body: "Acceptance criteria",
          state: "open",
          html_url: "https://github.com/acme/app/issues/17",
          user: { login: "maintainer" },
          labels: [{ name: "feature" }],
          assignees: [{ login: "maintainer" }],
          comments: 2,
          created_at: "2026-09-01T10:00:00Z",
          updated_at: "2026-09-01T11:00:00Z",
        },
      },
    });
    await mirror.handleWebhook({
      id: "delivery-pr",
      orgId,
      eventType: "pull_request",
      payload: {
        action: "opened",
        repository,
        pull_request: {
          number: 23,
          title: "Implement the mirror",
          body: "Closes #17",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/app/pull/23",
          user: { login: "maintainer" },
          head: { ref: "facility/mirror", sha: "a".repeat(40) },
          base: { ref: "main" },
          created_at: "2026-09-01T12:00:00Z",
          updated_at: "2026-09-01T12:00:00Z",
        },
      },
    });
    await mirror.handleWebhook({
      id: "delivery-ci",
      orgId,
      eventType: "workflow_run",
      payload: {
        action: "completed",
        repository,
        workflow_run: {
          name: "verify",
          status: "completed",
          conclusion: "failure",
          head_sha: "a".repeat(40),
          pull_requests: [{ number: 23 }],
        },
      },
    });
    const stale = await mirror.handleWebhook({
      id: "delivery-stale-ci",
      orgId,
      eventType: "workflow_run",
      payload: {
        action: "completed",
        repository,
        workflow_run: {
          name: "stale",
          status: "completed",
          conclusion: "success",
          head_sha: "b".repeat(40),
          pull_requests: [{ number: 23 }],
        },
      },
    });
    expect(stale.ciUpdated).toBe(0);
    expect(
      await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, repositoryId)),
    ).toMatchObject([{ number: 17, labels: ["feature"] }]);
    expect(
      await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.repositoryId, repositoryId)),
    ).toMatchObject([
      { number: 23, closingIssues: [17], ciState: "failure", ciFailureNames: ["verify"] },
    ]);
    expect(
      await db.select().from(githubCiEvents).where(eq(githubCiEvents.repositoryId, repositoryId)),
    ).toHaveLength(1);
    const pipeline = await new GithubPipelineService(db).get(orgId, projectId);
    expect(pipeline.stages.validating).toMatchObject([
      { number: 17, state: "checks_failed", story: { id: storyId } },
    ]);
  });

  it("rejects a mirror row that combines another tenant with this project repository", async () => {
    await expect(
      db.insert(githubIssues).values({
        id: newId("iss"),
        orgId: otherOrgId,
        projectId,
        repositoryId,
        number: 99,
        title: "Cross tenant",
        state: "open",
        htmlUrl: "https://example.invalid/99",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    expect(
      await db
        .select()
        .from(githubIssues)
        .where(and(eq(githubIssues.repositoryId, repositoryId), eq(githubIssues.number, 99))),
    ).toHaveLength(0);

    await expect(
      db.insert(auditEvents).values({
        id: newId("evt"),
        orgId: otherOrgId,
        projectId,
        actor: { type: "user", id: "cross-tenant" },
        action: "cross_tenant.invalid",
        target: { type: "project", id: projectId },
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("recognizes reconciled merged pull requests from merged_at without a merged boolean", async () => {
    const mirror = new GithubMirrorService(db, async () => {
      throw new Error("reconciliation is not used in this test");
    });
    await mirror.handleWebhook({
      id: "delivery-rest-shaped-merged-pr",
      orgId,
      eventType: "pull_request",
      payload: {
        repository: {
          full_name: `acme/app-${suffix}`,
          name: `app-${suffix}`,
          owner: { login: "acme" },
        },
        pull_request: {
          number: 23,
          title: "Implement the mirror",
          body: "Closes #17",
          state: "closed",
          draft: false,
          html_url: "https://github.com/acme/app/pull/23",
          user: { login: "maintainer" },
          head: { ref: "facility/mirror", sha: "a".repeat(40) },
          base: { ref: "main" },
          created_at: "2026-09-01T12:00:00Z",
          updated_at: "2026-09-02T12:00:00Z",
          closed_at: "2026-09-02T12:00:00Z",
          merged_at: "2026-09-02T12:00:00Z",
        },
      },
    });

    expect(
      await db
        .select({ state: githubPullRequests.state })
        .from(githubPullRequests)
        .where(eq(githubPullRequests.repositoryId, repositoryId)),
    ).toContainEqual({ state: "merged" });
    const pipeline = await new GithubPipelineService(db).get(orgId, projectId);
    expect(pipeline.stages.shipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 17, state: "merged" })]),
    );
  });
});

describe("GitHub CI signal parsing", () => {
  it("maps terminal failures and ignores unsupported events", () => {
    expect(
      webhookCiSignal("workflow_run", {
        workflow_run: {
          status: "completed",
          conclusion: "timed_out",
          head_sha: "a".repeat(40),
          pull_requests: [{ number: 4 }],
          name: "test",
        },
      }),
    ).toEqual({
      state: "failure",
      headSha: "a".repeat(40),
      pullNumbers: [4],
      failureNames: ["test"],
    });
    expect(webhookCiSignal("issues", {})).toBeNull();
  });

  it("combines commit statuses and check runs for reconciliation", () => {
    expect(
      restCiSignal(
        { state: "success", statuses: [] },
        {
          check_runs: [
            { name: "unit", status: "completed", conclusion: "success" },
            { name: "browser", status: "completed", conclusion: "failure" },
          ],
        },
      ),
    ).toEqual({ state: "failure", failureNames: ["browser"] });
    expect(
      restCiSignal(
        { state: "success", statuses: [] },
        { check_runs: [{ name: "unit", status: "in_progress", conclusion: null }] },
      ),
    ).toEqual({ state: "pending", failureNames: [] });
  });
});
