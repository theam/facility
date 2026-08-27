import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  analyticsDaily,
  createDb,
  llmRequests,
  migrate,
  outcomes,
  platformIssues,
  projects,
  proposalEvents,
  proposals,
  registryItems,
  registryVersions,
  repos,
  runs,
  seed,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";
import { analyticsOverview, rollupAnalytics } from "../src/watchtower/analytics.js";
import { CANARY_MESSAGE_HASH, collectCanaries } from "../src/watchtower/canary.js";
import type { GitHubClient, WorkflowRun } from "../src/watchtower/github.js";
import { collectGitHubHealth } from "../src/watchtower/github-health.js";
import { projectHealth } from "../src/watchtower/health.js";
import { expireHitlProposals } from "../src/watchtower/hitl.js";
import {
  isActionableSeverity,
  normalizeSeverity,
  raisePlatformIssue,
  resolvePlatformIssue,
} from "../src/watchtower/issues.js";
import { collectOutcomes } from "../src/watchtower/outcomes.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 6).toString("base64");

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

class FakeGitHub implements GitHubClient {
  closedPulls: Awaited<ReturnType<GitHubClient["listClosedPulls"]>> = [];
  commits = new Map<number, Awaited<ReturnType<GitHubClient["listPullCommits"]>>>();
  reviews = new Map<number, Awaited<ReturnType<GitHubClient["listPullReviews"]>>>();
  outcomeEvidence = new Map<number, Awaited<ReturnType<GitHubClient["getOutcomeEvidence"]>>>();
  workflowRuns: WorkflowRun[] = [];
  textFiles = new Map<string, string | null>();

  async listClosedPulls() {
    return this.closedPulls;
  }

  async listPullCommits(_repo: unknown, number: number) {
    return this.commits.get(number) ?? [];
  }

  async listPullReviews(_repo: unknown, number: number) {
    return this.reviews.get(number) ?? [];
  }

  async getOutcomeEvidence(_repo: unknown, number: number) {
    const evidence = this.outcomeEvidence.get(number);
    if (!evidence) throw new Error(`missing outcome evidence for PR ${number}`);
    return evidence;
  }

  async listWorkflowRuns() {
    return this.workflowRuns;
  }

  async readTextFile(_repo: unknown, path: string) {
    return this.textFiles.get(path) ?? null;
  }
}

describe("watchtower", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; watchtower tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4402,
    publicUrl: "http://localhost:4402",
    sandboxApiUrl: "http://localhost:4402",
    sandboxGatewayUrl: "http://localhost:4410",
    gatewayUrl: "http://localhost:4410",
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

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `watchtower-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("ports outcome math for terminal agent PRs", async () => {
    const project = await insertProject({ watchtower: { branchPrefixes: ["claude/", "codex/"] } });
    await insertRepo(project.id, "outcomes");
    const github = new FakeGitHub();
    const now = new Date();
    github.closedPulls = [
      {
        number: 10,
        user: { login: "human" },
        head: { ref: "claude/feature" },
        created_at: new Date(now.getTime() - 5 * 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: now.toISOString(),
      },
      {
        number: 11,
        user: { login: "human" },
        head: { ref: "codex/fix" },
        created_at: new Date(now.getTime() - 3 * 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: null,
      },
      {
        number: 12,
        user: { login: "human" },
        head: { ref: "codex/merge-commit" },
        created_at: new Date(now.getTime() - 3 * 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: now.toISOString(),
      },
      {
        number: 13,
        user: { login: "human" },
        head: { ref: "codex/bot-merged" },
        created_at: new Date(now.getTime() - 3 * 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: now.toISOString(),
      },
      {
        number: 14,
        user: { login: "human" },
        head: { ref: "codex/ambiguous-method" },
        created_at: new Date(now.getTime() - 3 * 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: now.toISOString(),
      },
    ];
    github.commits.set(10, [{ author: { login: "codex[bot]" } }]);
    github.commits.set(11, [{ author: { login: "codex[bot]" } }, { author: { login: "adrian" } }]);
    github.commits.set(12, [{ author: { login: "codex[bot]" } }]);
    github.commits.set(13, [{ author: { login: "codex[bot]" } }]);
    github.commits.set(14, [{ author: { login: "codex[bot]" } }]);
    github.reviews.set(11, [{ state: "CHANGES_REQUESTED" }]);
    github.outcomeEvidence.set(10, {
      mergedBy: { login: "reviewer", type: "User" },
      mergeCommitParentCount: 1,
      closingIssues: [
        { number: 7, createdAt: new Date(now.getTime() - 22 * 3600_000).toISOString() },
      ],
      mergePolicy: {
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        squashMergeAllowed: true,
      },
    });
    github.outcomeEvidence.set(12, {
      mergedBy: { login: "reviewer", type: "User" },
      mergeCommitParentCount: 2,
      closingIssues: [],
      mergePolicy: {
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        squashMergeAllowed: true,
      },
    });
    github.outcomeEvidence.set(13, {
      mergedBy: { login: "merge-queue[bot]", type: "Bot" },
      mergeCommitParentCount: 1,
      closingIssues: [],
      mergePolicy: {
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        squashMergeAllowed: true,
      },
    });
    github.outcomeEvidence.set(14, {
      mergedBy: { login: "reviewer", type: "User" },
      mergeCommitParentCount: 1,
      closingIssues: [],
      mergePolicy: {
        mergeCommitAllowed: false,
        rebaseMergeAllowed: true,
        squashMergeAllowed: true,
      },
    });
    await collectOutcomes(db, github);
    const rows = await db
      .select()
      .from(outcomes)
      .where(eq(outcomes.projectId, project.id))
      .orderBy(outcomes.prNumber);
    expect(rows.map((row) => row.fate)).toEqual(["merged", "closed", "merged", "merged", "merged"]);
    expect(rows[0]?.reviewRounds).toBe(0);
    expect(rows[0]?.fixupCommits).toBe(0);
    expect(rows[0]).toMatchObject({
      accepted: true,
      issueNumber: 7,
      mergedBy: "reviewer",
      mergerType: "User",
      mergeMethod: "squash",
    });
    expect(Number(rows[0]?.hoursIssueToMerge)).toBe(22);
    expect(rows[1]?.accepted).toBe(false);
    expect(rows[1]?.reviewRounds).toBe(1);
    expect(rows[1]?.fixupCommits).toBe(1);
    expect(rows[2]).toMatchObject({ accepted: false, mergeMethod: "merge" });
    expect(rows[3]).toMatchObject({
      accepted: false,
      mergeMethod: "squash",
      mergerType: "Bot",
    });
    expect(rows[4]).toMatchObject({ accepted: null, mergeMethod: "unverified" });
  });

  it("keeps merged outcomes unassessed when GitHub cannot prove acceptance", async () => {
    const project = await insertProject({ watchtower: { branchPrefixes: ["codex/"] } });
    await insertRepo(project.id, "unassessed-outcomes");
    const github = new FakeGitHub();
    const now = new Date();
    github.closedPulls = [
      {
        number: 12,
        user: { login: "human" },
        head: { ref: "codex/ambiguous" },
        created_at: new Date(now.getTime() - 3600_000).toISOString(),
        closed_at: now.toISOString(),
        merged_at: now.toISOString(),
      },
    ];
    github.commits.set(12, [{ author: { login: "codex[bot]" } }]);

    await collectOutcomes(db, github);

    const outcome = (
      await db.select().from(outcomes).where(eq(outcomes.projectId, project.id)).limit(1)
    )[0];
    expect(outcome).toMatchObject({ fate: "merged", accepted: null, mergeMethod: null });
    const issue = (
      await db
        .select()
        .from(platformIssues)
        .where(
          and(
            eq(platformIssues.projectId, project.id),
            eq(platformIssues.kind, "integration_error"),
          ),
        )
        .limit(1)
    )[0];
    expect(issue?.title).toContain("Outcome evidence unavailable");
    const afterFailure = (
      await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
    )[0];
    expect(
      (afterFailure?.settings as { watchtower?: { outcomesLastRunAt?: string } }).watchtower
        ?.outcomesLastRunAt,
    ).toBeUndefined();

    await db
      .update(outcomes)
      .set({
        accepted: true,
        mergedBy: "prior-reviewer",
        mergerType: "User",
        mergeMethod: "squash",
      })
      .where(eq(outcomes.id, outcome?.id ?? ""));
    await collectOutcomes(db, github);
    const preserved = (
      await db
        .select()
        .from(outcomes)
        .where(eq(outcomes.id, outcome?.id ?? ""))
        .limit(1)
    )[0];
    expect(preserved).toMatchObject({
      accepted: true,
      mergedBy: "prior-reviewer",
      mergerType: "User",
      mergeMethod: "squash",
    });
  });

  it("clears a stale rejection when a closed PR is reopened and merged without evidence", async () => {
    const project = await insertProject({ watchtower: { branchPrefixes: ["codex/"] } });
    await insertRepo(project.id, "reopened-outcome");
    const github = new FakeGitHub();
    const openedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    github.closedPulls = [
      {
        number: 15,
        user: { login: "human" },
        head: { ref: "codex/reopened" },
        created_at: openedAt,
        closed_at: new Date().toISOString(),
        merged_at: null,
      },
    ];
    github.commits.set(15, [{ author: { login: "codex[bot]" } }]);

    await collectOutcomes(db, github);
    expect(
      (
        await db
          .select()
          .from(outcomes)
          .where(and(eq(outcomes.projectId, project.id), eq(outcomes.prNumber, 15)))
          .limit(1)
      )[0],
    ).toMatchObject({ fate: "closed", accepted: false });

    const mergedAt = new Date(Date.now() + 60_000).toISOString();
    const reopenedPr = github.closedPulls[0];
    if (!reopenedPr) throw new Error("reopened PR fixture missing");
    github.closedPulls = [
      {
        ...reopenedPr,
        closed_at: mergedAt,
        merged_at: mergedAt,
      },
    ];
    await collectOutcomes(db, github);
    expect(
      (
        await db
          .select()
          .from(outcomes)
          .where(and(eq(outcomes.projectId, project.id), eq(outcomes.prNumber, 15)))
          .limit(1)
      )[0],
    ).toMatchObject({ fate: "merged", accepted: null });
  });

  it("dedupes, resolves, and reopens platform issues by fingerprint", async () => {
    const project = await insertProject();
    const fingerprint = `test:${project.id}`;
    await raisePlatformIssue(db, {
      orgId,
      projectId: project.id,
      kind: "run_failure",
      severity: "error",
      fingerprint,
      title: "first",
      bodyMd: "first",
    });
    await raisePlatformIssue(db, {
      orgId,
      projectId: project.id,
      kind: "run_failure",
      severity: "error",
      fingerprint,
      title: "second",
      bodyMd: "second",
    });
    await resolvePlatformIssue(db, orgId, fingerprint, "recovered");
    await raisePlatformIssue(db, {
      orgId,
      projectId: project.id,
      kind: "run_failure",
      severity: "error",
      fingerprint,
      title: "again",
      bodyMd: "again",
    });
    const issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue?.state).toBe("open");
    expect(issue?.count).toBe(3);
  });

  it("detects GitHub health budget breaches and auto-resolves recovery", async () => {
    const project = await insertProject();
    const repo = await insertRepo(project.id, "health");
    const github = new FakeGitHub();
    github.textFiles.set(
      ".github/facility/watchtower/budgets.json",
      JSON.stringify({ maxDailyFailures: { "facility-crew": 2 } }),
    );
    github.workflowRuns = [
      failureRun("facility-crew", 1),
      failureRun("facility-crew", 2),
      failureRun("facility-crew", 3),
    ];
    await collectGitHubHealth(db, github);
    const fingerprint = `run_failure:${repo.id}:facility-crew:24h`;
    let issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue?.state).toBe("open");
    await expect(projectHealth(db, orgId, project.id)).resolves.toMatchObject({
      status: "red",
      classification: "unhealthy",
    });
    github.workflowRuns = [];
    await collectGitHubHealth(db, github);
    issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue?.state).toBe("resolved");
    await expect(projectHealth(db, orgId, project.id)).resolves.toMatchObject({
      status: "ok",
      classification: "healthy",
    });
    // Two full collectGitHubHealth passes over real Postgres; give it headroom
    // beyond vitest's 5s default so it is not a load-sensitive flake.
  }, 20_000);

  it("handles platform and repo canary paths", async () => {
    const platformProject = await insertProject({
      watchtower: { canary: { enabled: true, lane: "platform" } },
    });
    await insertAgent(platformProject.id, "Architect Canary");
    const dispatched: Record<string, unknown>[] = [];
    await collectCanaries(db, new FakeGitHub(), (queue, data) => {
      dispatched.push({ queue, ...data });
      return Promise.resolve();
    });
    expect(dispatched[0]?.queue).toBe("runs.dispatch");
    const canaryRun = (
      await db.select().from(runs).where(eq(runs.projectId, platformProject.id)).limit(1)
    )[0];
    expect((canaryRun?.trigger as { messageHash?: string }).messageHash).toBe(CANARY_MESSAGE_HASH);
    await db
      .update(runs)
      .set({
        status: "succeeded",
        receipt: { ok: true },
        gh: { canaryAck: true },
        endedAt: new Date(),
      })
      .where(eq(runs.id, canaryRun?.id ?? ""));
    await collectCanaries(db, new FakeGitHub());

    const repoProject = await insertProject({
      watchtower: { canary: { enabled: true, lane: "repo" } },
    });
    await insertRepo(repoProject.id, "canary");
    const github = new FakeGitHub();
    github.workflowRuns = [
      { id: 1, name: "facility-canary", status: "completed", conclusion: "success" },
    ];
    await collectCanaries(db, github);
    github.workflowRuns = [];
    await collectCanaries(db, github);
    const repoIssue = (
      await db
        .select()
        .from(platformIssues)
        .where(
          and(
            eq(platformIssues.projectId, repoProject.id),
            eq(platformIssues.kind, "canary_failure"),
          ),
        )
        .limit(1)
    )[0];
    expect(repoIssue?.state).toBe("open");
  });

  it("preserves optional canary agent selection and gates a required dual-role fallback", async () => {
    const configuredProject = await insertProject({
      watchtower: { canary: { enabled: true, lane: "platform" } },
    });
    const configuredAgent = await insertAgent(configuredProject.id, "Configured Probe");
    await db
      .update(projects)
      .set({
        settings: {
          watchtower: {
            canary: { enabled: true, lane: "platform", agentDefId: configuredAgent.id },
          },
        },
      })
      .where(eq(projects.id, configuredProject.id));
    await collectCanaries(db, new FakeGitHub(), async () => undefined);
    expect(
      (await db.select().from(runs).where(eq(runs.projectId, configuredProject.id)).limit(1))[0],
    ).toMatchObject({ agentDefId: configuredAgent.id, mode: "architect", status: "queued" });

    const fallbackProject = await insertProject({
      watchtower: { canary: { enabled: true, lane: "platform" } },
    });
    const fallbackAgent = await insertAgent(fallbackProject.id, "Legacy Probe");
    await collectCanaries(db, new FakeGitHub(), async () => undefined);
    expect(
      (await db.select().from(runs).where(eq(runs.projectId, fallbackProject.id)).limit(1))[0],
    ).toMatchObject({ agentDefId: fallbackAgent.id, mode: "architect", status: "queued" });

    const requiredProject = await insertProject({
      watchtower: { canary: { enabled: true, lane: "platform" } },
    });
    const dualRoleAgent = await insertAgent(requiredProject.id, "Legacy Dual Role Probe");
    await db
      .update(agentDefs)
      .set({ triggers: [{ type: "command", handle: "/builder" }] })
      .where(eq(agentDefs.id, dualRoleAgent.id));
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, requiredProject.id));
    const dispatched: Record<string, unknown>[] = [];
    await collectCanaries(db, new FakeGitHub(), async (queue, data) => {
      dispatched.push({ queue, ...data });
    });
    expect(await db.select().from(runs).where(eq(runs.projectId, requiredProject.id))).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(
      (
        await db
          .select()
          .from(platformIssues)
          .where(
            and(
              eq(platformIssues.projectId, requiredProject.id),
              eq(platformIssues.kind, "canary_failure"),
            ),
          )
          .limit(1)
      )[0],
    ).toMatchObject({ state: "open", title: "Canary agent blocked by Builder plan policy" });
  });

  it("rolls up analytics idempotently and serves rollup-backed endpoints", async () => {
    const project = await insertProject();
    const agent = await insertAgent(project.id, "Builder");
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: project.id,
          agentDefId: agent.id,
          mode: "builder",
          engine: "codex",
          status: "succeeded",
          trigger: {},
          receipt: { ok: true },
          createdBy: { type: "system", name: "test" },
        })
        .returning()
    )[0];
    await db.insert(llmRequests).values({
      id: newId("evt"),
      orgId,
      projectId: project.id,
      runId: run?.id,
      provider: "openai",
      model: "gpt-5.5",
      status: "ok",
      inputTokens: 10,
      outputTokens: 20,
      costCents: 55,
      latencyMs: 1,
    });
    await db.insert(outcomes).values({
      id: newId("evt"),
      orgId,
      projectId: project.id,
      repo: `theam/rollup-${project.id}`,
      prNumber: 1,
      agentLane: "codex",
      openedAt: new Date(Date.now() - 3600_000),
      terminalAt: new Date(),
      fate: "merged",
      accepted: true,
    });
    await db.insert(outcomes).values({
      id: newId("evt"),
      orgId,
      projectId: project.id,
      repo: "theam/rollup",
      prNumber: Number(String(Date.now()).slice(-6)) + 1,
      agentLane: "codex",
      openedAt: new Date(Date.now() - 3600_000),
      terminalAt: new Date(),
      fate: "merged",
      accepted: false,
      reviewRounds: 1,
    });
    await rollupAnalytics(db);
    const firstCount = await db
      .select()
      .from(analyticsDaily)
      .where(eq(analyticsDaily.projectId, project.id));
    await rollupAnalytics(db);
    const secondCount = await db
      .select()
      .from(analyticsDaily)
      .where(eq(analyticsDaily.projectId, project.id));
    expect(secondCount.length).toBe(firstCount.length);
    const analytics = await app.inject({
      method: "GET",
      url: `/v1/analytics?projectId=${project.id}&groupBy=model`,
      headers: { cookie },
    });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().some((row: { bucket: string }) => row.bucket === "gpt-5.5")).toBe(true);
    expect(
      analytics.json().find((row: { bucket: string }) => row.bucket === "outcomes"),
    ).toMatchObject({ outcomesAssessed: 2, outcomesAccepted: 1, acceptance: 50 });
    const projectOverview = await analyticsOverview(db, orgId, project.id);
    expect(projectOverview.outcomes30d).toMatchObject({ total: 2, assessed: 2, accepted: 1 });
    expect(projectOverview.oneShot30d).toBe(50);
    const overview = await app.inject({
      method: "GET",
      url: "/v1/analytics/overview",
      headers: { cookie },
    });
    expect(overview.json().spendMtdCents).toBeGreaterThanOrEqual(55);
    expect(overview.json().outcomes30d).toMatchObject({
      total: expect.any(Number),
      assessed: expect.any(Number),
      accepted: expect.any(Number),
      merged: expect.any(Number),
    });
  });

  it("incremental rollup rebuilds only the trailing window and preserves older days", async () => {
    const project = await insertProject();
    const agent = await insertAgent(project.id, "Windowed");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000);
    const oldDay = thirtyDaysAgo.toISOString().slice(0, 10);
    await db.insert(runs).values({
      id: newId("run"),
      orgId,
      projectId: project.id,
      agentDefId: agent.id,
      mode: "builder",
      engine: "codex",
      status: "succeeded",
      trigger: {},
      createdBy: { type: "system", name: "test" },
      queuedAt: thirtyDaysAgo,
      createdAt: thirtyDaysAgo,
    });

    // A full backfill materializes the 30-day-old day.
    await rollupAnalytics(db, { sinceDays: 3650 });
    const afterFull = await db
      .select()
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.projectId, project.id), eq(analyticsDaily.day, oldDay)));
    expect(afterFull.length).toBeGreaterThan(0);
    expect(afterFull[0]?.runsStarted).toBe(1);

    // The default narrow window must neither delete nor rebuild that old day —
    // its predicate range excludes anything older than a few days.
    await rollupAnalytics(db, { sinceDays: 3 });
    const afterNarrow = await db
      .select()
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.projectId, project.id), eq(analyticsDaily.day, oldDay)));
    expect(afterNarrow.length).toBe(afterFull.length);
    expect(afterNarrow[0]?.runsStarted).toBe(1);
  });

  it("surfaces error issues in inbox while keeping items as proposals", async () => {
    const project = await insertProject();
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `watchtower_action_${Date.now()}`,
          payloadSchema: { type: "object" },
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
          projectId: project.id,
          actionTypeId: type?.id ?? "",
          payload: {},
          contextMd: "ctx",
          expiresAt: new Date(Date.now() - 1000),
        })
        .returning()
    )[0];
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal?.id ?? "",
      seq: 1,
      type: "open",
      actor: { type: "system" },
      data: {},
    });
    await raisePlatformIssue(db, {
      orgId,
      projectId: project.id,
      kind: "canary_failure",
      severity: "error",
      fingerprint: `inbox:${project.id}`,
      title: "Canary failed",
      bodyMd: "failed",
    });
    const inbox = await app.inject({ method: "GET", url: "/v1/inbox", headers: { cookie } });
    expect(inbox.json().items.length).toBeGreaterThan(0);
    expect(inbox.json().proposals.length).toBe(inbox.json().items.length);
    expect(
      inbox.json().issues.some((issue: { title: string }) => issue.title === "Canary failed"),
    ).toBe(true);
    await expireHitlProposals(db);
    const expired = (
      await db
        .select()
        .from(proposals)
        .where(eq(proposals.id, proposal?.id ?? ""))
        .limit(1)
    )[0];
    expect(expired?.state).toBe("expired");
  });

  it("normalizes legacy severities to the canonical actionable ladder", () => {
    expect(normalizeSeverity("high")).toBe("error");
    expect(normalizeSeverity("medium")).toBe("warn");
    expect(normalizeSeverity("critical")).toBe("critical");
    expect(normalizeSeverity("whatever")).toBe("info");
    // Case-insensitive: external producers may send upper-case severities.
    expect(normalizeSeverity("ERROR")).toBe("error");
    expect(normalizeSeverity("Critical")).toBe("critical");
    expect(isActionableSeverity("high")).toBe(true);
    expect(isActionableSeverity("warn")).toBe(false);
  });

  it("keeps acknowledged issues in the inbox and forbids un-resolving via ack", async () => {
    const project = await insertProject();
    await raisePlatformIssue(db, {
      orgId,
      projectId: project.id,
      kind: "canary_failure",
      severity: "error",
      fingerprint: `ackflow:${project.id}`,
      title: "Ack flow",
      bodyMd: "boom",
    });
    const issueId = (
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, `ackflow:${project.id}`))
        .limit(1)
    )[0]?.id;

    const acked = await app.inject({
      method: "POST",
      url: `/v1/issues/${issueId}/ack`,
      headers: { cookie },
    });
    expect(acked.statusCode).toBe(200);

    // Acknowledged but unresolved: still visible in the inbox (state=open query).
    const inbox = await app.inject({
      method: "GET",
      url: "/v1/inbox?state=open",
      headers: { cookie },
    });
    expect(inbox.json().issues.some((i: { id: string; state: string }) => i.id === issueId)).toBe(
      true,
    );

    const resolved = await app.inject({
      method: "POST",
      url: `/v1/issues/${issueId}/resolve`,
      headers: { cookie },
    });
    expect(resolved.statusCode).toBe(200);
    // A resolved issue cannot be pushed back to active via ack.
    const reAck = await app.inject({
      method: "POST",
      url: `/v1/issues/${issueId}/ack`,
      headers: { cookie },
    });
    expect(reAck.statusCode).toBe(409);
  });

  it("keeps GitHub health collection independent from telemetry reads", async () => {
    const source = await readFile(join(process.cwd(), "src/watchtower/github-health.ts"), "utf8");
    expect(source).not.toContain("llmRequests");
    expect(source).not.toContain("llm_requests");
    expect(source).not.toContain("receipts");
  });

  async function insertProject(settings: Record<string, unknown> = {}) {
    return required(
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: `Watchtower ${Date.now()} ${Math.random()}`,
          slug: `watchtower-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          settings,
        })
        .returning(),
    );
  }

  async function insertRepo(projectId: string, name: string) {
    return required(
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId,
          owner: "theam",
          name: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          defaultBranch: "main",
        })
        .returning(),
    );
  }

  async function insertAgent(projectId: string, name: string) {
    const item = required(
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `${name}-${Date.now()}`,
          latestVersion: 1,
        })
        .returning(),
    );
    await db.insert(registryVersions).values({
      id: newId("ver"),
      orgId,
      itemId: item.id,
      version: 1,
      content: "test",
      contentHash: "test",
      status: "active",
    });
    return required(
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name,
          engine: "codex",
          model: { name: "gpt-5.5" },
          contractItemId: item.id,
        })
        .returning(),
    );
  }
});

function failureRun(name: string, id: number): WorkflowRun {
  return {
    id,
    name,
    status: "completed",
    conclusion: "failure",
    html_url: `https://example.test/${id}`,
  };
}

function required<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected row");
  return row;
}
