import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  auditEvents,
  createDb,
  githubBranches,
  githubChecks,
  githubCiEvents,
  githubInstallations,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  migrate,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  stories,
  storyConversations,
  storyEvidenceEvents,
  turnGitEvidence,
  turns,
  turnUsage,
  workspaces,
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
  const workspaceId = newId("ws");

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
      branch: "facility/mirror",
      createdBy: { type: "user", id: "maintainer" },
    });
    await db.insert(storyConversations).values({
      id: conversationId,
      orgId,
      projectId,
      storyId,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      projectId,
      storyId,
      provider: "fake",
      volumeRef: `memory://${workspaceId}`,
      state: "running",
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
    await db.insert(turnGitEvidence).values({
      turnId,
      orgId,
      projectId,
      storyId,
      workspaceId,
      engineSessionId: newId("esess"),
      initialBranch: "facility/mirror",
      initialSha: "0".repeat(40),
      finalBranch: "facility/mirror",
      finalSha: "a".repeat(40),
      completedAt: new Date("2026-09-01T11:59:00Z"),
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
      id: "delivery-branch",
      orgId,
      eventType: "push",
      payload: {
        repository,
        ref: "refs/heads/facility/mirror",
        after: "a".repeat(40),
      },
    });
    await mirror.handleWebhook({
      id: "delivery-review",
      orgId,
      eventType: "pull_request_review",
      payload: {
        repository,
        pull_request: {
          number: 23,
          title: "Implement the mirror",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/app/pull/23",
          head: { ref: "facility/mirror", sha: "a".repeat(40) },
          base: { ref: "main" },
        },
        review: {
          id: 99,
          state: "approved",
          body: "Looks good.",
          html_url: "https://github.com/acme/app/pull/23#pullrequestreview-99",
          commit_id: "a".repeat(40),
          submitted_at: "2026-09-01T12:15:00Z",
          user: { login: "reviewer" },
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
    await mirror.handleWebhook({
      id: "delivery-check",
      orgId,
      eventType: "check_run",
      payload: {
        repository,
        check_run: {
          id: 101,
          name: "verify",
          status: "completed",
          conclusion: "failure",
          head_sha: "a".repeat(40),
          details_url: "https://github.com/acme/app/actions/runs/101",
          started_at: "2026-09-01T12:01:00Z",
          completed_at: "2026-09-01T12:10:00Z",
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
    expect(
      await db.select().from(githubBranches).where(eq(githubBranches.repositoryId, repositoryId)),
    ).toMatchObject([{ name: "facility/mirror", headSha: "a".repeat(40), deletedAt: null }]);
    expect(
      await db
        .select()
        .from(githubPullRequestReviews)
        .where(eq(githubPullRequestReviews.repositoryId, repositoryId)),
    ).toMatchObject([{ pullNumber: 23, reviewId: "99", state: "approved" }]);
    expect(
      await db.select().from(githubChecks).where(eq(githubChecks.repositoryId, repositoryId)),
    ).toMatchObject([{ pullNumber: 23, checkId: "101", conclusion: "failure" }]);
    expect(
      await db
        .select({ type: storyEvidenceEvents.type, turnId: storyEvidenceEvents.turnId })
        .from(storyEvidenceEvents)
        .where(eq(storyEvidenceEvents.storyId, storyId)),
    ).toEqual(
      expect.arrayContaining([
        { type: "github.pull_request_observed", turnId },
        { type: "github.branch_observed", turnId },
        { type: "github.review_observed", turnId },
        { type: "github.check_observed", turnId },
      ]),
    );
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

  it("periodically reconciles external branch, review, and check changes", async () => {
    const externalSha = "c".repeat(40);
    const mirror = new GithubMirrorService(db, async () => ({
      request: async (route: string) => {
        if (route.endsWith("/branches")) {
          return {
            data: [
              { name: "main", protected: true, commit: { sha: "d".repeat(40) } },
              { name: "facility/mirror", protected: false, commit: { sha: externalSha } },
            ],
          };
        }
        if (route.endsWith("/issues")) return { data: [] };
        if (route.endsWith("/pulls")) {
          return {
            data: [
              {
                number: 23,
                title: "Implement the mirror",
                body: "Closes #17",
                state: "open",
                draft: false,
                html_url: "https://github.com/acme/app/pull/23",
                user: { login: "maintainer" },
                head: { ref: "facility/mirror", sha: externalSha },
                base: { ref: "main" },
                updated_at: "2026-09-03T10:00:00Z",
              },
            ],
          };
        }
        if (route.includes("/reviews")) {
          return {
            data: [
              {
                id: 200,
                state: "changes_requested",
                body: "Please add a regression test.",
                html_url: "https://github.com/acme/app/pull/23#pullrequestreview-200",
                commit_id: externalSha,
                submitted_at: "2026-09-03T10:05:00Z",
                user: { login: "reviewer" },
              },
            ],
          };
        }
        if (route.endsWith("/status")) return { data: { state: "pending", statuses: [] } };
        if (route.endsWith("/check-runs")) {
          return {
            data: {
              check_runs: [
                {
                  id: 201,
                  name: "verify",
                  status: "in_progress",
                  conclusion: null,
                  head_sha: externalSha,
                  details_url: "https://github.com/acme/app/actions/runs/201",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected GitHub route ${route}`);
      },
      rest: {} as never,
    }));

    await expect(mirror.syncProject(orgId, projectId)).resolves.toMatchObject({
      repositories: 1,
      branches: 2,
      reviews: 1,
      checks: 1,
    });
    const externalEvidence = await db
      .select()
      .from(storyEvidenceEvents)
      .where(
        and(
          eq(storyEvidenceEvents.storyId, storyId),
          eq(storyEvidenceEvents.type, "github.branch_observed"),
        ),
      );
    expect(externalEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: null,
          data: expect.objectContaining({ actor: "external", headSha: externalSha }),
        }),
      ]),
    );
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
