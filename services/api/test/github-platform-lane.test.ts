import { generateApiKey, hashKey, newId } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  apiKeys,
  auditEvents,
  createDb,
  ghCiEvents,
  ghIssues,
  ghPullRequests,
  githubInstallations,
  inboundEvents,
  integrations,
  migrate,
  orgs,
  outcomes,
  platformIssues,
  previewSandboxes,
  projects,
  proposalEvents,
  proposals,
  registryItems,
  repos,
  runDeliveries,
  runEvents,
  runs,
  schedulerWatermarks,
  seed,
  userIdentities,
} from "@facility/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { executeApprovedProposal } from "../src/executors.js";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import { pullRequestBodyForIssue } from "../src/github/closing-issues.js";
import { githubIssueRevisionSha256 } from "../src/github/issue-revision.js";
import { syncRepoIssues, upsertGhIssueFromWebhook } from "../src/github/issues-sync.js";
import {
  enqueueGithubIssuesSync,
  processGithubWebhook,
  processGithubWebhookBatch,
} from "../src/github/processor.js";
import {
  syncRepoPullRequests,
  upsertGhPullRequestFromWebhook,
} from "../src/github/pull-requests-sync.js";
import { reconcilePreviews } from "../src/previews.js";
import { deliverPendingRunDeliveries } from "../src/sandbox/delivery.js";
import {
  finishRun,
  publishRunDelivery,
  RunDeliveryLeaseLostError,
  reconcileArchitectPlanPublications,
} from "../src/sandbox/orchestrator.js";
import type { AppConfig } from "../src/types.js";
import { expireHitlProposals } from "../src/watchtower/hitl.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const masterKey = Buffer.alloc(32, 10).toString("base64");
let installationSequence = Date.now() * 1000;

function nextInstallationId() {
  installationSequence += 1;
  return installationSequence;
}

type IssueBackfillRecord = {
  number: number;
  pull_request: Record<string, never>;
  updated_at: string;
};

type IssueBackfillCall = { page: number; since: string | undefined; numbers: number[] };

function issueBackfillRecords(count: number): IssueBackfillRecord[] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    number: 1_001 + index,
    pull_request: {},
    updated_at: new Date(start + index * 1_000).toISOString(),
  }));
}

function issueBackfillFactory(
  records: IssueBackfillRecord[],
  calls: IssueBackfillCall[],
  failure?: () => Error | null,
) {
  return async () =>
    ({
      rest: {
        issues: {
          listForRepo: async (args: Record<string, unknown>) => {
            const page = Number(args.page ?? 1);
            const perPage = Number(args.per_page ?? 100);
            const since = typeof args.since === "string" ? args.since : undefined;
            const lowerBound = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
            const eligible = [...records]
              .filter((record) => Date.parse(record.updated_at) > lowerBound)
              .sort(
                (left, right) =>
                  Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
                  left.number - right.number,
              );
            const data = eligible.slice((page - 1) * perPage, page * perPage);
            calls.push({ page, since, numbers: data.map((record) => record.number) });
            const error = failure?.();
            if (error) throw error;
            return { data };
          },
        },
      },
    }) as never;
}

describe("pull-request closing references", () => {
  it("injects one authoritative same-repository issue reference", () => {
    expect(pullRequestBodyForIssue("Implementation details", 17, "octo", "repo")).toBe(
      "Closes #17\n\nImplementation details",
    );
  });

  it.each([
    "Fixes #17\n\nDetails",
    "Resolved octo/repo#17",
    "Closes https://github.com/octo/repo/issues/17",
  ])("preserves an existing GitHub closing form: %s", (body) => {
    expect(pullRequestBodyForIssue(body, 17, "octo", "repo")).toBe(body);
  });

  it("ignores apparent closing references inside code fences and inline code", () => {
    const fenced = "Example:\n```md\nCloses #17\n```\nAnd `Fixes #17`.";
    expect(pullRequestBodyForIssue(fenced, 17, "octo", "repo")).toBe(`Closes #17\n\n${fenced}`);
  });
});

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

function repositoryApiWithoutFacilityManifest() {
  return {
    getContent: async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    },
  };
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
  let projectId = "";
  let userId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `gh-platform-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    userId = login.json().userId;
    await db.insert(userIdentities).values({
      id: `identity_platform_${Date.now()}`,
      userId,
      provider: "github",
      providerSubject: `platform-${Date.now()}`,
      login: "platform-owner",
    });
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

  it("upserts mirrored pull requests from webhooks with cross-org isolation", async () => {
    const owner = `mirror-pr-${Date.now()}`;
    const name = "repo";
    const otherOrgId = newId("org");
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Other PR", slug: `other-pr-${Date.now()}` });
    const otherProjectId = newId("proj");
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: otherOrgId,
      name: "Other PR Project",
      slug: `other-pr-${Date.now()}`,
      settings: {},
    });
    const repo = await insertRepo({ owner, name });
    const otherRepo = await insertRepo({
      orgId: otherOrgId,
      projectId: otherProjectId,
      owner,
      name,
    });

    const mirrored = await upsertGhPullRequestFromWebhook(db, orgId, {
      action: "opened",
      repository: { owner: { login: owner }, name },
      pull_request: {
        number: 8,
        title: "Mirror this pull request",
        state: "open",
        draft: false,
        user: { login: "ada" },
        html_url: `https://github.com/${owner}/${name}/pull/8`,
        body: "body",
        base: { ref: "main" },
        head: { ref: "feature/8", sha: "head-8" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    });

    expect(mirrored).toMatchObject({ orgId, projectId, repoId: repo.id, number: 8 });
    expect(
      await db.select().from(ghPullRequests).where(eq(ghPullRequests.repoId, repo.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(ghPullRequests).where(eq(ghPullRequests.repoId, otherRepo.id)),
    ).toHaveLength(0);
  });

  it("rejects malformed and unmapped pull-request webhook payloads without writing", async () => {
    const owner = `invalid-pr-${Date.now()}`;
    const repo = await insertRepo({ owner, name: "repo" });
    const pullRequest = {
      number: 9,
      title: "Valid except where overridden",
      state: "open",
      draft: false,
      user: { login: "ada" },
      html_url: `https://github.com/${owner}/${repo.name}/pull/9`,
      body: "body",
      base: { ref: "main" },
      head: { ref: "feature/9", sha: "head-9" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };

    await expect(
      upsertGhPullRequestFromWebhook(db, orgId, {
        repository: { owner: { login: owner }, name: repo.name },
        pull_request: { ...pullRequest, head: { ref: "feature/9" } },
      }),
    ).resolves.toBeNull();
    await expect(
      upsertGhPullRequestFromWebhook(db, orgId, {
        repository: { owner: { login: `${owner}-missing` }, name: repo.name },
        pull_request: pullRequest,
      }),
    ).resolves.toBeNull();
    await expect(
      upsertGhPullRequestFromWebhook(db, orgId, {
        repository: { name: repo.name },
        pull_request: pullRequest,
      }),
    ).resolves.toBeNull();
    await expect(
      upsertGhPullRequestFromWebhook(db, orgId, {
        repository: { owner: { login: owner } },
        pull_request: pullRequest,
      }),
    ).resolves.toBeNull();
    await expect(
      upsertGhPullRequestFromWebhook(db, orgId, {
        repository: { owner: { login: owner }, name: repo.name },
      }),
    ).resolves.toBeNull();
    expect(
      await db.select().from(ghPullRequests).where(eq(ghPullRequests.repoId, repo.id)),
    ).toHaveLength(0);
  });

  it("uses a backfill-owned GitHub update cursor and exhaustively reconciles every PR state", async () => {
    const owner = `sync-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    await db.insert(ghIssues).values({
      id: newId("ghi"),
      orgId,
      projectId,
      repoId: repo.id,
      number: 70_001,
      title: "Cursor anchor",
      state: "closed",
      labels: [],
      assignees: [],
      htmlUrl: `https://github.test/${owner}/repo/issues/70001`,
      // Webhooks may write rows newer than the completed backfill. They must
      // not move the cursor owned by the backfill itself.
      ghUpdatedAt: new Date("2026-08-05T10:00:00Z"),
      syncedAt: new Date("2026-08-05T10:00:00Z"),
    });
    await db.insert(schedulerWatermarks).values({
      name: `github.issues:${repo.id}`,
      lastTick: new Date("2026-01-10T10:00:00Z"),
    });
    let issueListArgs: Record<string, unknown> | undefined;
    await syncRepoIssues(
      db,
      async () =>
        ({
          rest: {
            issues: {
              listForRepo: async (args: Record<string, unknown>) => {
                issueListArgs = args;
                return { data: [] };
              },
            },
          },
        }) as never,
      repo,
    );
    expect(issueListArgs).toMatchObject({
      since: "2026-01-10T09:58:00.000Z",
      sort: "updated",
      direction: "asc",
    });

    const calls: Array<{ cursor: unknown; states: unknown }> = [];
    const node = (number: number, state: "OPEN" | "CLOSED" | "MERGED", updatedAt: string) => ({
      number,
      title: `PR ${number}`,
      state,
      isDraft: false,
      author: { login: "octocat" },
      headRefName: `feature/${number}`,
      headRefOid: `sha-${number}`,
      baseRefName: "main",
      url: `https://github.test/${owner}/repo/pull/${number}`,
      createdAt: updatedAt,
      updatedAt,
      closedAt: state === "OPEN" ? null : updatedAt,
      mergedAt: state === "MERGED" ? updatedAt : null,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [{ commit: { oid: `sha-${number}`, statusCheckRollup: null } }] },
    });
    const result = await syncRepoPullRequests(
      db,
      async () =>
        ({
          graphql: async (_query: string, variables: Record<string, unknown>) => {
            calls.push({ cursor: variables.cursor, states: variables.states });
            const states = variables.states as string[];
            if (states.includes("OPEN")) {
              return {
                repository: {
                  pullRequests: {
                    nodes: [node(70_010, "OPEN", "2026-08-05T00:00:00Z")],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              };
            }
            if (variables.cursor === null) {
              return {
                repository: {
                  pullRequests: {
                    nodes: [node(70_011, "CLOSED", "2026-08-04T00:00:00Z")],
                    pageInfo: { endCursor: "terminal-2", hasNextPage: true },
                  },
                },
              };
            }
            return {
              repository: {
                pullRequests: {
                  nodes: [node(70_012, "MERGED", "2020-01-01T00:00:00Z")],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            };
          },
          rest: {},
        }) as never,
      repo,
    );
    expect(result.synced).toBe(3);
    expect(calls).toEqual([
      { cursor: null, states: ["OPEN"] },
      { cursor: null, states: ["CLOSED", "MERGED"] },
      { cursor: "terminal-2", states: ["CLOSED", "MERGED"] },
    ]);
    const mirrored = await db
      .select({ number: ghPullRequests.number, state: ghPullRequests.state })
      .from(ghPullRequests)
      .where(eq(ghPullRequests.repoId, repo.id));
    expect(mirrored).toEqual(
      expect.arrayContaining([
        { number: 70_010, state: "open" },
        { number: 70_011, state: "closed" },
        { number: 70_012, state: "merged" },
      ]),
    );
  });

  it("persists the issue high-water boundary across a failed request", async () => {
    const owner = `resume-issues-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const records = issueBackfillRecords(500);
    const calls: IssueBackfillCall[] = [];
    let failThirdCall = true;
    const factory = issueBackfillFactory(records, calls, () => {
      if (calls.length === 3 && failThirdCall) {
        failThirdCall = false;
        return new Error("GitHub rate limited");
      }
      return null;
    });

    await expect(syncRepoIssues(db, factory, repo)).rejects.toThrow("GitHub rate limited");
    const [progress] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, `github.issues:${repo.id}`));
    expect(JSON.parse(progress?.cursor ?? "{}")).toMatchObject({
      page: 1,
      highWater: records[198]?.updated_at,
    });

    await expect(syncRepoIssues(db, factory, repo)).resolves.toMatchObject({
      incomplete: false,
    });
    expect(calls.every((call) => call.page === 1)).toBe(true);
    expect(calls[3]?.since).toBe(
      new Date(Date.parse(records[198]?.updated_at ?? "") - 1).toISOString(),
    );
    const [completed] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, `github.issues:${repo.id}`));
    expect(completed?.cursor).toBeNull();
    expect(completed?.scanStartedAt).toBeNull();
  });

  it("resumes a capped issue scan from its high-water boundary without sliding-window gaps", async () => {
    const owner = `sliding-issues-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const records = issueBackfillRecords(1_050);
    const calls: IssueBackfillCall[] = [];
    const factory = issueBackfillFactory(records, calls);

    await expect(syncRepoIssues(db, factory, repo)).resolves.toMatchObject({ incomplete: true });
    const [progress] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, `github.issues:${repo.id}`));
    expect(JSON.parse(progress?.cursor ?? "{}")).toMatchObject({
      page: 1,
      highWater: records[990]?.updated_at,
    });

    // An already-scanned issue moves to the tail between jobs. A frozen
    // page-11 offset would shift issue 2002 behind the boundary and skip it.
    if (records[5]) records[5].updated_at = "2027-01-01T00:00:00.000Z";
    const resumeCallStart = calls.length;
    await expect(syncRepoIssues(db, factory, repo)).resolves.toMatchObject({ incomplete: false });
    const resumedNumbers = calls.slice(resumeCallStart).flatMap((call) => call.numbers);
    expect(resumedNumbers).toContain(2_002);
    expect(resumedNumbers).toContain(1_006);
    expect(calls.slice(resumeCallStart).every((call) => call.page === 1)).toBe(true);
  });

  it("resumes a capped PR backfill instead of restarting at the first page", async () => {
    const owner = `resume-pr-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const cursors: unknown[] = [];
    let terminalCalls = 0;
    const node = (number: number) => ({
      number,
      title: `PR ${number}`,
      state: "CLOSED",
      isDraft: false,
      author: { login: "octocat" },
      headRefName: `feature/${number}`,
      headRefOid: `sha-${number}`,
      baseRefName: "main",
      url: `https://github.test/${owner}/repo/pull/${number}`,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      closedAt: "2026-08-01T00:00:00Z",
      mergedAt: null,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [{ commit: { oid: `sha-${number}`, statusCheckRollup: null } }] },
    });
    const factory = async () =>
      ({
        graphql: async (_query: string, variables: Record<string, unknown>) => {
          const states = variables.states as string[];
          if (states.includes("OPEN")) {
            return {
              repository: {
                pullRequests: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
              },
            };
          }
          cursors.push(variables.cursor);
          terminalCalls += 1;
          const finalPage = terminalCalls === 11;
          return {
            repository: {
              pullRequests: {
                nodes: [node(71_100 + terminalCalls)],
                pageInfo: {
                  endCursor: finalPage ? null : `terminal-${terminalCalls}`,
                  hasNextPage: !finalPage,
                },
              },
            },
          };
        },
        rest: {},
      }) as never;

    const first = await syncRepoPullRequests(db, factory, repo);
    expect(first).toMatchObject({ synced: 10, incomplete: true });
    const [progress] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, `github.pull_requests.terminal:${repo.id}`));
    expect(progress).toMatchObject({ cursor: "terminal-10" });
    expect(progress?.lastTick.getTime()).toBe(0);

    const second = await syncRepoPullRequests(db, factory, repo);
    expect(second).toMatchObject({ synced: 1, incomplete: false });
    expect(cursors).toEqual([
      null,
      "terminal-1",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
      "terminal-7",
      "terminal-8",
      "terminal-9",
      "terminal-10",
    ]);
    const [completed] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, `github.pull_requests.terminal:${repo.id}`));
    expect(completed?.cursor).toBeNull();
    expect(completed?.scanStartedAt).toBeNull();
    expect(completed?.lastTick.getTime()).toBeGreaterThan(0);
  });

  it("completes a resumed PR scan when the overlap reaches its prior high-water boundary", async () => {
    const owner = `resume-pr-watermark-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const previousCompletedAt = new Date("2026-08-01T12:00:00Z");
    const watermarkName = `github.pull_requests.terminal:${repo.id}`;
    await db.insert(schedulerWatermarks).values({
      name: watermarkName,
      lastTick: previousCompletedAt,
    });
    const terminalCursors: unknown[] = [];
    const node = (number: number, updatedAt: string) => ({
      number,
      title: `PR ${number}`,
      state: "MERGED",
      isDraft: false,
      author: { login: "octocat" },
      headRefName: `feature/${number}`,
      headRefOid: `sha-${number}`,
      baseRefName: "main",
      url: `https://github.test/${owner}/repo/pull/${number}`,
      createdAt: updatedAt,
      updatedAt,
      closedAt: null,
      mergedAt: null,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [{ commit: { oid: `sha-${number}`, statusCheckRollup: null } }] },
    });
    const result = await syncRepoPullRequests(
      db,
      async () =>
        ({
          graphql: async (_query: string, variables: Record<string, unknown>) => {
            const states = variables.states as string[];
            if (states.includes("OPEN")) {
              return {
                repository: {
                  pullRequests: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
                },
              };
            }
            terminalCursors.push(variables.cursor);
            if (terminalCursors.length > 1) {
              throw new Error("scan continued past prior high-water");
            }
            return {
              repository: {
                pullRequests: {
                  nodes: [
                    node(71_200, "2026-08-01T12:01:00Z"),
                    node(71_199, "2026-08-01T11:58:00Z"),
                  ],
                  pageInfo: { endCursor: "must-not-follow", hasNextPage: true },
                },
              },
            };
          },
          rest: {},
        }) as never,
      repo,
    );

    expect(result).toMatchObject({ synced: 2, incomplete: false });
    expect(terminalCursors).toEqual([null]);
    const [completed] = await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, watermarkName));
    expect(completed?.cursor).toBeNull();
    expect(completed?.scanStartedAt).toBeNull();
    expect(completed?.lastTick.getTime()).toBeGreaterThan(previousCompletedAt.getTime());
  });

  it("walks past an open PR high-water boundary to reconcile missed CI webhooks", async () => {
    const owner = `open-pr-watermark-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    await db.insert(schedulerWatermarks).values({
      name: `github.pull_requests.open:${repo.id}`,
      lastTick: new Date("2026-08-01T12:00:00Z"),
    });
    const openCursors: unknown[] = [];
    const node = (number: number) => ({
      number,
      title: `PR ${number}`,
      state: "OPEN",
      isDraft: false,
      author: { login: "octocat" },
      headRefName: `feature/${number}`,
      headRefOid: `sha-${number}`,
      baseRefName: "main",
      url: `https://github.test/${owner}/repo/pull/${number}`,
      createdAt: "2026-08-01T11:57:00Z",
      updatedAt: "2026-08-01T11:58:00Z",
      closedAt: null,
      mergedAt: null,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [{ commit: { oid: `sha-${number}`, statusCheckRollup: null } }] },
    });
    const result = await syncRepoPullRequests(
      db,
      async () =>
        ({
          graphql: async (_query: string, variables: Record<string, unknown>) => {
            const states = variables.states as string[];
            if (!states.includes("OPEN")) {
              return {
                repository: {
                  pullRequests: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
                },
              };
            }
            openCursors.push(variables.cursor);
            if (variables.cursor === null) {
              return {
                repository: {
                  pullRequests: {
                    nodes: [node(71_300)],
                    pageInfo: { endCursor: "open-next", hasNextPage: true },
                  },
                },
              };
            }
            return {
              repository: {
                pullRequests: {
                  nodes: [node(71_299)],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            };
          },
          rest: {},
        }) as never,
      repo,
    );

    expect(result).toMatchObject({ synced: 2, incomplete: false });
    expect(openCursors).toEqual([null, "open-next"]);
  });

  it("fans scheduled mirror reconciliation out to every installed repository", async () => {
    await insertRepoWithInstallation(`scheduled-a-${Date.now()}`);
    await insertRepoWithInstallation(`scheduled-b-${Date.now()}`);
    const installedRepos = (await db.select().from(repos)).filter((repo) => repo.installationId);
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];

    const result = await enqueueGithubIssuesSync(db, config, {}, undefined, async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    });

    expect(result).toEqual({ reposScheduled: installedRepos.length });
    expect(
      enqueued
        .map(({ queue, data }) => `${queue}:${String(data.orgId)}:${String(data.repoId)}`)
        .sort(),
    ).toEqual(installedRepos.map((repo) => `github.issues-sync:${repo.orgId}:${repo.id}`).sort());
  });

  it("idempotently mirrors PR webhooks while preserving CI only for an unchanged head", async () => {
    const owner = `webhook-pr-${Date.now()}`;
    const repo = await insertRepo({ owner, name: "repo" });
    const number = 71_001;
    await insertPullRequest(repo.id, number, {
      closingIssues: [7],
      ciState: "success",
      ciHeadSha: "old-sha",
      headSha: "old-sha",
    });
    const payload = {
      action: "synchronize",
      repository: { owner: { login: owner }, name: repo.name },
      pull_request: {
        number,
        title: "Updated PR",
        state: "open",
        draft: false,
        user: { login: "octocat" },
        html_url: `https://github.test/${owner}/${repo.name}/pull/${number}`,
        body: "Updated body",
        base: { ref: "main" },
        head: { ref: "feature/new", sha: "new-sha" },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
    };
    await upsertGhPullRequestFromWebhook(db, orgId, payload);
    await upsertGhPullRequestFromWebhook(db, orgId, payload);
    const rows = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, number)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Updated PR",
      headSha: "new-sha",
      closingIssues: [7],
      ciState: null,
      ciHeadSha: null,
    });

    const ciUpdatedAt = new Date("2026-08-02T01:00:00Z");
    await db
      .update(ghPullRequests)
      .set({ ciState: "success", ciHeadSha: "new-sha", ciUpdatedAt })
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, number)));
    await upsertGhPullRequestFromWebhook(db, orgId, {
      ...payload,
      action: "edited",
      pull_request: { ...payload.pull_request, title: "Metadata-only update" },
    });
    const [unchangedHead] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, number)));
    expect(unchangedHead).toMatchObject({
      title: "Metadata-only update",
      headSha: "new-sha",
      ciState: "success",
      ciHeadSha: "new-sha",
      ciUpdatedAt,
    });
  });

  it("refreshes aggregate PR CI while isolating default-branch operational signals", async () => {
    const owner = `checks-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const prNumber = 72_001;
    await insertPullRequest(repo.id, prNumber, {
      headRef: "feature/checks",
      headSha: "feature-sha",
      ciState: null,
      ciHeadSha: null,
    });
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId, kind: "github", name: `checks-${Date.now()}` })
        .returning()
    )[0];
    if (!integration) throw new Error("integration fixture missing");

    let rollupState: "PENDING" | "SUCCESS" | "FAILURE" = "PENDING";
    let refreshCalls = 0;
    const factory = async () =>
      ({
        graphql: async (_query: string, variables: Record<string, unknown>) => {
          refreshCalls += 1;
          return {
            repository: {
              pullRequest: {
                number: variables.number,
                title: "PR CI",
                state: "OPEN",
                isDraft: false,
                author: { login: "octocat" },
                headRefName: "feature/checks",
                headRefOid: "feature-sha",
                baseRefName: "main",
                url: `https://github.test/${owner}/repo/pull/${prNumber}`,
                createdAt: "2026-08-01T00:00:00Z",
                updatedAt: "2026-08-01T00:00:00Z",
                closingIssuesReferences: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: "feature-sha",
                        statusCheckRollup: { state: rollupState },
                      },
                    },
                  ],
                },
              },
            },
          };
        },
        rest: {
          checks: {
            listForRef: async () => ({
              data: {
                check_runs:
                  rollupState === "FAILURE"
                    ? [
                        { name: "guards", conclusion: "failure" },
                        { name: "typecheck", conclusion: "timed_out" },
                      ]
                    : [],
              },
            }),
          },
        },
      }) as never;
    const deliver = async (eventType: string, payload: Record<string, unknown>) => {
      const eventId = newId("evt");
      await db.insert(inboundEvents).values({
        id: eventId,
        orgId,
        integrationId: integration.id,
        eventType,
        payload: {
          repository: { owner: { login: owner }, name: repo.name },
          ...payload,
        },
        verified: true,
      });
      await processGithubWebhook(db, config, { inboundEventId: eventId }, factory);
    };

    await deliver("check_run", {
      action: "created",
      check_run: {
        name: "build",
        status: "in_progress",
        head_sha: "feature-sha",
        pull_requests: [{ number: prNumber }],
        check_suite: { head_branch: "feature/checks", head_sha: "feature-sha" },
      },
    });
    await deliver("check_suite", {
      action: "requested",
      check_suite: {
        status: "in_progress",
        head_sha: "feature-sha",
        pull_requests: [{ number: prNumber }],
      },
    });
    await deliver("status", { state: "pending", sha: "feature-sha" });
    expect(refreshCalls).toBe(3);

    // A green individual event still re-reads GitHub's red aggregate. The
    // empty PR array exercises fork delivery resolution by head SHA.
    rollupState = "FAILURE";
    await deliver("check_run", {
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: "feature-sha",
        pull_requests: [],
        check_suite: { head_branch: "feature/checks", head_sha: "feature-sha" },
      },
    });
    expect(refreshCalls).toBe(4);
    let [mirrored] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, prNumber)));
    expect(mirrored?.ciState).toBe("failure");
    expect(mirrored?.ciFailureNames).toEqual(["guards", "typecheck"]);
    rollupState = "SUCCESS";
    await deliver("check_suite", {
      action: "completed",
      check_suite: {
        status: "completed",
        head_sha: "feature-sha",
        pull_requests: [{ number: prNumber }],
      },
    });
    expect(refreshCalls).toBe(5);
    [mirrored] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, prNumber)));
    expect(mirrored?.ciState).toBe("success");

    rollupState = "FAILURE";
    await deliver("status", { state: "failure", sha: "feature-sha" });
    expect(refreshCalls).toBe(6);
    [mirrored] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, prNumber)));
    expect(mirrored?.ciState).toBe("failure");
    expect(
      (
        await db
          .select()
          .from(ghCiEvents)
          .where(and(eq(ghCiEvents.repoId, repo.id), eq(ghCiEvents.pullNumber, prNumber)))
          .orderBy(ghCiEvents.observedAt)
      ).map((event) => [event.state, event.failureNames]),
    ).toEqual([
      ["pending", []],
      ["failure", ["guards", "typecheck"]],
      ["success", []],
      ["failure", ["guards", "typecheck"]],
    ]);
    expect(
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, `check:${repo.id}:feature/checks:build`)),
    ).toHaveLength(0);

    const legacyFingerprint = `check:${repo.id}:build`;
    await db.insert(platformIssues).values({
      id: newId("iss"),
      orgId,
      projectId,
      kind: "check",
      severity: "error",
      fingerprint: legacyFingerprint,
      title: "Legacy branchless check",
      bodyMd: "Opened before branch-scoped check fingerprints.",
    });
    await deliver("check_run", {
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: "feature-sha",
        pull_requests: [{ number: prNumber }],
        check_suite: { head_branch: "feature/checks", head_sha: "feature-sha" },
      },
    });
    const [legacyAfterFeatureSuccess] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, legacyFingerprint));
    expect(legacyAfterFeatureSuccess?.state).toBe("open");

    await deliver("check_run", {
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "failure",
        head_sha: "main-sha",
        // GitHub may associate a default-branch commit with the PR it merged;
        // branch identity, not this hint array, decides incident routing.
        pull_requests: [{ number: prNumber }],
        check_suite: { head_branch: "main", head_sha: "main-sha" },
      },
    });
    const mainFingerprint = `check:${repo.id}:main:build`;
    let [mainIssue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, mainFingerprint));
    expect(mainIssue?.state).toBe("open");
    const [legacyIssue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, legacyFingerprint));
    expect(legacyIssue?.state).toBe("open");

    rollupState = "SUCCESS";
    await deliver("check_run", {
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: "feature-sha",
        pull_requests: [{ number: prNumber }],
        check_suite: { head_branch: "feature/checks", head_sha: "feature-sha" },
      },
    });
    [mainIssue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, mainFingerprint));
    expect(mainIssue?.state).toBe("open");

    await deliver("check_run", {
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: "main-sha",
        pull_requests: [],
        check_suite: { head_branch: "main", head_sha: "main-sha" },
      },
    });
    [mainIssue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, mainFingerprint));
    expect(mainIssue?.state).toBe("resolved");
    const [recoveredLegacyIssue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, legacyFingerprint));
    expect(recoveredLegacyIssue?.state).toBe("resolved");

    rollupState = "PENDING";
    await deliver("workflow_run", {
      action: "completed",
      workflow_run: {
        name: "ordinary-repository-ci",
        conclusion: "success",
        head_sha: "feature-sha",
        pull_requests: [],
      },
    });
    [mirrored] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, prNumber)));
    expect(mirrored?.ciState).toBe("pending");
  });

  it("coalesces a CI notification burst into one authoritative reconciliation", async () => {
    const owner = `checks-batch-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const prNumber = 72_002;
    const headSha = `batch-${newId("evt")}`;
    await insertPullRequest(repo.id, prNumber, {
      headRef: "feature/batched-checks",
      headSha,
      ciState: null,
      ciHeadSha: null,
    });
    const [integration] = await db
      .insert(integrations)
      .values({ id: newId("int"), orgId, kind: "github", name: `checks-batch-${Date.now()}` })
      .returning();
    if (!integration) throw new Error("integration fixture missing");

    const eventIds: string[] = [];
    const events: Array<typeof inboundEvents.$inferInsert> = [];
    for (let index = 0; index < 1_000; index += 1) {
      const eventId = newId("evt");
      eventIds.push(eventId);
      const completed = index >= 500;
      events.push({
        id: eventId,
        orgId,
        integrationId: integration.id,
        eventType: "check_run",
        payload: {
          action: completed ? "completed" : "created",
          repository: { owner: { login: owner }, name: repo.name },
          check_run: {
            name: `check-${index % 10}`,
            status: completed ? "completed" : "in_progress",
            conclusion: completed ? "success" : null,
            head_sha: headSha,
            pull_requests: [{ number: prNumber }],
            check_suite: { head_branch: "feature/batched-checks", head_sha: headSha },
          },
        },
        verified: true,
      });
    }
    await db.insert(inboundEvents).values(events);

    let factoryCalls = 0;
    let graphqlCalls = 0;
    let checkCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return {
        graphql: async (_query: string, variables: Record<string, unknown>) => {
          graphqlCalls += 1;
          return {
            repository: {
              pullRequest: {
                number: variables.number,
                title: "Batched CI",
                state: "OPEN",
                isDraft: false,
                author: { login: "octocat" },
                headRefName: "feature/batched-checks",
                headRefOid: headSha,
                baseRefName: "main",
                url: `https://github.test/${owner}/repo/pull/${prNumber}`,
                closingIssuesReferences: { nodes: [] },
                commits: {
                  nodes: [{ commit: { oid: headSha, statusCheckRollup: { state: "SUCCESS" } } }],
                },
              },
            },
          };
        },
        rest: {
          checks: {
            listForRef: async () => {
              checkCalls += 1;
              return { data: { check_runs: [] } };
            },
          },
        },
      } as never;
    };

    await expect(
      processGithubWebhookBatch(
        db,
        config,
        eventIds.map((inboundEventId) => ({ inboundEventId })),
        factory,
      ),
    ).resolves.toEqual({
      events: 1_000,
      reconciledEvents: 1_000,
      reconciliations: 1,
      coalescedEvents: 999,
      projectionMs: expect.any(Number),
      reconciliationMs: expect.any(Number),
      maxReconciliationMs: expect.any(Number),
    });
    expect(factoryCalls).toBe(1);
    expect(graphqlCalls).toBe(1);
    expect(checkCalls).toBe(0);

    const processed = await db
      .select({ id: inboundEvents.id, processedAt: inboundEvents.processedAt })
      .from(inboundEvents)
      .where(inArray(inboundEvents.id, eventIds));
    expect(processed).toHaveLength(1_000);
    expect(processed.every((event) => event.processedAt instanceof Date)).toBe(true);
    const [pull] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, prNumber)));
    expect(pull).toMatchObject({ ciState: "success", ciHeadSha: headSha });
  });

  it("resumes a replayed slash-command delivery without creating a second run", async () => {
    const owner = `command-replay-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    if (!installation) throw new Error("installation fixture missing");
    await insertAgent("architect");
    const [integration] = await db
      .insert(integrations)
      .values({ id: newId("int"), orgId, kind: "github", name: `command-${Date.now()}` })
      .returning();
    if (!integration) throw new Error("integration fixture missing");
    const eventId = newId("evt");
    await db.insert(inboundEvents).values({
      id: eventId,
      orgId,
      integrationId: integration.id,
      eventType: "issue_comment",
      payload: {
        action: "created",
        installation: { id: installation.installationId },
        repository: { owner: { login: owner }, name: repo.name },
        sender: { login: "maintainer", type: "User" },
        issue: { number: 937, title: "Plan Facility flow", body: "Keep behavior stable." },
        comment: { id: 44, body: "/architect" },
      },
      verified: true,
    });

    let progressComments = 0;
    const factory = async () =>
      ({
        rest: {
          repos: {
            getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }),
            getContent: async () => ({
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(
                  JSON.stringify({ executionLane: { architect: "platform" } }),
                ).toString("base64"),
              },
            }),
          },
          issues: {
            listComments: async () => ({ data: [] }),
            addAssignees: async () => ({ data: { assignees: [{ login: "maintainer" }] } }),
            createComment: async () => {
              progressComments += 1;
              return { data: { id: progressComments, html_url: "https://github.test/comment" } };
            },
          },
        },
      }) as never;
    const dispatches: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatches.push({ queue, data });
      return null;
    };

    await processGithubWebhook(db, config, { inboundEventId: eventId }, factory, enqueue);
    await db.update(inboundEvents).set({ processedAt: null }).where(eq(inboundEvents.id, eventId));
    await processGithubWebhook(db, config, { inboundEventId: eventId }, factory, enqueue);

    const dispatchedRuns = await db
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.githubDeliveryId, eventId)));
    expect(dispatchedRuns).toHaveLength(1);
    expect(progressComments).toBe(1);
    expect(
      dispatches.filter(
        (job) => job.queue === "runs.dispatch" && job.data.runId === dispatchedRuns[0]?.id,
      ),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, dispatchedRuns[0]?.id ?? ""), eq(runEvents.seq, 1))),
    ).toHaveLength(1);
  });

  it("dispatches CI-doctor from the final complete rollup without persisting raw logs", async () => {
    const owner = `workflow-refresh-${Date.now()}`;
    const headSha = "a".repeat(40);
    const repo = await insertRepoWithInstallation(owner);
    await db
      .update(repos)
      .set({ renderAnswers: { execution_lane: { "ci-doctor": "platform" } } })
      .where(eq(repos.id, repo.id));
    await insertAgent("ci-doctor", [
      { type: "github", event: "workflow_run", action: "completed" },
    ]);
    await insertPullRequest(repo.id, 72_100, {
      headRef: "feature/ci-doctor",
      headSha,
    });
    await insertRun({
      status: "succeeded",
      trigger: { request: { title: "Repair the failing build" } },
      gh: { owner, repo: repo.name, branch: "feature/ci-doctor" },
    });
    await insertRun({
      mode: "ci_doctor",
      status: "succeeded",
      trigger: {
        type: "github_event",
        event: "workflow_run",
        pullRequest: { headSha: "b".repeat(40) },
        workflowRun: { failureContext: { jobs: [{ logTail: "legacy-job-log-secret" }] } },
      },
      gh: { owner, repo: repo.name, branch: "feature/ci-doctor" },
    });
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId, kind: "github", name: `workflow-${Date.now()}` })
        .returning()
    )[0];
    if (!installation || !integration) throw new Error("workflow fixtures missing");
    const eventId = newId("evt");
    await db.insert(inboundEvents).values({
      id: eventId,
      orgId,
      integrationId: integration.id,
      eventType: "workflow_run",
      verified: true,
      payload: {
        action: "completed",
        installation: { id: installation.installationId },
        repository: { owner: { login: owner }, name: repo.name },
        sender: { login: "maintainer" },
        workflow_run: {
          id: 991,
          name: "build",
          // A successful workflow may be the last check to finish while an
          // earlier check remains failed; the complete rollup is authoritative.
          conclusion: "success",
          head_branch: "feature/ci-doctor",
          head_sha: headSha,
          html_url: "https://github.test/workflow/1",
          pull_requests: [],
        },
      },
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const warnings: Array<{ context: Record<string, unknown>; message: string }> = [];
    await processGithubWebhook(
      db,
      config,
      { inboundEventId: eventId },
      async () =>
        ({
          graphql: async () => {
            throw new Error("GraphQL rate limited");
          },
          rest: {
            pulls: {
              get: async () => ({
                data: {
                  number: 72_100,
                  title: "fix: repair CI",
                  state: "open",
                  draft: true,
                  html_url: "https://github.test/pull/72100",
                  head: {
                    ref: "feature/ci-doctor",
                    sha: headSha,
                    repo: { full_name: `${owner}/${repo.name}` },
                  },
                  base: { ref: "main", repo: { full_name: `${owner}/${repo.name}` } },
                },
              }),
              listFiles: async () => ({ data: [{ filename: "src/widget.ts" }] }),
            },
            checks: {
              listForRef: async () => ({
                data: {
                  check_runs: [
                    {
                      id: 992,
                      name: "typecheck",
                      status: "completed",
                      conclusion: "failure",
                      details_url: "https://github.test/actions/runs/991/job/992",
                      output: {
                        title: "Typecheck failed",
                        summary: "expected true to be false; github_pat_must-never-persist",
                      },
                      app: { slug: "github-actions" },
                    },
                  ],
                },
              }),
            },
            actions: {
              listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
            },
            issues: {
              createComment: async () => ({ data: { id: 993 } }),
            },
          },
        }) as never,
      async (queue, data) => {
        enqueued.push({ queue, data });
        return null;
      },
      {
        warn: (context, message) => warnings.push({ context, message }),
      },
    );

    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), sql`${runs.trigger}->>'delivery' = ${eventId}`));
    expect(run?.mode).toBe("ci_doctor");
    expect(run?.ciRepairKey).toMatch(/^[a-f0-9]{64}$/);
    expect(run?.trigger).toMatchObject({
      workflowRun: {
        name: "build",
        conclusion: "success",
        headSha,
      },
      ciDoctor: {
        schema: "facility.doctor.context.v2",
        admittedHeadSha: headSha,
        attempt: 1,
        failure: {
          category: "typecheck",
          check: "typecheck",
          conclusion: "failure",
          verificationCommands: ["typecheck"],
        },
      },
      deliveryContext: { producingRunId: expect.any(String) },
    });
    expect(JSON.stringify(run?.trigger)).not.toContain("expected true to be false");
    expect(JSON.stringify(run?.trigger)).not.toContain("github_pat_must-never-persist");
    expect(JSON.stringify(run?.trigger)).not.toContain("failureContext");
    expect(JSON.stringify(run?.trigger)).not.toContain("legacy-job-log-secret");
    expect(enqueued).toContainEqual({ queue: "runs.dispatch", data: { runId: run?.id, orgId } });
    const [processed] = await db.select().from(inboundEvents).where(eq(inboundEvents.id, eventId));
    expect(processed?.processedAt).not.toBeNull();
    expect(processed?.error).toBeNull();
    expect(warnings).toEqual([
      {
        context: expect.objectContaining({
          inboundEventId: eventId,
          orgId,
          eventType: "workflow_run",
          owner,
          repo: repo.name,
          headSha,
          error: "GraphQL rate limited",
        }),
        message: "GitHub pull-request snapshot refresh failed; scheduled reconciliation will retry",
      },
    ]);

    const duplicateEventId = newId("evt");
    const [original] = await db.select().from(inboundEvents).where(eq(inboundEvents.id, eventId));
    if (!original) throw new Error("workflow event fixture missing");
    await db.insert(inboundEvents).values({
      ...original,
      id: duplicateEventId,
      processedAt: null,
      error: null,
    });
    await processGithubWebhook(
      db,
      config,
      { inboundEventId: duplicateEventId },
      async () =>
        ({
          graphql: async () => {
            throw new Error("GraphQL rate limited");
          },
          rest: {
            pulls: {
              get: async () => ({
                data: {
                  number: 72_100,
                  title: "fix: repair CI",
                  state: "open",
                  draft: true,
                  html_url: "https://github.test/pull/72100",
                  head: {
                    ref: "feature/ci-doctor",
                    sha: headSha,
                    repo: { full_name: `${owner}/${repo.name}` },
                  },
                  base: { ref: "main", repo: { full_name: `${owner}/${repo.name}` } },
                },
              }),
              listFiles: async () => ({ data: [{ filename: "src/widget.ts" }] }),
            },
            checks: {
              listForRef: async () => ({
                data: {
                  check_runs: [
                    {
                      id: 992,
                      name: "typecheck",
                      status: "completed",
                      conclusion: "failure",
                      app: { slug: "github-actions" },
                    },
                  ],
                },
              }),
            },
            actions: {
              listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
            },
          },
        }) as never,
    );
    const repairRuns = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.mode, "ci_doctor"),
          sql`${runs.gh}->>'branch' = 'feature/ci-doctor'`,
        ),
      );
    expect(repairRuns).toHaveLength(2); // one legacy fixture + one current-head admission
  });

  it("repairs only Facility delivery branches and stops at the configured attempt limit", async () => {
    const owner = `workflow-policy-${Date.now()}`;
    const unrelatedSha = "1".repeat(40);
    const priorSha = "2".repeat(40);
    const currentSha = "3".repeat(40);
    const repo = await insertRepoWithInstallation(owner);
    await db
      .update(repos)
      .set({ renderAnswers: { execution_lane: { "ci-doctor": "platform" } } })
      .where(eq(repos.id, repo.id));
    await db
      .update(projects)
      .set({ settings: { ci_repair_max_attempts: 1 } })
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
    await insertAgent("ci-doctor", [
      { type: "github", event: "workflow_run", action: "completed" },
    ]);
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId, kind: "github", name: `policy-${Date.now()}` })
        .returning()
    )[0];
    if (!installation || !integration) throw new Error("CI policy fixtures missing");

    const deliverFailure = async (branch: string, headSha: string) => {
      const eventId = newId("evt");
      await db.insert(inboundEvents).values({
        id: eventId,
        orgId,
        integrationId: integration.id,
        eventType: "workflow_run",
        verified: true,
        payload: {
          action: "completed",
          installation: { id: installation.installationId },
          repository: { owner: { login: owner }, name: repo.name },
          workflow_run: {
            id: nextInstallationId(),
            name: "build",
            conclusion: "failure",
            head_branch: branch,
            head_sha: headSha,
            pull_requests: [],
          },
        },
      });
      const comments: string[] = [];
      await processGithubWebhook(
        db,
        config,
        { inboundEventId: eventId },
        async () =>
          ({
            graphql: async () => {
              throw new Error("snapshot unavailable");
            },
            rest: {
              pulls: {
                get: async (input: { pull_number: number }) => ({
                  data: {
                    number: input.pull_number,
                    title: "fix: repair CI",
                    state: "open",
                    draft: true,
                    html_url: `https://github.test/pull/${input.pull_number}`,
                    head: {
                      ref: branch,
                      sha: headSha,
                      repo: { full_name: `${owner}/${repo.name}` },
                    },
                    base: { ref: "main", repo: { full_name: `${owner}/${repo.name}` } },
                  },
                }),
                listFiles: async () => ({ data: [{ filename: "src/widget.ts" }] }),
              },
              checks: {
                listForRef: async () => ({
                  data: {
                    check_runs: [
                      {
                        id: nextInstallationId(),
                        name: "typecheck",
                        status: "completed",
                        conclusion: "failure",
                        output: { title: "Typecheck failed", summary: "Type error" },
                        app: { slug: "github-actions" },
                      },
                    ],
                  },
                }),
              },
              actions: {
                listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
              },
              issues: {
                createComment: async (input: { body: string }) => {
                  comments.push(input.body);
                  return { data: { id: 1 } };
                },
              },
            },
          }) as never,
      );
      return { eventId, comments };
    };

    await insertPullRequest(repo.id, 72_200, {
      draft: true,
      headRef: "feature/not-produced-by-facility",
      headSha: unrelatedSha,
    });
    const otherRepo = await insertRepo({ owner, name: "other-repo" });
    await insertRun({
      status: "succeeded",
      trigger: { request: { title: "A different repository's delivery" } },
      gh: { owner, repo: otherRepo.name, branch: "feature/not-produced-by-facility" },
    });
    const unrelated = await deliverFailure("feature/not-produced-by-facility", unrelatedSha);
    expect(
      await db.select().from(runs).where(sql`${runs.trigger}->>'delivery' = ${unrelated.eventId}`),
    ).toHaveLength(0);

    const branch = "feature/facility-repair-limit";
    await insertPullRequest(repo.id, 72_201, {
      draft: true,
      headRef: branch,
      headSha: currentSha,
    });
    await insertRun({
      status: "succeeded",
      trigger: { request: { title: "Facility delivery" } },
      gh: { owner, repo: repo.name, branch },
    });
    await insertRun({
      mode: "ci_doctor",
      status: "succeeded",
      trigger: {
        type: "github_event",
        event: "workflow_run",
        pullRequest: { headSha: priorSha },
      },
      gh: { owner, repo: repo.name, branch },
    });
    const exhausted = await deliverFailure(branch, currentSha);
    expect(
      await db.select().from(runs).where(sql`${runs.trigger}->>'delivery' = ${exhausted.eventId}`),
    ).toHaveLength(0);
    expect(exhausted.comments).toEqual([
      "Facility stopped automatic CI repair after 1 attempts on this branch. The draft PR and failing GitHub checks remain available for human iteration.",
    ]);
    const repeatedExhaustion = await deliverFailure(branch, currentSha);
    expect(repeatedExhaustion.comments).toHaveLength(0);
    const exhaustionAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.ci_repair.exhausted"),
          sql`${auditEvents.target}->>'id' = ${repo.id}`,
          sql`${auditEvents.payload}->>'branch' = ${branch}`,
          sql`${auditEvents.payload}->>'headSha' = ${currentSha}`,
        ),
      );
    expect(exhaustionAudits).toHaveLength(1);
    const [draft] = await db
      .select()
      .from(ghPullRequests)
      .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, 72_201)));
    expect(draft?.draft).toBe(true);
    await db
      .update(projects)
      .set({ settings: {} })
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
  });

  it("waits, triages forks, rejects stale heads, and fails closed on unavailable evidence", async () => {
    const owner = `workflow-denials-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    await db
      .update(repos)
      .set({ renderAnswers: { execution_lane: { "ci-doctor": "platform" } } })
      .where(eq(repos.id, repo.id));
    await insertAgent("ci-doctor", [
      { type: "github", event: "workflow_run", action: "completed" },
    ]);
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId, kind: "github", name: `denials-${Date.now()}` })
        .returning()
    )[0];
    if (!installation || !integration) throw new Error("CI denial fixtures missing");

    const prepareBranch = async (number: number, branch: string, headSha: string) => {
      await insertPullRequest(repo.id, number, { draft: true, headRef: branch, headSha });
      await insertRun({
        status: "succeeded",
        trigger: { request: { title: `Facility delivery for ${branch}` } },
        gh: { owner, repo: repo.name, branch },
      });
    };
    const deliver = async (input: {
      number: number;
      branch: string;
      eventSha: string;
      liveSha?: string;
      headRepo?: string;
      files?: string[];
      checks?: Array<Record<string, unknown>>;
      evidenceUnavailable?: boolean;
      signal?: "workflow_run" | "check_run";
    }) => {
      const eventId = newId("evt");
      const eventType = input.signal ?? "workflow_run";
      await db.insert(inboundEvents).values({
        id: eventId,
        orgId,
        integrationId: integration.id,
        eventType,
        verified: true,
        payload: {
          action: "completed",
          installation: { id: installation.installationId },
          repository: { owner: { login: owner }, name: repo.name },
          ...(eventType === "workflow_run"
            ? {
                workflow_run: {
                  id: nextInstallationId(),
                  name: "build",
                  conclusion: "failure",
                  head_branch: input.branch,
                  head_sha: input.eventSha,
                  pull_requests: [],
                },
              }
            : {
                check_run: {
                  id: nextInstallationId(),
                  name: "external verification",
                  status: "completed",
                  conclusion: "success",
                  head_sha: input.eventSha,
                  pull_requests: [{ number: input.number }],
                  check_suite: {
                    head_branch: input.branch,
                    head_sha: input.eventSha,
                    pull_requests: [{ number: input.number }],
                  },
                },
              }),
        },
      });
      const comments: string[] = [];
      let error: unknown = null;
      try {
        await processGithubWebhook(
          db,
          config,
          { inboundEventId: eventId },
          async () =>
            ({
              graphql: async () => {
                throw new Error("snapshot unavailable");
              },
              rest: {
                pulls: {
                  get: async () => ({
                    data: {
                      number: input.number,
                      title: "fix: repair CI",
                      state: "open",
                      draft: true,
                      html_url: `https://github.test/pull/${input.number}`,
                      head: {
                        ref: input.branch,
                        sha: input.liveSha ?? input.eventSha,
                        repo: { full_name: input.headRepo ?? `${owner}/${repo.name}` },
                      },
                      base: { ref: "main", repo: { full_name: `${owner}/${repo.name}` } },
                    },
                  }),
                  listFiles: async () => ({
                    data: (input.files ?? ["src/widget.ts"]).map((filename) => ({ filename })),
                  }),
                },
                checks: {
                  listForRef: async () => {
                    if (input.evidenceUnavailable) throw new Error("installation token revoked");
                    return {
                      data: {
                        check_runs: input.checks ?? [
                          {
                            id: 1,
                            name: "typecheck",
                            status: "completed",
                            conclusion: "failure",
                            app: { slug: "github-actions" },
                          },
                        ],
                      },
                    };
                  },
                },
                actions: {
                  listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] } }),
                },
                issues: {
                  createComment: async (comment: { body: string }) => {
                    comments.push(comment.body);
                    return { data: { id: 1 } };
                  },
                },
              },
            }) as never,
          undefined,
          { warn: () => undefined },
        );
      } catch (caught) {
        error = caught;
      }
      const dispatched = await db
        .select()
        .from(runs)
        .where(sql`${runs.trigger}->>'delivery' = ${eventId}`);
      return { comments, dispatched, error, eventId };
    };

    const pendingSha = "4".repeat(40);
    await prepareBranch(72_210, "feature/pending-rollup", pendingSha);
    const pending = await deliver({
      number: 72_210,
      branch: "feature/pending-rollup",
      eventSha: pendingSha,
      checks: [
        {
          id: 1,
          name: "typecheck",
          status: "completed",
          conclusion: "failure",
          app: { slug: "github-actions" },
        },
        {
          id: 2,
          name: "unit test",
          status: "in_progress",
          conclusion: null,
          app: { slug: "github-actions" },
        },
      ],
    });
    expect(pending.error).toBeNull();
    expect(pending.dispatched).toHaveLength(0);
    expect(pending.comments).toHaveLength(0);
    const externalCompletion = await deliver({
      number: 72_210,
      branch: "feature/pending-rollup",
      eventSha: pendingSha,
      signal: "check_run",
      checks: [
        {
          id: 1,
          name: "typecheck",
          status: "completed",
          conclusion: "failure",
          app: { slug: "github-actions" },
        },
        {
          id: 2,
          name: "external verification",
          status: "completed",
          conclusion: "success",
          app: { slug: "external-ci" },
        },
      ],
    });
    expect(externalCompletion.error).toBeNull();
    expect(externalCompletion.dispatched).toHaveLength(1);

    const forkSha = "5".repeat(40);
    await prepareBranch(72_211, "feature/fork", forkSha);
    const fork = await deliver({
      number: 72_211,
      branch: "feature/fork",
      eventSha: forkSha,
      headRepo: "outside/fork",
    });
    expect(fork.error).toBeNull();
    expect(fork.dispatched).toHaveLength(0);
    expect(fork.comments).toHaveLength(1);
    expect(fork.comments[0]).toContain("cross-repository");

    const staleEventSha = "6".repeat(40);
    const liveSha = "7".repeat(40);
    await prepareBranch(72_212, "feature/stale", staleEventSha);
    const stale = await deliver({
      number: 72_212,
      branch: "feature/stale",
      eventSha: staleEventSha,
      liveSha,
    });
    expect(stale.error).toBeNull();
    expect(stale.dispatched).toHaveLength(0);
    expect(stale.comments).toHaveLength(0);

    const unavailableSha = "8".repeat(40);
    await prepareBranch(72_213, "feature/revoked", unavailableSha);
    const unavailable = await deliver({
      number: 72_213,
      branch: "feature/revoked",
      eventSha: unavailableSha,
      evidenceUnavailable: true,
    });
    expect(unavailable.error).toBeInstanceOf(Error);
    expect((unavailable.error as Error).message).toBe("installation token revoked");
    expect(unavailable.dispatched).toHaveLength(0);
    const [failedInbound] = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, unavailable.eventId));
    expect(failedInbound?.processedAt).toBeNull();
    expect(failedInbound?.error).toBe("installation token revoked");
  });

  it("marks a Facility draft ready only after the current GitHub CI rollup succeeds", async () => {
    const owner = `ready-${Date.now()}`;
    const repo = await insertRepoWithInstallation(owner);
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId, kind: "github", name: `ready-${Date.now()}` })
        .returning()
    )[0];
    if (!installation || !integration) throw new Error("ready fixtures missing");
    const facilityBranch = "feature/facility-ready";
    const unrelatedBranch = "feature/unrelated-draft";
    await insertRun({
      status: "succeeded",
      trigger: { request: { title: "Facility delivery" } },
      gh: { owner, repo: repo.name, branch: facilityBranch },
    });
    await insertPullRequest(repo.id, 72_300, {
      draft: true,
      headRef: facilityBranch,
      headSha: "ready-sha",
      ciState: "pending",
      ciHeadSha: "ready-sha",
    });
    await insertPullRequest(repo.id, 72_301, {
      draft: true,
      headRef: unrelatedBranch,
      headSha: "unrelated-ready-sha",
      ciState: "pending",
      ciHeadSha: "unrelated-ready-sha",
    });
    const readyMutations: Record<string, unknown>[] = [];
    const factory = async () =>
      ({
        graphql: async (query: string, variables: Record<string, unknown>) => {
          if (query.includes("markPullRequestReadyForReview")) {
            readyMutations.push(variables);
            return { markPullRequestReadyForReview: { pullRequest: { number: 72_300 } } };
          }
          const number = Number(variables.number);
          const facility = number === 72_300;
          const headSha = facility ? "ready-sha" : "unrelated-ready-sha";
          const headRef = facility ? facilityBranch : unrelatedBranch;
          return {
            repository: {
              pullRequest: {
                number,
                title: `PR ${number}`,
                state: "OPEN",
                isDraft: true,
                author: { login: "octocat" },
                headRefName: headRef,
                headRefOid: headSha,
                baseRefName: "main",
                url: `https://github.test/${owner}/${repo.name}/pull/${number}`,
                createdAt: "2026-08-01T00:00:00Z",
                updatedAt: "2026-08-01T00:00:00Z",
                closingIssuesReferences: { nodes: [] },
                commits: {
                  nodes: [{ commit: { oid: headSha, statusCheckRollup: { state: "SUCCESS" } } }],
                },
              },
            },
          };
        },
        rest: {
          pulls: {
            get: async (input: { pull_number: number }) => ({
              data: {
                number: input.pull_number,
                title: `PR ${input.pull_number}`,
                state: "open",
                draft: true,
                html_url: `https://github.test/pulls/${input.pull_number}`,
                node_id: `PR_${input.pull_number}`,
                head: {
                  sha: input.pull_number === 72_300 ? "ready-sha" : "unrelated-ready-sha",
                },
              },
            }),
          },
        },
      }) as never;
    const deliverSuccess = async (number: number, headSha: string) => {
      const eventId = newId("evt");
      await db.insert(inboundEvents).values({
        id: eventId,
        orgId,
        integrationId: integration.id,
        eventType: "check_suite",
        verified: true,
        payload: {
          action: "completed",
          installation: { id: installation.installationId },
          repository: { owner: { login: owner }, name: repo.name },
          check_suite: {
            status: "completed",
            conclusion: "success",
            head_sha: headSha,
            pull_requests: [{ number }],
          },
        },
      });
      await processGithubWebhook(db, config, { inboundEventId: eventId }, factory);
    };

    await deliverSuccess(72_300, "ready-sha");
    await deliverSuccess(72_301, "unrelated-ready-sha");
    const mirrored = await db
      .select()
      .from(ghPullRequests)
      .where(eq(ghPullRequests.repoId, repo.id));
    expect(mirrored.find((pull) => pull.number === 72_300)?.draft).toBe(false);
    expect(mirrored.find((pull) => pull.number === 72_301)?.draft).toBe(true);
    expect(readyMutations).toEqual([{ pullRequestId: "PR_72300" }]);
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

  it("serves repository-qualified issue and orphan-PR stories from one pipeline contract", async () => {
    const number = 80_000;
    const repoA = await insertRepo({ owner: `stories-a-${Date.now()}`, name: "repo" });
    const repoB = await insertRepo({ owner: `stories-b-${Date.now()}`, name: "repo" });
    await insertIssue(repoA.id, number, "open", "2026-08-01T00:00:00Z");
    await insertIssue(repoB.id, number, "open", "2026-08-01T00:00:00Z");
    const run = await insertRun({
      status: "running",
      gh: { owner: repoA.owner.toUpperCase(), repo: repoA.name.toUpperCase(), issueNumber: number },
    });
    await insertPullRequest(repoA.id, number + 1, {
      closingIssues: [number],
      ciState: "pending",
      ciHeadSha: `head-${number + 1}`,
    });
    await insertPullRequest(repoB.id, number + 2, {
      title: "Human-created orphan PR",
      bodyMd: "No issue closes this PR.",
    });
    await insertIssue(repoB.id, number + 3, "closed", "2026-06-01T00:00:00Z");
    await insertPullRequest(repoB.id, number + 4, {
      title: "PR linked only to an old closed issue",
      closingIssues: [number + 3],
    });
    const pendingIssueNumber = number + 5;
    const pendingPullNumber = number + 6;
    await insertIssue(repoA.id, pendingIssueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repoA.id, pendingPullNumber, {
      title: "Run-linked PR still validating",
      ciState: "pending",
      ciHeadSha: `head-${pendingPullNumber}`,
    });
    await insertRun({
      status: "succeeded",
      gh: {
        owner: repoA.owner,
        repo: repoA.name,
        issueNumber: pendingIssueNumber,
        pr: {
          number: pendingPullNumber,
          url: `https://github.com/o/r/pull/${pendingPullNumber}`,
        },
      },
    });
    const draftIssueNumber = number + 7;
    const draftPullNumber = number + 8;
    await insertIssue(repoA.id, draftIssueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repoA.id, draftPullNumber, {
      title: "Run-linked draft PR",
      draft: true,
    });
    await insertRun({
      status: "succeeded",
      gh: {
        owner: repoA.owner,
        repo: repoA.name,
        issueNumber: draftIssueNumber,
        pr: { number: draftPullNumber, url: `https://github.com/o/r/pull/${draftPullNumber}` },
      },
    });
    const provenanceIssueNumber = number + 9;
    const provenancePullNumber = number + 10;
    await insertIssue(repoA.id, provenanceIssueNumber, "open", "2026-08-01T00:00:00Z");
    await insertRun({
      status: "succeeded",
      gh: {
        owner: repoA.owner,
        repo: repoA.name,
        issueNumber: provenanceIssueNumber,
        pr: {
          number: provenancePullNumber,
          url: `https://github.com/${repoA.owner}/${repoA.name}/pull/${provenancePullNumber}`,
        },
      },
    });
    const successfulIssueNumber = number + 11;
    const successfulPullNumber = number + 12;
    await insertIssue(repoA.id, successfulIssueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repoA.id, successfulPullNumber, {
      title: "Checks passed",
      closingIssues: [successfulIssueNumber],
      ciState: "success",
      ciHeadSha: `head-${successfulPullNumber}`,
    });
    await db.insert(ghCiEvents).values([
      {
        id: newId("evt"),
        orgId,
        projectId,
        repoId: repoA.id,
        pullNumber: successfulPullNumber,
        headSha: `head-${successfulPullNumber}`,
        state: "pending",
        observedAt: new Date("2026-08-01T01:00:00Z"),
      },
      {
        id: newId("evt"),
        orgId,
        projectId,
        repoId: repoA.id,
        pullNumber: successfulPullNumber,
        headSha: `head-${successfulPullNumber}`,
        state: "success",
        observedAt: new Date("2026-08-01T01:02:00Z"),
      },
    ]);
    const planAcceptance = (
      await db
        .select({ id: actionTypes.id })
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "plan_acceptance")))
        .limit(1)
    )[0];
    if (!planAcceptance) throw new Error("plan_acceptance action fixture missing");
    const legacyArchitectRun = await insertRun({
      mode: "architect",
      status: "succeeded",
      gh: { issueNumber: number },
    });
    const legacyProposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId,
          runId: legacyArchitectRun.id,
          actionTypeId: planAcceptance.id,
          payload: { architectRunId: legacyArchitectRun.id, issueNumber: number },
          contextMd: "Legacy proposal without a repository id",
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning()
    )[0];
    if (!legacyProposal) throw new Error("legacy proposal fixture missing");
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: legacyProposal.id,
      seq: 1,
      type: "open",
      actor: { type: "agent", id: legacyArchitectRun.id },
      data: { source: "architect_run" },
    });

    const pipeline = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/pipeline`,
      headers: { cookie },
    });
    expect(pipeline.statusCode, pipeline.body).toBe(200);
    const stages = pipeline.json().stages as Array<{
      key: string;
      stories: Array<{
        key: string;
        storyType: string;
        currentRun: { id: string } | null;
        ciState: string | null;
        ciFailureNames: string[];
        prs: Array<{ number: number; draft: boolean; ciState: string | null }>;
      }>;
    }>;
    const stories = stages.flatMap((stage) =>
      stage.stories.map((story) => ({ ...story, stage: stage.key })),
    );
    expect(stories.find((story) => story.key === `${repoA.id}:issue:${number}`)).toMatchObject({
      stage: "building",
      currentRun: { id: run.id },
    });
    const repoBBoardStory = stories.find((story) => story.key === `${repoB.id}:issue:${number}`);
    expect(repoBBoardStory).toMatchObject({ stage: "backlog" });
    const issueQuery = new URLSearchParams({ repoId: repoA.id, storyType: "issue" });
    const issueDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number}?${issueQuery}`,
      headers: { cookie },
    });
    expect(issueDetail.statusCode, issueDetail.body).toBe(200);
    expect(issueDetail.json().runs).toEqual([expect.objectContaining({ id: run.id })]);
    const repoBIssueQuery = new URLSearchParams({ repoId: repoB.id, storyType: "issue" });
    const repoBIssueDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number}?${repoBIssueQuery}`,
      headers: { cookie },
    });
    expect(repoBIssueDetail.statusCode, repoBIssueDetail.body).toBe(200);
    expect(repoBIssueDetail.json()).toMatchObject({
      stage: { key: repoBBoardStory?.stage },
      allowLegacyProposalNumber: false,
    });
    const pendingBoardStory = stories.find(
      (story) => story.key === `${repoA.id}:issue:${pendingIssueNumber}`,
    );
    expect(pendingBoardStory).toMatchObject({
      stage: "validating",
      ciState: "pending",
      prs: [
        expect.objectContaining({ number: pendingPullNumber, draft: false, ciState: "pending" }),
      ],
    });
    const pendingDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${pendingIssueNumber}?${issueQuery}`,
      headers: { cookie },
    });
    expect(pendingDetail.statusCode, pendingDetail.body).toBe(200);
    expect(pendingDetail.json()).toMatchObject({
      stage: { key: pendingBoardStory?.stage },
      prs: pendingBoardStory?.prs,
    });
    const successfulBoardStory = stories.find(
      (story) => story.key === `${repoA.id}:issue:${successfulIssueNumber}`,
    );
    expect(successfulBoardStory).toMatchObject({
      stage: "review",
      ciState: "success",
      ciFailureNames: [],
    });
    const successfulDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${successfulIssueNumber}?${issueQuery}`,
      headers: { cookie },
    });
    expect(successfulDetail.statusCode, successfulDetail.body).toBe(200);
    expect(successfulDetail.json()).toMatchObject({
      ciState: "success",
      ciUrl: `https://github.com/o/r/pull/${successfulPullNumber}/checks`,
    });
    const successfulActivity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${successfulIssueNumber}/github-activity?${issueQuery}`,
      headers: { cookie },
    });
    expect(successfulActivity.statusCode, successfulActivity.body).toBe(200);
    expect(successfulActivity.json().ciEvents).toEqual([
      expect.objectContaining({ pullNumber: successfulPullNumber, state: "pending" }),
      expect.objectContaining({ pullNumber: successfulPullNumber, state: "success" }),
    ]);
    const draftBoardStory = stories.find(
      (story) => story.key === `${repoA.id}:issue:${draftIssueNumber}`,
    );
    expect(draftBoardStory).toMatchObject({
      stage: "building",
      prs: [expect.objectContaining({ number: draftPullNumber, draft: true })],
    });
    const draftDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${draftIssueNumber}?${issueQuery}`,
      headers: { cookie },
    });
    expect(draftDetail.statusCode, draftDetail.body).toBe(200);
    expect(draftDetail.json()).toMatchObject({
      stage: { key: draftBoardStory?.stage },
      prs: draftBoardStory?.prs,
    });
    const provenanceActivity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${provenanceIssueNumber}/github-activity?${issueQuery}`,
      headers: { cookie },
    });
    expect(provenanceActivity.statusCode, provenanceActivity.body).toBe(200);
    expect(provenanceActivity.json().prs).toEqual([
      expect.objectContaining({
        number: provenancePullNumber,
        title: `PR #${provenancePullNumber}`,
      }),
    ]);
    const runLinkedOrphan = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${pendingPullNumber}?${new URLSearchParams({ repoId: repoA.id, storyType: "pull_request" })}`,
      headers: { cookie },
    });
    expect(runLinkedOrphan.statusCode).toBe(404);
    expect(
      stories.find((story) => story.key === `${repoB.id}:pull_request:${number + 2}`),
    ).toMatchObject({ stage: "review", storyType: "pull_request", currentRun: null });
    expect(
      stories.find((story) => story.key === `${repoB.id}:pull_request:${number + 4}`),
    ).toMatchObject({ stage: "review", storyType: "pull_request", currentRun: null });

    const ambiguous = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues/${number}`,
      headers: { cookie },
    });
    expect(ambiguous.statusCode).toBe(409);

    const ambiguousTrigger = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/${number}/trigger`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(ambiguousTrigger.statusCode).toBe(409);

    const ambiguousStory = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number}`,
      headers: { cookie },
    });
    expect(ambiguousStory.statusCode).toBe(409);
    expect(ambiguousStory.json().error.code).toBe("ambiguous_story_number");

    const ambiguousActivity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number}/github-activity`,
      headers: { cookie },
    });
    expect(ambiguousActivity.statusCode).toBe(409);
    expect(ambiguousActivity.json().error.code).toBe("ambiguous_story_number");

    const oversizedIssue = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues/2147483648?repoId=${repoA.id}`,
      headers: { cookie },
    });
    expect(oversizedIssue.statusCode).toBe(400);
    const oversizedStory = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/2147483648?${issueQuery}`,
      headers: { cookie },
    });
    expect(oversizedStory.statusCode).toBe(400);
    const oversizedTrigger = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/2147483648/trigger?repoId=${repoA.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(oversizedTrigger.statusCode).toBe(400);
    const oversizedActivity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/2147483648/github-activity?${issueQuery}`,
      headers: { cookie },
    });
    expect(oversizedActivity.statusCode).toBe(400);

    const orphanQuery = new URLSearchParams({ repoId: repoB.id, storyType: "pull_request" });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number + 2}?${orphanQuery}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      key: `${repoB.id}:pull_request:${number + 2}`,
      bodyMd: "No issue closes this PR.",
      storyType: "pull_request",
    });

    const activity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number + 2}/github-activity?${orphanQuery}`,
      headers: { cookie },
    });
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.json().prs).toEqual([
      expect.objectContaining({ number: number + 2, title: "Human-created orphan PR" }),
    ]);

    const oldIssueQuery = new URLSearchParams({ repoId: repoB.id, storyType: "pull_request" });
    const oldIssueDetail = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number + 4}?${oldIssueQuery}`,
      headers: { cookie },
    });
    expect(oldIssueDetail.statusCode, oldIssueDetail.body).toBe(200);
    expect(oldIssueDetail.json()).toMatchObject({
      key: `${repoB.id}:pull_request:${number + 4}`,
      storyType: "pull_request",
    });
    const oldIssueActivity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/${number + 4}/github-activity?${oldIssueQuery}`,
      headers: { cookie },
    });
    expect(oldIssueActivity.statusCode, oldIssueActivity.body).toBe(200);
  });

  it("keeps fulfilled story comments when one linked PR comment fetch fails", async () => {
    const repo = await insertRepoWithInstallation(`activity-${Date.now()}`);
    const issueNumber = 95_000;
    const pullNumber = issueNumber + 1;
    await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, { closingIssues: [issueNumber] });
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            listComments: async (input: { issue_number: number }) => {
              if (input.issue_number === pullNumber) throw new Error("linked PR is inaccessible");
              return {
                data: [
                  {
                    id: issueNumber,
                    user: { login: "maintainer", type: "User" },
                    body: "Keep the issue conversation",
                    created_at: "2026-08-01T01:00:00Z",
                    html_url: `https://github.test/comment/${issueNumber}`,
                  },
                ],
              };
            },
          },
          repos: {},
          git: {},
          pulls: {},
        },
      }) as never;
    try {
      const query = new URLSearchParams({ repoId: repo.id, storyType: "issue" });
      const activity = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/stories/${issueNumber}/github-activity?${query}`,
        headers: { cookie },
      });

      expect(activity.statusCode, activity.body).toBe(200);
      expect(activity.json().comments).toEqual([
        expect.objectContaining({
          id: issueNumber,
          author: "maintainer",
          bodyMd: "Keep the issue conversation",
        }),
      ]);
      expect(activity.json().prs).toEqual([expect.objectContaining({ number: pullNumber })]);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("attaches a PR by editing its live GitHub body, rereading the snapshot, and replaying safely", async () => {
    const repo = await insertRepoWithInstallation(`attach-${Date.now()}`);
    const issueNumber = 96_100;
    const pullNumber = 96_101;
    await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, { bodyMd: "stale mirrored body" });

    let liveBody = "Latest body edited on GitHub";
    let linked = false;
    let updateCalls = 0;
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () =>
      ({
        graphql: async () => ({
          repository: {
            pullRequest: pullRequestNode(repo, pullNumber, liveBody, linked ? [issueNumber] : []),
          },
        }),
        rest: {
          issues: {},
          repos: {},
          git: {},
          pulls: {
            update: async (input: Record<string, unknown>) => {
              updateCalls += 1;
              liveBody = String(input.body);
              linked = true;
              return { data: {} };
            },
          },
        },
      }) as never;
    try {
      const idempotencyKey = `attach-pr-${Date.now()}`;
      const request = {
        method: "POST" as const,
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie, "idempotency-key": idempotencyKey },
        payload: { issueNumber },
      };
      const attached = await app.inject(request);
      const replayed = await app.inject(request);

      expect(attached.statusCode, attached.body).toBe(200);
      expect(attached.json()).toMatchObject({
        repoId: repo.id,
        pullNumber,
        issueNumber,
        closingIssues: [issueNumber],
        changed: true,
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.headers["idempotency-status"]).toBe("replayed");
      expect(updateCalls).toBe(1);
      expect(liveBody).toBe(`Closes #${issueNumber}\n\nLatest body edited on GitHub`);

      const mirrored = (
        await db
          .select()
          .from(ghPullRequests)
          .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, pullNumber)))
      )[0];
      expect(mirrored).toMatchObject({
        bodyMd: liveBody,
        closingIssues: [issueNumber],
      });
      const pipeline = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/pipeline`,
        headers: { cookie },
      });
      const stories = pipeline
        .json()
        .stages.flatMap((stage: { stories: unknown[] }) => stage.stories) as Array<{
        key: string;
        prs: Array<{ number: number }>;
      }>;
      expect(stories.find((story) => story.key === `${repo.id}:issue:${issueNumber}`)?.prs).toEqual(
        [expect.objectContaining({ number: pullNumber })],
      );
      expect(stories.some((story) => story.key === `${repo.id}:pull_request:${pullNumber}`)).toBe(
        false,
      );
      const audits = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, orgId),
            eq(auditEvents.action, "github.closing_issue.attached"),
            sql`${auditEvents.payload}->>'repoId' = ${repo.id}`,
            sql`${auditEvents.payload}->>'pullNumber' = ${String(pullNumber)}`,
          ),
        );
      expect(audits).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("never invents a local link when GitHub does not confirm the edited body", async () => {
    const repo = await insertRepoWithInstallation(`unconfirmed-${Date.now()}`);
    const issueNumber = 96_200;
    const pullNumber = 96_201;
    await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, { bodyMd: "stale body" });

    let liveBody = "Current human body";
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () =>
      ({
        graphql: async () => ({
          repository: { pullRequest: pullRequestNode(repo, pullNumber, liveBody, []) },
        }),
        rest: {
          issues: {},
          repos: {},
          git: {},
          pulls: {
            update: async (input: Record<string, unknown>) => {
              liveBody = String(input.body);
              return { data: {} };
            },
          },
        },
      }) as never;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie },
        payload: { issueNumber },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("closing_issue_not_confirmed");
      expect(liveBody).toBe(`Closes #${issueNumber}\n\nCurrent human body`);
      const mirrored = (
        await db
          .select()
          .from(ghPullRequests)
          .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, pullNumber)))
      )[0];
      expect(mirrored?.closingIssues).toEqual([]);
      const pipeline = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/pipeline`,
        headers: { cookie },
      });
      const storyKeys = pipeline
        .json()
        .stages.flatMap((stage: { stories: Array<{ key: string }> }) =>
          stage.stories.map((story) => story.key),
        );
      expect(storyKeys).toContain(`${repo.id}:pull_request:${pullNumber}`);
      const audits = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, orgId),
            eq(auditEvents.action, "github.closing_issue.attached_unconfirmed"),
            sql`${auditEvents.payload}->>'repoId' = ${repo.id}`,
            sql`${auditEvents.payload}->>'pullNumber' = ${String(pullNumber)}`,
          ),
        );
      expect(audits).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("refuses to attach a PR that does not target the repository default branch", async () => {
    const repo = await insertRepoWithInstallation(`attach-base-${Date.now()}`);
    const issueNumber = 96_250;
    const pullNumber = 96_251;
    await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, { baseRef: "release" });

    let updateCalls = 0;
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () =>
      ({
        graphql: async () => ({
          repository: {
            pullRequest: {
              ...pullRequestNode(repo, pullNumber, "Implementation details", []),
              baseRefName: "release",
            },
          },
        }),
        rest: {
          issues: {},
          repos: {},
          git: {},
          pulls: {
            update: async () => {
              updateCalls += 1;
              return { data: {} };
            },
          },
        },
      }) as never;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie },
        payload: { issueNumber },
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("pull_request_not_on_default_branch");
      expect(updateCalls).toBe(0);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("detaches only Facility's exact closing line and rereads GitHub before clearing the mirror", async () => {
    const repo = await insertRepoWithInstallation(`detach-${Date.now()}`);
    const issueNumber = 96_300;
    const pullNumber = 96_301;
    await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, {
      bodyMd: `Closes #${issueNumber}\n\nImplementation details`,
      closingIssues: [issueNumber],
    });

    let liveBody = `Closes #${issueNumber}\n\nImplementation details`;
    let linked = true;
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () =>
      ({
        graphql: async () => ({
          repository: {
            pullRequest: pullRequestNode(repo, pullNumber, liveBody, linked ? [issueNumber] : []),
          },
        }),
        rest: {
          issues: {},
          repos: {},
          git: {},
          pulls: {
            update: async (input: Record<string, unknown>) => {
              liveBody = String(input.body);
              linked = false;
              return { data: {} };
            },
          },
        },
      }) as never;
    try {
      const detached = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues/${issueNumber}?repoId=${repo.id}`,
        headers: { cookie },
      });
      expect(detached.statusCode, detached.body).toBe(200);
      expect(detached.json()).toMatchObject({ closingIssues: [], changed: true });
      expect(liveBody).toBe("Implementation details");
      const mirrored = (
        await db
          .select()
          .from(ghPullRequests)
          .where(and(eq(ghPullRequests.repoId, repo.id), eq(ghPullRequests.number, pullNumber)))
      )[0];
      expect(mirrored?.closingIssues).toEqual([]);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("rejects malformed, cross-repository, unauthorized, suspended, and unsafe detach inputs", async () => {
    const repo = await insertRepoWithInstallation(`link-guards-${Date.now()}`);
    const otherRepo = await insertRepo({ owner: `other-link-${Date.now()}`, name: "repo" });
    const issueNumber = 96_400;
    const pullNumber = 96_401;
    await insertIssue(otherRepo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
    await insertPullRequest(repo.id, pullNumber, { closingIssues: [issueNumber] });

    let githubCalls = 0;
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = async () => {
      githubCalls += 1;
      return {
        graphql: async () => ({
          repository: {
            pullRequest: pullRequestNode(repo, pullNumber, `Fixes #${issueNumber}`, [issueNumber]),
          },
        }),
        rest: { issues: {}, repos: {}, git: {}, pulls: { update: async () => ({ data: {} }) } },
      } as never;
    };
    try {
      const malformed = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie },
        payload: { issueNumber: 0 },
      });
      expect(malformed.statusCode).toBe(400);
      const crossRepo = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie },
        payload: { issueNumber },
      });
      expect(crossRepo.statusCode).toBe(404);
      expect(crossRepo.json().error.code).toBe("same_repository_issue_not_found");
      expect(githubCalls).toBe(0);

      await insertIssue(repo.id, issueNumber, "open", "2026-08-01T00:00:00Z");
      const viewer = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: viewer.id,
        orgId,
        name: `link-viewer-${Date.now()}`,
        prefix: viewer.lookup,
        last4: viewer.last4,
        hash: viewer.hash,
        scopeType: "org",
        roleId: "role_bundled_viewer",
      });
      const forbidden = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { authorization: `Bearer ${viewer.secret}` },
        payload: { issueNumber },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(githubCalls).toBe(0);

      const unsafeDetach = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues/${issueNumber}?repoId=${repo.id}`,
        headers: { cookie },
      });
      expect(unsafeDetach.statusCode, unsafeDetach.body).toBe(409);
      expect(unsafeDetach.json().error.code).toBe("closing_issue_not_detachable");

      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date() })
        .where(eq(githubInstallations.id, repo.installationId ?? ""));
      const suspended = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/pulls/${pullNumber}/closing-issues?repoId=${repo.id}`,
        headers: { cookie },
        payload: { issueNumber },
      });
      expect(suspended.statusCode).toBe(409);
      expect(suspended.json().error.code).toBe("installation_suspended");
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("routes approved issue updates to the requested repository and rejects ambiguity", async () => {
    const number = 90_000;
    const repoA = await insertRepo({ owner: `updates-a-${Date.now()}`, name: "repo" });
    const repoB = await insertRepo({ owner: `updates-b-${Date.now()}`, name: "repo" });
    await insertIssue(repoA.id, number, "open", "2026-08-01T00:00:00Z");
    await insertIssue(repoB.id, number, "open", "2026-08-01T00:00:00Z");
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        actionType: "issue_update",
        payload: { issueNumber: number, repoId: repoB.id, title: "Repo B title", bodyMd: "Body" },
        contextMd: "Repository-qualified issue update",
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    await db
      .update(proposals)
      .set({ state: "approved" })
      .where(eq(proposals.id, proposed.json().id));
    const [candidate] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposed.json().id));
    if (!candidate) throw new Error("proposal fixture missing");
    const updates: Array<{ number: number; title: string; body: string }> = [];
    await executeApprovedProposal(
      db,
      candidate,
      { type: "user", id: userId },
      {
        github: {
          createIssue: async () => ({ number: 1, url: "https://github.test/issues/1" }),
          updateIssue: async (input) => {
            updates.push(input);
          },
        },
      },
    );
    expect(updates).toEqual([{ number, title: "Repo B title", body: "Body" }]);
    const [issueA] = await db
      .select()
      .from(ghIssues)
      .where(and(eq(ghIssues.repoId, repoA.id), eq(ghIssues.number, number)));
    const [issueB] = await db
      .select()
      .from(ghIssues)
      .where(and(eq(ghIssues.repoId, repoB.id), eq(ghIssues.number, number)));
    expect(issueA?.title).toBe(`Issue ${number}`);
    expect(issueB?.title).toBe("Repo B title");

    const ambiguous = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        actionType: "issue_update",
        payload: { issueNumber: number, title: "Wrong repo", bodyMd: "Body" },
        contextMd: "Missing repository identity",
      },
    });
    await db
      .update(proposals)
      .set({ state: "approved" })
      .where(eq(proposals.id, ambiguous.json().id));
    const [ambiguousCandidate] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, ambiguous.json().id));
    if (!ambiguousCandidate) throw new Error("ambiguous proposal fixture missing");
    await executeApprovedProposal(
      db,
      ambiguousCandidate,
      { type: "user", id: userId },
      {
        github: {
          createIssue: async () => ({ number: 1, url: "https://github.test/issues/1" }),
          updateIssue: async () => {
            throw new Error("ambiguous update reached GitHub");
          },
        },
      },
    );
    const [failed] = await db.select().from(proposals).where(eq(proposals.id, ambiguous.json().id));
    expect(failed?.state).toBe("execution_failed");
  });

  it("directly triggers an agent run for a mirrored issue", async () => {
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    app.enqueue = async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    };
    const assigned: Array<{ number: number; logins: string[] }> = [];
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            get: async (input: { issue_number: number }) => ({
              data: {
                number: input.issue_number,
                title: "Deliver complete error states",
                body: "Update agencies and people detail routes.",
                user: { login: "issue-author" },
                labels: [{ name: "delivery" }, { name: "frontend" }],
                html_url: `https://github.test/issues/${input.issue_number}`,
              },
            }),
            listComments: async () => ({
              data: [
                {
                  id: 4401,
                  user: { login: "maintainer", type: "User" },
                  body: "Keep the existing loading behavior.",
                  created_at: "2026-08-01T00:00:00Z",
                  html_url: "https://github.test/comments/4401",
                },
              ],
            }),
            createComment: async () => ({ data: { id: 1, html_url: "https://example.test/c" } }),
            addAssignees: async (input: { issue_number: number; assignees: string[] }) => {
              assigned.push({ number: input.issue_number, logins: input.assignees });
              return { data: { assignees: [{ login: "platform-owner" }] } };
            },
          },
          repos: {
            getContent: async () => ({
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(
                  JSON.stringify({
                    packageInstall: "pnpm install --frozen-lockfile",
                    checks: ["pnpm verify"],
                    executionLane: { architect: "platform", builder: "platform" },
                  }),
                ).toString("base64"),
              },
            }),
          },
          git: {},
          pulls: {},
        },
      }) as never;
    const repo = await insertRepoWithInstallation(`trigger-${Date.now()}`);
    await insertIssue(repo.id, 44, "open", "2026-03-01T00:00:00Z");
    const storyBuilder = await insertAgent("builder");
    await db
      .update(agentDefs)
      .set({
        name: "delivery-specialist",
        triggers: [{ type: "command", handle: "/builder" }],
      })
      .where(eq(agentDefs.id, storyBuilder.id));

    const forged = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/runs`,
      headers: { cookie },
      payload: {
        agent: "builder",
        trigger: {
          source: "manual",
          message: "Verify authenticated GitHub assignment",
          githubLogin: "forged-user",
        },
      },
    });
    expect(forged.statusCode, forged.body).toBe(200);
    expect(forged.json().trigger.githubLogin).toBe("platform-owner");

    const serviceKey = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: serviceKey.id,
      orgId,
      name: "github-login-forgery",
      prefix: serviceKey.lookup,
      last4: serviceKey.last4,
      hash: serviceKey.hash,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_maintainer",
    });
    const forgedByKey = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/runs`,
      headers: { authorization: `Bearer ${serviceKey.secret}` },
      payload: {
        agent: "builder",
        trigger: {
          source: "manual",
          message: "Verify authenticated GitHub assignment",
          githubLogin: "forged-user",
        },
      },
    });
    expect(forgedByKey.statusCode, forgedByKey.body).toBe(200);
    expect(forgedByKey.json().trigger).not.toHaveProperty("githubLogin");

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/44/trigger`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("builder");
    expect(response.json().gh.issueNumber).toBe(44);
    const [manifestSyncedRepo] = await db.select().from(repos).where(eq(repos.id, repo.id));
    expect(manifestSyncedRepo?.renderAnswers).toMatchObject({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      checkCmds: ["pnpm verify"],
      execution_lane: { architect: "platform", builder: "platform" },
    });
    expect(response.json().trigger.request).toEqual({
      title: "Deliver complete error states",
      body: "Update agencies and people detail routes.",
      comment: null,
      author: "issue-author",
      url: "https://github.test/issues/44",
      labels: ["delivery", "frontend"],
      comments: [
        {
          id: 4401,
          author: "maintainer",
          authorType: "User",
          body: "Keep the existing loading behavior.",
          createdAt: "2026-08-01T00:00:00Z",
          url: "https://github.test/comments/4401",
        },
      ],
    });
    const event = (
      await db.select().from(runEvents).where(eq(runEvents.runId, response.json().id))
    )[0];
    expect(event?.seq).toBe(1);
    expect(event?.type).toBe("queued");
    expect(enqueued).toContainEqual({
      queue: "runs.dispatch",
      data: { runId: response.json().id, orgId },
    });
    expect(assigned).toContainEqual({ number: 44, logins: ["platform-owner"] });

    await insertIssue(repo.id, 45, "open", "2026-03-01T00:00:01Z");
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            get: async (input: { issue_number: number }) => ({
              data: {
                number: input.issue_number,
                title: `Issue ${input.issue_number}`,
                body: "Body",
                user: { login: "author" },
                labels: [],
                html_url: `https://github.test/issues/${input.issue_number}`,
              },
            }),
            listComments: async () => ({ data: [] }),
            addAssignees: async () => ({ data: { assignees: [] } }),
            createComment: async () => ({ data: { id: 2 } }),
          },
          repos: repositoryApiWithoutFacilityManifest(),
          git: {},
          pulls: {},
        },
      }) as never;
    const dropped = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/45/trigger?repoId=${repo.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    const [assignmentAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.payload}->>'runId' = ${dropped.json().id}`,
        ),
      );
    expect(assignmentAudit?.payload).toMatchObject({
      login: "platform-owner",
      reason: "github_rejected",
    });

    await insertIssue(repo.id, 46, "open", "2026-03-01T00:00:02Z");
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            get: async (input: { issue_number: number }) => ({
              data: {
                number: input.issue_number,
                title: `Issue ${input.issue_number}`,
                body: "Body",
                user: { login: "author" },
                labels: [],
                html_url: `https://github.test/issues/${input.issue_number}`,
              },
            }),
            listComments: async () => ({ data: [] }),
            addAssignees: async () => {
              throw new Error("assignment permission denied");
            },
            createComment: async () => ({ data: { id: 3 } }),
          },
          repos: repositoryApiWithoutFacilityManifest(),
          git: {},
          pulls: {},
        },
      }) as never;
    const assignmentFailure = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/46/trigger?repoId=${repo.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(assignmentFailure.statusCode, assignmentFailure.body).toBe(200);
    const [failureAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.payload}->>'runId' = ${assignmentFailure.json().id}`,
        ),
      );
    expect(failureAudit?.payload).toMatchObject({
      login: "platform-owner",
      reason: "assignment permission denied",
    });

    await insertIssue(repo.id, 47, "open", "2026-03-01T00:00:03Z");
    await db.update(userIdentities).set({ login: null }).where(eq(userIdentities.userId, userId));
    const missingLogin = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/47/trigger?repoId=${repo.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    await db
      .update(userIdentities)
      .set({ login: "platform-owner" })
      .where(eq(userIdentities.userId, userId));
    expect(missingLogin.statusCode, missingLogin.body).toBe(200);
    const [missingLoginAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.payload}->>'runId' = ${missingLogin.json().id}`,
        ),
      );
    expect(missingLoginAudit?.payload).toMatchObject({
      login: null,
      reason: "missing_github_login",
    });

    await insertIssue(repo.id, 48, "open", "2026-03-01T00:00:04Z");
    await insertIssue(repo.id, 49, "open", "2026-03-01T00:00:05Z");
    app.githubClientFactory = async () =>
      ({
        rest: {
          issues: {
            get: async (input: { issue_number: number }) => {
              if (input.issue_number === 48) throw new Error("GitHub issue read failed");
              return {
                data: {
                  number: input.issue_number,
                  title: `Issue ${input.issue_number}`,
                  body: "x".repeat(512 * 1024),
                  user: { login: "author" },
                  labels: [],
                  html_url: `https://github.test/issues/${input.issue_number}`,
                },
              };
            },
            listComments: async () => ({ data: [] }),
          },
          repos: repositoryApiWithoutFacilityManifest(),
          git: {},
          pulls: {},
        },
      }) as never;
    const unavailableContext = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/48/trigger?repoId=${repo.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(unavailableContext.statusCode).toBe(500);
    const oversizedContext = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/issues/49/trigger?repoId=${repo.id}`,
      headers: { cookie },
      payload: { agent: "builder" },
    });
    expect(oversizedContext.statusCode).toBe(413);
    expect(oversizedContext.json().error.code).toBe("issue_context_too_large");
    const rejectedContextRuns = await db
      .select()
      .from(runs)
      .where(
        and(eq(runs.projectId, projectId), sql`(${runs.gh}->>'issueNumber')::int in (48, 49)`),
      );
    expect(rejectedContextRuns).toHaveLength(0);

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

  it("denies Story Build before GitHub access, row creation, or enqueue when plans are required", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const governedProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: `Governed Story Build ${suffix}`,
          slug: `governed-story-build-${suffix}`,
          builderPlanPolicy: "required",
          settings: {},
        })
        .returning()
    )[0];
    if (!governedProject) throw new Error("governed project insert failed");
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId: governedProject.id,
          kind: "agent_contract",
          name: `governed-story-build-${suffix}`,
          latestVersion: 1,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("governed contract insert failed");
    const governedBuilder = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId: governedProject.id,
          name: "delivery-specialist",
          engine: "codex",
          model: { primary: "gpt-5.5" },
          contractItemId: contract.id,
          triggers: [{ type: "command", handle: "/builder" }],
          enabled: true,
        })
        .returning()
    )[0];
    if (!governedBuilder) throw new Error("governed Builder insert failed");
    const governedRepo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId: governedProject.id,
          owner: `governed-story-${suffix}`,
          name: "facility",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!governedRepo) throw new Error("governed repository insert failed");
    await db.insert(ghIssues).values({
      id: newId("ghi"),
      orgId,
      projectId: governedProject.id,
      repoId: governedRepo.id,
      number: 204,
      title: "Build only after Gate 1",
      state: "open",
      labels: [],
      assignees: [],
      htmlUrl: `https://github.test/${governedRepo.owner}/${governedRepo.name}/issues/204`,
    });

    const originalFactory = app.githubClientFactory;
    const originalEnqueue = app.enqueue;
    let githubFactoryCalls = 0;
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    app.githubClientFactory = async () => {
      githubFactoryCalls += 1;
      throw new Error("Story Build denial reached GitHub");
    };
    app.enqueue = async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    };
    const before = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.projectId, governedProject.id));
    try {
      const denied = await app.inject({
        method: "POST",
        url: `/v1/projects/${governedProject.id}/issues/204/trigger?repoId=${governedRepo.id}`,
        headers: { cookie },
        payload: { agent: "builder" },
      });
      expect(denied.statusCode, denied.body).toBe(409);
      expect(denied.json().error.code).toBe("builder_plan_required");
      expect(
        await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, governedProject.id)),
      ).toHaveLength(before.length);
      expect(githubFactoryCalls).toBe(0);
      expect(enqueued).toEqual([]);
      const denial = (
        await db.select().from(auditEvents).where(eq(auditEvents.projectId, governedProject.id))
      ).find((event) => event.action === "run.builder_plan_denied");
      expect(denial).toMatchObject({
        payload: { code: "builder_plan_required", source: "web_issue_preflight" },
      });
    } finally {
      app.githubClientFactory = originalFactory;
      app.enqueue = originalEnqueue;
    }
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
    const pipeline = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/pipeline`,
      headers: auth,
    });
    expect(pipeline.statusCode).toBe(404);
    const storyQuery = new URLSearchParams({ repoId: "repo_scoped", storyType: "issue" });
    const story = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/44?${storyQuery}`,
      headers: auth,
    });
    expect(story.statusCode).toBe(404);
    const activity = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/stories/44/github-activity?${storyQuery}`,
      headers: auth,
    });
    expect(activity.statusCode).toBe(404);
    const attach = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/pulls/45/closing-issues?repoId=repo_scoped`,
      headers: auth,
      payload: { issueNumber: 44 },
    });
    expect(attach.statusCode).toBe(404);
  });

  it("lists installations and installation repositories with org isolation", async () => {
    const installation = await insertInstallation(`inst-${Date.now()}`);
    const otherOrgId = newId("org");
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Other Inst", slug: `inst-${Date.now()}` });
    const otherInstallationId = nextInstallationId();
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
            expectedHeadSha: null,
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
    const createdPulls: Array<Record<string, unknown>> = [];
    const finished = await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/agent-owned-delivery",
          headSha: "abc123",
          pullRequestTitle: "feat: deliver agent-owned metadata",
          pullRequestBody: "## Summary\n\n- Preserve the builder's exact PR metadata.",
        },
      },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async (input: Record<string, unknown>) => {
                  createdPulls.push(input);
                  return {
                    data: { number: 12, html_url: "https://github.com/o/r/pull/12" },
                  };
                },
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
    expect(createdPulls).toContainEqual(
      expect.objectContaining({
        head: "feature/agent-owned-delivery",
        title: "feat: deliver agent-owned metadata",
        body: "## Summary\n\n- Preserve the builder's exact PR metadata.",
        draft: true,
      }),
    );
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect((stored?.gh as { pr?: { number?: number } }).pr?.number).toBe(12);
    const [outcome] = await db.select().from(outcomes).where(eq(outcomes.runId, run.id));
    expect(outcome?.prNumber).toBe(12);
  });

  it("blocks SHA drift without creating a PR and permits an authorized retry", async () => {
    const repo = await insertRepoWithInstallation(`delivery-sha-${Date.now()}`);
    const run = await insertRun({
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 91 },
      workspaceBaseSha: "b".repeat(40),
    });
    const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    await finishRun(
      db,
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/exact-delivery",
          headSha: "expected-sha",
          baseSha: "a".repeat(40),
          pullRequestTitle: "fix: bind delivery to the pushed commit",
          pullRequestBody: "Exact delivery",
        },
      },
      {
        config,
        enqueue: async (queue, data) => {
          queued.push({ queue, data });
          return null;
        },
      },
    );
    expect(queued).toContainEqual({ queue: "deliveries.deliver", data: { runId: run.id } });
    const [pending] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(pending).toMatchObject({
      status: "pending",
      owner: repo.owner,
      repoName: repo.name,
      expectedHeadSha: "expected-sha",
      baseSha: "a".repeat(40),
    });
    const [finishedRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect((finishedRun?.receipt as { github?: { base_sha?: string } })?.github?.base_sha).toBe(
      "a".repeat(40),
    );

    let createCalls = 0;
    const blocked = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      // Round-trip the stored millisecond value. A database default with extra
      // microseconds would make this freshly queued row incorrectly ineligible.
      now: pending?.nextAttemptAt,
      githubClientFactory: async () =>
        ({
          rest: {
            git: { getRef: async () => ({ data: { object: { sha: "moved-sha" } } }) },
            pulls: {
              create: async () => {
                createCalls += 1;
                return { data: { number: 92, html_url: "https://github.test/pr/92" } };
              },
            },
            issues: {},
            repos: {},
          },
        }) as never,
    });
    expect(blocked).toEqual([{ runId: run.id, status: "blocked" }]);
    expect(createCalls).toBe(0);
    const [blockedRow] = await db
      .select()
      .from(runDeliveries)
      .where(eq(runDeliveries.runId, run.id));
    expect(blockedRow).toMatchObject({ status: "blocked", blockedReason: "head_sha_mismatch" });
    const [successfulRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(successfulRun).toMatchObject({ status: "succeeded", error: null });
    expect((successfulRun?.gh as { pr?: unknown }).pr).toBeUndefined();

    const viewer = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: viewer.id,
      orgId,
      name: `delivery-viewer-${Date.now()}`,
      prefix: viewer.lookup,
      last4: viewer.last4,
      hash: viewer.hash,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_viewer",
    });
    const visible = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/delivery`,
      headers: { authorization: `Bearer ${viewer.secret}` },
    });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json()).toMatchObject({
      runId: run.id,
      status: "blocked",
      blockedReason: "head_sha_mismatch",
    });
    const denied = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/delivery/retry`,
      headers: { authorization: `Bearer ${viewer.secret}` },
    });
    expect(denied.statusCode).toBe(403);
    const retried = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/delivery/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: "pending", attempts: 0 });

    const recovered = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: deliveryFactory({
        branch: "feature/exact-delivery",
        headSha: "expected-sha",
        number: 92,
      }),
    });
    expect(recovered).toEqual([{ runId: run.id, status: "delivered" }]);
  });

  it("blocks a deleted delivery branch instead of retrying it forever", async () => {
    const repo = await insertRepoWithInstallation(`delivery-missing-head-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/deleted-before-delivery",
        headSha: "deleted-sha",
        pullRequestTitle: "fix: handle a deleted delivery branch",
        pullRequestBody: "Require operator repair.",
      },
    });
    let createCalls = 0;
    const result = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: async () =>
        ({
          rest: {
            git: {
              getRef: async () => {
                throw Object.assign(new Error("Not Found"), { status: 404 });
              },
            },
            pulls: {
              create: async () => {
                createCalls += 1;
                return { data: { number: 1, html_url: "https://github.test/pr/1" } };
              },
            },
            issues: {},
            repos: {},
          },
        }) as never,
    });
    expect(result).toEqual([{ runId: run.id, status: "blocked" }]);
    expect(createCalls).toBe(0);
    const [delivery] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(delivery).toMatchObject({ status: "blocked", blockedReason: "head_branch_missing" });
  });

  it("adopts the exact existing PR after a create-before-persist crash", async () => {
    const repo = await insertRepoWithInstallation(`delivery-adopt-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/adopt-exact",
        headSha: "adopt-sha",
        pullRequestTitle: "fix: recover delivery",
        pullRequestBody: "Recover the external PR.",
      },
    });
    let createCalls = 0;
    const delivered = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: async () =>
        ({
          rest: {
            git: { getRef: async () => ({ data: { object: { sha: "adopt-sha" } } }) },
            pulls: {
              list: async () => ({
                data: [
                  {
                    number: 93,
                    html_url: "https://github.test/pr/93",
                    head: { ref: "feature/adopt-exact", sha: "adopt-sha" },
                    base: { ref: "main" },
                  },
                ],
              }),
              create: async () => {
                createCalls += 1;
                return { data: { number: 94, html_url: "https://github.test/pr/94" } };
              },
            },
            issues: {},
            repos: {},
          },
        }) as never,
    });
    expect(delivered).toEqual([{ runId: run.id, status: "delivered" }]);
    expect(createCalls).toBe(0);
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect((stored?.gh as { pr?: { number?: number } }).pr?.number).toBe(93);
  });

  it("adopts the exact PR when GitHub reports a concurrent-create conflict", async () => {
    const repo = await insertRepoWithInstallation(`delivery-race-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/concurrent-create",
        headSha: "race-sha",
        pullRequestTitle: "fix: adopt a concurrent delivery",
        pullRequestBody: "Recover the create race.",
      },
    });
    let listCalls = 0;
    let createCalls = 0;
    const result = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: async () =>
        ({
          rest: {
            git: { getRef: async () => ({ data: { object: { sha: "race-sha" } } }) },
            pulls: {
              list: async () => {
                listCalls += 1;
                return {
                  data:
                    listCalls === 1
                      ? []
                      : [
                          {
                            number: 95,
                            html_url: "https://github.test/pr/95",
                            head: { ref: "feature/concurrent-create", sha: "race-sha" },
                            base: { ref: "main" },
                          },
                        ],
                };
              },
              create: async () => {
                createCalls += 1;
                throw Object.assign(new Error("already exists"), { status: 422 });
              },
            },
            issues: {},
            repos: {},
          },
        }) as never,
    });
    expect(result).toEqual([{ runId: run.id, status: "delivered" }]);
    expect({ listCalls, createCalls }).toEqual({ listCalls: 2, createCalls: 1 });
  });

  it("prevents a stale worker from overwriting a newer delivery lease", async () => {
    const repo = await insertRepoWithInstallation(`delivery-lease-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/leased-delivery",
        headSha: "lease-sha",
        pullRequestTitle: "fix: fence stale delivery workers",
        pullRequestBody: "A stale lease cannot finalize.",
      },
    });
    const oldLeaseAt = new Date("2026-08-01T00:00:00.000Z");
    const newerLeaseAt = new Date("2026-08-01T00:06:00.000Z");
    const [oldLease] = await db
      .update(runDeliveries)
      .set({ status: "delivering", attempts: 1, updatedAt: oldLeaseAt })
      .where(eq(runDeliveries.runId, run.id))
      .returning();
    if (!oldLease) throw new Error("old delivery lease fixture missing");
    await db
      .update(runDeliveries)
      .set({ status: "delivering", attempts: 2, updatedAt: newerLeaseAt })
      .where(eq(runDeliveries.runId, run.id));

    await expect(
      publishRunDelivery(db, oldLease, {
        config,
        githubClientFactory: deliveryFactory({
          branch: "feature/leased-delivery",
          headSha: "lease-sha",
          number: 96,
        }),
      }),
    ).rejects.toBeInstanceOf(RunDeliveryLeaseLostError);
    const [current] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(current).toMatchObject({ status: "delivering", attempts: 2, prNumber: null });
    expect(current?.updatedAt).toEqual(newerLeaseAt);
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect((stored?.gh as { pr?: unknown }).pr).toBeUndefined();
    const producedOutcomes = await db.select().from(outcomes).where(eq(outcomes.runId, run.id));
    expect(producedOutcomes).toHaveLength(0);
  });

  it("prevents a stale worker from signalling a blocked delivery after lease takeover", async () => {
    const repo = await insertRepoWithInstallation(`delivery-blocked-lease-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/blocked-lease",
        headSha: "blocked-lease-sha",
        pullRequestTitle: "fix: fence stale blocked delivery workers",
        pullRequestBody: "A stale lease cannot emit blocked side effects.",
      },
    });
    const now = new Date("2026-08-06T12:00:00.000Z");
    const newerLeaseAt = new Date("2026-08-06T12:00:00.001Z");
    await db
      .update(runDeliveries)
      .set({
        status: "delivering",
        attempts: 1,
        updatedAt: new Date(now.getTime() - 6 * 60_000),
      })
      .where(eq(runDeliveries.runId, run.id));

    const result = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      now,
      githubClientFactory: async () =>
        ({
          rest: {
            git: {
              getRef: async () => {
                await db
                  .update(runDeliveries)
                  .set({ status: "delivering", attempts: 3, updatedAt: newerLeaseAt })
                  .where(eq(runDeliveries.runId, run.id));
                return { data: { object: { sha: "moved-after-takeover" } } };
              },
            },
            pulls: { create: async () => ({ data: { number: 97, html_url: "unused" } }) },
            issues: {},
            repos: {},
          },
        }) as never,
    });

    expect(result).toEqual([{ runId: run.id, status: "pending" }]);
    const [current] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(current).toMatchObject({
      status: "delivering",
      attempts: 3,
      blockedReason: null,
      error: null,
    });
    expect(current?.updatedAt).toEqual(newerLeaseAt);
    const artifacts = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "artifact_error")));
    expect(artifacts).toHaveLength(0);
    const issues = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, `pr_delivery_pending:${run.id}`));
    expect(issues).toHaveLength(0);
  });

  it("blocks a forged cross-tenant repository binding before requesting a GitHub token", async () => {
    const repo = await insertRepoWithInstallation(`delivery-scope-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/scoped-delivery",
        headSha: "scope-sha",
        pullRequestTitle: "fix: preserve tenant scope",
        pullRequestBody: "Tenant-bound delivery.",
      },
    });
    const foreignOrgId = newId("org");
    await db
      .insert(orgs)
      .values({ id: foreignOrgId, name: "Foreign delivery org", slug: `foreign-${Date.now()}` });
    const foreignProjectId = newId("proj");
    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: foreignOrgId,
      name: "Foreign delivery project",
      slug: `foreign-project-${Date.now()}`,
      settings: {},
    });
    const foreignInstallation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId: foreignOrgId,
          installationId: nextInstallationId(),
          accountLogin: "foreign",
          targetType: "Organization",
        })
        .returning()
    )[0];
    const foreignRepo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId: foreignOrgId,
          projectId: foreignProjectId,
          installationId: foreignInstallation?.id,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: "main",
        })
        .returning()
    )[0];
    await db
      .update(runDeliveries)
      .set({ repoId: foreignRepo?.id as string })
      .where(eq(runDeliveries.runId, run.id));
    let factoryCalls = 0;
    const result = await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: async () => {
        factoryCalls += 1;
        throw new Error("must not request a foreign installation token");
      },
    });
    expect(result).toEqual([{ runId: run.id, status: "blocked" }]);
    expect(factoryCalls).toBe(0);
    const [delivery] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(delivery).toMatchObject({ status: "blocked", blockedReason: "repo_scope_mismatch" });
  });

  it("keeps retrying transient delivery failures beyond the webhook retry budget", async () => {
    const repo = await insertRepoWithInstallation(`delivery-retry-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/retry-forever",
        headSha: "retry-sha",
        pullRequestTitle: "fix: retry durable delivery",
        pullRequestBody: "Do not abandon completed work.",
      },
    });
    const factory: GithubClientFactory = async () =>
      ({
        rest: {
          git: { getRef: async () => ({ data: { object: { sha: "retry-sha" } } }) },
          pulls: {
            list: async () => ({ data: [] }),
            create: async () => {
              throw new Error("github unavailable");
            },
          },
          issues: {},
          repos: {},
        },
      }) as never;
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const result = await deliverPendingRunDeliveries(db, config, {
        runId: run.id,
        now: new Date(Date.now() + attempt * 2 * 24 * 60 * 60_000),
        githubClientFactory: factory,
      });
      expect(result).toEqual([{ runId: run.id, status: "pending" }]);
    }
    const [delivery] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(delivery).toMatchObject({ status: "pending", attempts: 9, error: "github unavailable" });
  });

  it("fails loudly and preserves pushed git metadata when the bound repository disappeared", async () => {
    const run = await insertRun({
      status: "running",
      gh: { owner: `missing-${Date.now()}`, repo: "repository" },
    });
    const finished = await finishRun(db, run, {
      status: "succeeded",
      git: {
        changed: true,
        branch: "feature/preserved-branch",
        headSha: "preserved-sha",
        pullRequestTitle: "fix: preserve delivery metadata",
        pullRequestBody: "Keep the pushed ref actionable.",
      },
    });
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("delivery_repo_unresolvable:run_repo_missing_installation");
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(stored?.gh).toMatchObject({
      branch: "feature/preserved-branch",
      headSha: "preserved-sha",
    });
    const delivery = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(delivery).toHaveLength(0);
    const [issue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, `delivery_repo_unresolvable:${run.id}`));
    expect(issue?.state).toBe("open");
  });

  it("finishRun creates GitHub's closing link and assigns the persisted trigger login", async () => {
    const repo = await insertRepoWithInstallation(`finish-linked-${Date.now()}`);
    await insertIssue(repo.id, 57, "open", "2026-08-01T00:00:00Z");
    const run = await insertRun({
      status: "running",
      trigger: { type: "web_issue", githubLogin: "platform-owner" },
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 57 },
    });
    const createdPulls: Array<Record<string, unknown>> = [];
    const assignments: Array<Record<string, unknown>> = [];
    await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/57-linked",
          headSha: "linked57",
          pullRequestTitle: "feat: link and assign",
          pullRequestBody: "Implementation details",
        },
      },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async (input: Record<string, unknown>) => {
                  createdPulls.push(input);
                  return { data: { number: 58, html_url: "https://github.test/o/r/pull/58" } };
                },
              },
              issues: {
                addAssignees: async (input: Record<string, unknown>) => {
                  assignments.push(input);
                  return { data: { assignees: [{ login: "platform-owner" }] } };
                },
                createComment: async () => ({ data: { id: 1 } }),
              },
              repos: {},
              git: {},
            },
          }) as never,
      },
    );

    expect(createdPulls[0]).toMatchObject({ body: "Closes #57\n\nImplementation details" });
    expect(assignments[0]).toMatchObject({
      issue_number: 58,
      assignees: ["platform-owner"],
    });
    const skipped = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.target}->>'id' = ${"58"}`,
        ),
      );
    expect(skipped).toHaveLength(0);
  });

  it("finishRun treats PR assignment API errors as audited non-events", async () => {
    const repo = await insertRepoWithInstallation(`finish-assignment-error-${Date.now()}`);
    await insertIssue(repo.id, 59, "open", "2026-08-01T00:00:00Z");
    const run = await insertRun({
      status: "running",
      trigger: { type: "web_issue", githubLogin: "platform-owner" },
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 59 },
    });
    const finished = await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/59-assignment-error",
          headSha: "assignment59",
          pullRequestTitle: "feat: survive assignment errors",
          pullRequestBody: "Implementation details",
        },
      },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async () => ({
                  data: { number: 60, html_url: "https://github.test/o/r/pull/60" },
                }),
              },
              issues: {
                addAssignees: async () => {
                  throw new Error("assignment permission denied");
                },
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
    expect(stored).toMatchObject({ status: "succeeded" });
    expect((stored?.gh as { pr?: { number?: number } }).pr?.number).toBe(60);
    const [outcome] = await db.select().from(outcomes).where(eq(outcomes.runId, run.id));
    expect(outcome?.prNumber).toBe(60);
    const [assignmentAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.payload}->>'runId' = ${run.id}`,
        ),
      );
    expect(assignmentAudit?.payload).toMatchObject({
      pullNumber: 60,
      login: "platform-owner",
      reason: "assignment permission denied",
    });
  });

  it.each([
    {
      label: "GitHub silently rejects the assignee",
      issueNumber: 61,
      login: "platform-owner",
      reason: "github_rejected",
      assignmentCalls: 1,
    },
    {
      label: "the triggering user has no linked GitHub login",
      issueNumber: 63,
      login: null,
      reason: "missing_github_login",
      assignmentCalls: 0,
    },
  ])("finishRun succeeds and audits when $label", async (fixture) => {
    const repo = await insertRepoWithInstallation(
      `finish-assignment-skip-${fixture.issueNumber}-${Date.now()}`,
    );
    await insertIssue(repo.id, fixture.issueNumber, "open", "2026-08-01T00:00:00Z");
    const run = await insertRun({
      status: "running",
      trigger: {
        type: "web_issue",
        ...(fixture.login ? { githubLogin: fixture.login } : {}),
      },
      gh: { owner: repo.owner, repo: repo.name, issueNumber: fixture.issueNumber },
    });
    let assignmentCalls = 0;
    const pullNumber = fixture.issueNumber + 1;
    const finished = await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: `feature/${fixture.issueNumber}-assignment-skip`,
          headSha: `assignment${fixture.issueNumber}`,
          pullRequestTitle: "feat: survive skipped assignment",
          pullRequestBody: "Implementation details",
        },
      },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async () => ({
                  data: {
                    number: pullNumber,
                    html_url: `https://github.test/o/r/pull/${pullNumber}`,
                  },
                }),
              },
              issues: {
                addAssignees: async () => {
                  assignmentCalls += 1;
                  return { data: { assignees: [] } };
                },
                createComment: async () => ({ data: { id: 1 } }),
              },
              repos: {},
              git: {},
            },
          }) as never,
      },
    );

    expect(finished.status).toBe("succeeded");
    expect(assignmentCalls).toBe(fixture.assignmentCalls);
    const [assignmentAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "github.assignment.skipped"),
          sql`${auditEvents.payload}->>'runId' = ${run.id}`,
        ),
      );
    expect(assignmentAudit?.payload).toMatchObject({
      pullNumber,
      login: fixture.login,
      reason: fixture.reason,
    });
  });

  it("finishRun attaches an SSO-only Facility preview to a delivered PR", async () => {
    const repo = await insertRepoWithInstallation(`preview-${Date.now()}`);
    await db
      .update(repos)
      .set({
        renderAnswers: {
          preview: {
            enabled: true,
            image: ["ghcr.io/example/review-app:$", "{{ steps.delivery.outputs.head_sha }}"].join(
              "",
            ),
            command: ["node", "server.mjs"],
            port: 3000,
            readinessPath: "/healthz",
            ttlHours: 12,
          },
        },
      })
      .where(eq(repos.id, repo.id));
    const run = await insertRun({
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 56 },
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const comments: string[] = [];
    await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/preview",
          headSha: "preview123",
          pullRequestTitle: "feat: deliver preview",
          pullRequestBody: "## Summary\n\n- Deliver a preview environment.",
        },
      },
      {
        config,
        enqueue: async (queue, data) => {
          enqueued.push({ queue, data });
          return null;
        },
        githubClientFactory: async () =>
          ({
            rest: {
              pulls: {
                create: async () => ({
                  data: { number: 13, html_url: "https://github.com/o/r/pull/13" },
                }),
              },
              issues: {
                createComment: async ({ body }: { body: string }) => {
                  comments.push(body);
                  return { data: { id: 1 } };
                },
              },
              repos: {},
              git: {},
            },
          }) as never,
      },
    );
    const [preview] = await db
      .select()
      .from(previewSandboxes)
      .where(eq(previewSandboxes.runId, run.id));
    expect(preview).toMatchObject({
      repoId: repo.id,
      prNumber: 13,
      commitSha: "preview123",
      status: "provisioning",
      authMode: "facility_session",
      config: {
        image: "ghcr.io/example/review-app:preview123",
        port: 3000,
        readinessPath: "/healthz",
      },
    });
    expect(enqueued).toContainEqual({
      queue: "previews.provision",
      data: { previewId: preview?.id },
    });
    expect(comments.some((body) => body.includes(`/previews/${preview?.id}/open`))).toBe(true);
    expect(comments.some((body) => body.includes("organization SSO"))).toBe(true);
  });

  it("recovers a durable preview request when its first queue send fails", async () => {
    const repo = await insertRepoWithInstallation(`preview-queue-failure-${Date.now()}`);
    await db
      .update(repos)
      .set({
        renderAnswers: {
          preview: {
            enabled: true,
            image: "ghcr.io/example/review-app:{{ commit_sha }}",
            port: 3000,
          },
        },
      })
      .where(eq(repos.id, repo.id));
    const run = await insertRun({
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 57 },
    });
    const attempted: string[] = [];
    await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "feature/preview-queue-failure",
          headSha: "previewqueue123",
          pullRequestTitle: "feat: deliver durable preview",
          pullRequestBody: "## Summary\n\n- Recover the preview queue request.",
        },
      },
      {
        config,
        enqueue: async (queue) => {
          attempted.push(queue);
          if (queue === "previews.provision") throw new Error("queue_temporarily_unavailable");
          return null;
        },
        githubClientFactory: deliveryFactory({
          branch: "feature/preview-queue-failure",
          headSha: "previewqueue123",
          number: 14,
        }),
      },
    );

    const [preview] = await db
      .select()
      .from(previewSandboxes)
      .where(eq(previewSandboxes.runId, run.id));
    expect(preview).toMatchObject({
      repoId: repo.id,
      status: "provisioning",
      ref: null,
      provisionClaimedAt: null,
    });
    expect(attempted).toContain("previews.provision");

    const recovered: string[] = [];
    await expect(
      reconcilePreviews(config, undefined, async (previewId) => {
        recovered.push(previewId);
      }),
    ).resolves.toMatchObject({ requeued: expect.arrayContaining([preview?.id]) });
    expect(recovered).toContain(preview?.id);
  });

  it("finishRun publishes an architect plan and opens the human Gate 1 proposal", async () => {
    const repo = await insertRepoWithInstallation(`plan-${Date.now()}`);
    const workspaceBaseSha = "d".repeat(40);
    const issueRequest = {
      title: "Preserve Architect publication marker",
      body: "Publish one immutable plan.",
      state: "open",
      author: "maintainer",
      url: `https://github.test/${repo.owner}/${repo.name}/issues/71`,
      labels: ["governance"],
      comments: [],
    };
    const run = await insertRun({
      mode: "architect",
      status: "running",
      workspaceBaseSha,
      trigger: {
        type: "github_comment",
        repo: { id: repo.id, owner: repo.owner, name: repo.name },
        issue: { number: 71 },
        request: issueRequest,
      },
      gh: {
        owner: repo.owner,
        repo: repo.name,
        issueNumber: 71,
        progressComment: {
          id: 7101,
          command: "architect",
          issueTitle: "Preserve Architect publication marker",
          sender: "maintainer",
        },
      },
    });
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "assistant",
      data: { text: "1. Add the behavior.\n2. Prove it with the mirror test." },
    });
    const comments: string[] = [];
    let missingProgressUpdates = 0;
    const publicationFactory = async () =>
      ({
        rest: {
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ body }: { body: string }) => {
              comments.push(body);
              return { data: { id: 1 } };
            },
            updateComment: async () => {
              missingProgressUpdates += 1;
              throw Object.assign(new Error("progress comment deleted"), { status: 404 });
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      }) as never;
    await expect(
      finishRun(
        db,
        run,
        { status: "succeeded" },
        {
          config,
          githubClientFactory: publicationFactory,
          afterArchitectPlanOutboxWrite: () => {
            throw new Error("injected_outbox_commit_failure");
          },
        },
      ),
    ).rejects.toThrow("injected_outbox_commit_failure");
    expect(comments).toHaveLength(0);
    expect((await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0]?.status).toBe(
      "running",
    );
    expect(await db.select().from(proposals).where(eq(proposals.runId, run.id))).toHaveLength(0);

    const finished = await finishRun(
      db,
      run,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: publicationFactory,
      },
    );
    expect(finished.status).toBe("succeeded");
    expect(missingProgressUpdates).toBe(1);
    expect(comments).toHaveLength(1);
    expect(comments.at(-1)).toContain("Human Gate 1");
    expect(comments.at(-1)).toContain("Prove it with the mirror test");
    expect(comments.at(-1)).toContain("<!-- facility:architect-plan:");
    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, run.id));
    expect(proposal?.state).toBe("open");
    expect(proposal?.payload).toMatchObject({
      issueNumber: 71,
      repoId: repo.id,
      workspaceBaseSha,
      issueRevisionSha256: githubIssueRevisionSha256(issueRequest),
    });
  });

  it("keeps a sealed Architect success durable and retries transient plan publication", async () => {
    const repo = await insertRepoWithInstallation(`plan-retry-${Date.now()}`);
    const run = await insertRun({
      mode: "architect",
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 72 },
    });
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "assistant",
      data: { text: "Retry this plan publication without rewriting Architect success." },
    });

    const first = await finishRun(
      db,
      run,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: async () => {
          throw new Error("transient github outage");
        },
      },
    );
    expect(first.status).toBe("succeeded");
    const stored = (await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0];
    expect(stored).toMatchObject({ status: "succeeded", error: null });
    const planRows = await db.select().from(proposals).where(eq(proposals.runId, run.id));
    expect(planRows).toHaveLength(1);
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, planRows[0]?.id ?? ""),
            eq(proposalEvents.type, "published"),
          ),
        ),
    ).toHaveLength(0);
    const publicationError = (
      await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "artifact_error")))
    ).find((event) => (event.data as { kind?: unknown }).kind === "plan_publication_failed");
    expect(publicationError?.data).toMatchObject({ error: "transient github outage" });
    const publicationIssue = (
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, `plan_publication_failed:${run.id}`))
        .limit(1)
    )[0];
    expect(publicationIssue?.state).toBe("open");

    const comments: string[] = [];
    let retryFactoryCalls = 0;
    const retryFactory = async () => {
      retryFactoryCalls += 1;
      return {
        rest: {
          issues: {
            createComment: async ({ body }: { body: string }) => {
              comments.push(body);
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { data: { id: 72 } };
            },
            updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
              comments.push(body);
              return { data: { id: comment_id } };
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      } as never;
    };
    if (!stored) throw new Error("stored Architect run missing");
    await finishRun(
      db,
      stored,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: retryFactory,
      },
    );
    expect(comments).toHaveLength(0);
    expect(
      await reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: planRows[0]?.id, orgId },
        retryFactory,
      ),
    ).toEqual([]);
    expect(retryFactoryCalls).toBe(0);
    const retried = await Promise.all([
      reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: planRows[0]?.id, orgId },
        retryFactory,
        new Date(Date.now() + 2 * 60_000),
      ),
      reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: planRows[0]?.id, orgId },
        retryFactory,
        new Date(Date.now() + 2 * 60_000),
      ),
    ]);
    expect(retried.flat()).toEqual([
      { proposalId: planRows[0]?.id, status: "published" },
      { proposalId: planRows[0]?.id, status: "published" },
    ]);
    expect(comments).toHaveLength(1);
    expect(retryFactoryCalls).toBe(1);
    expect(await db.select().from(proposals).where(eq(proposals.runId, run.id))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, planRows[0]?.id ?? ""),
            eq(proposalEvents.type, "published"),
          ),
        ),
    ).toHaveLength(1);
    const resolvedPublicationIssue = (
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.id, publicationIssue?.id ?? ""))
        .limit(1)
    )[0];
    expect(resolvedPublicationIssue?.state).toBe("resolved");
    await db
      .update(proposals)
      .set({ state: "rejected", updatedAt: new Date() })
      .where(eq(proposals.id, planRows[0]?.id ?? ""));
    expect(
      await reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: planRows[0]?.id, orgId },
        retryFactory,
      ),
    ).toEqual([{ proposalId: planRows[0]?.id, status: "closed" }]);
    expect(comments).toHaveLength(2);
    expect(comments.at(-1)).not.toContain("Approve this plan");
    expect(retryFactoryCalls).toBe(2);
  });

  it("recovers an ambiguous post-comment failure by stable marker without duplicating GitHub", async () => {
    const repo = await insertRepoWithInstallation(`plan-ambiguous-${Date.now()}`);
    const run = await insertRun({
      mode: "architect",
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 73 },
    });
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "assistant",
      data: { text: "Publish this plan exactly once across an ambiguous GitHub response." },
    });
    const remoteComments: Array<{
      id: number;
      body: string;
      created_at: string;
      html_url: string;
      user: { login: string; type: string };
    }> = [];
    let creates = 0;
    let updates = 0;
    await finishRun(
      db,
      run,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: async () =>
          ({
            rest: {
              issues: {
                listComments: async () => ({ data: [] }),
                createComment: async ({ body }: { body: string }) => {
                  creates += 1;
                  remoteComments.push({
                    id: 7301,
                    body,
                    created_at: new Date().toISOString(),
                    html_url: "https://github.test/comments/7301",
                    user: { login: "facility[bot]", type: "Bot" },
                  });
                  throw new Error("connection closed after GitHub accepted the comment");
                },
              },
              repos: {},
              pulls: {},
              git: {},
            },
          }) as never,
      },
    );
    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, run.id));
    expect(proposal).toBeDefined();
    expect(remoteComments).toHaveLength(1);
    expect(creates).toBe(1);
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, proposal?.id ?? ""),
            eq(proposalEvents.type, "published"),
          ),
        ),
    ).toHaveLength(0);
    await db
      .update(proposals)
      .set({ state: "rejected" })
      .where(eq(proposals.id, proposal?.id ?? ""));

    const recoveryFactory = async () =>
      ({
        rest: {
          issues: {
            listComments: async () => ({ data: remoteComments }),
            createComment: async () => {
              creates += 1;
              return { data: { id: 7302 } };
            },
            updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
              updates += 1;
              const comment = remoteComments.find((candidate) => candidate.id === comment_id);
              if (comment) comment.body = body;
              return { data: { id: comment_id, html_url: comment?.html_url } };
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      }) as never;
    expect(
      await reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: proposal?.id, orgId: `${orgId}-other` },
        recoveryFactory,
        new Date(Date.now() + 2 * 60_000),
      ),
    ).toEqual([]);
    expect(
      await reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: proposal?.id, orgId },
        recoveryFactory,
        new Date(Date.now() + 2 * 60_000),
      ),
    ).toEqual([{ proposalId: proposal?.id, status: "closed" }]);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect(remoteComments).toHaveLength(1);
    expect(remoteComments[0]?.body).toContain(`facility:architect-plan:${run.id}:${proposal?.id}`);
    expect(remoteComments[0]?.body).toContain("Human Gate 1:** no longer open (`rejected`)");
    expect(remoteComments[0]?.body).not.toContain("Approve this plan");
    expect(await db.select().from(proposals).where(eq(proposals.runId, run.id))).toHaveLength(1);
    const published = (
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, proposal?.id ?? ""),
            eq(proposalEvents.type, "published"),
          ),
        )
        .limit(1)
    )[0];
    expect(published?.data).toMatchObject({
      publicationKey: `architect-plan:${run.id}:${proposal?.id}`,
      commentId: 7301,
      commentUrl: "https://github.test/comments/7301",
    });
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, proposal?.id ?? ""),
            eq(proposalEvents.type, "publication_closed"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("reconciler closes a published Gate 1 comment once the proposal is no longer open", async () => {
    const repo = await insertRepoWithInstallation(`plan-lifecycle-${Date.now()}`);
    const run = await insertRun({
      mode: "architect",
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 75 },
    });
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "assistant",
      data: { text: "Close the visible approval CTA after this proposal is rejected." },
    });
    const remoteComments: Array<{
      id: number;
      body: string;
      created_at: string;
      html_url: string;
      user: { login: string; type: string };
    }> = [];
    let updates = 0;
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationId ?? ""))
        .limit(1)
    )[0];
    if (!installation) throw new Error("lifecycle installation missing");
    const factory = async (installationId: number) => {
      if (installation.installationId !== installationId) {
        throw new Error("unrelated publication candidate");
      }
      return {
        rest: {
          issues: {
            listComments: async () => ({ data: remoteComments }),
            createComment: async ({ body }: { body: string }) => {
              remoteComments.push({
                id: 7501,
                body,
                created_at: new Date().toISOString(),
                html_url: "https://github.test/comments/7501",
                user: { login: "facility[bot]", type: "Bot" },
              });
              return { data: { id: 7501, html_url: "https://github.test/comments/7501" } };
            },
            updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
              updates += 1;
              const comment = remoteComments.find((candidate) => candidate.id === comment_id);
              if (comment) comment.body = body;
              return { data: { id: comment_id, html_url: comment?.html_url } };
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      } as never;
    };
    await finishRun(db, run, { status: "succeeded" }, { config, githubClientFactory: factory });
    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, run.id));
    if (!proposal) throw new Error("lifecycle proposal missing");
    expect(remoteComments[0]?.body).toContain("Approve this plan");
    await db
      .update(proposals)
      .set({ state: "rejected", updatedAt: new Date() })
      .where(eq(proposals.id, proposal.id));

    const target = { proposalId: proposal.id, orgId };
    const first = await reconcileArchitectPlanPublications(db, config, target, factory);
    expect(first).toContainEqual({ proposalId: proposal.id, status: "closed" });
    expect(updates).toBe(1);
    expect(remoteComments[0]?.body).toContain("Human Gate 1:** no longer open (`rejected`)");
    expect(remoteComments[0]?.body).not.toContain("Approve this plan");
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.proposalId, proposal.id),
            eq(proposalEvents.type, "publication_closed"),
          ),
        ),
    ).toHaveLength(1);

    const second = await reconcileArchitectPlanPublications(db, config, target, factory);
    expect(second).toEqual([{ proposalId: proposal.id, status: "closed" }]);
    expect(updates).toBe(1);
  });

  it("closes legacy publications when their tracked GitHub comment is deleted or unavailable", async () => {
    const createLegacyPublication = async (issueNumber: number, progressCommentId?: number) => {
      const repo = await insertRepoWithInstallation(`plan-legacy-${issueNumber}-${Date.now()}`);
      const run = await insertRun({
        mode: "architect",
        status: "running",
        gh: {
          owner: repo.owner,
          repo: repo.name,
          issueNumber,
          ...(progressCommentId
            ? {
                progressComment: {
                  id: progressCommentId,
                  command: "architect",
                  issueTitle: "Legacy Architect publication",
                  sender: "maintainer",
                },
              }
            : {}),
        },
      });
      await db.insert(runEvents).values({
        orgId,
        runId: run.id,
        seq: 1,
        type: "assistant",
        data: { text: "A legacy plan publication without durable comment metadata." },
      });
      await finishRun(
        db,
        run,
        { status: "succeeded" },
        {
          config,
          githubClientFactory: async () =>
            ({
              rest: {
                issues: {
                  listComments: async () => ({ data: [] }),
                  createComment: async () => ({ data: { id: issueNumber * 100 } }),
                  updateComment: async ({ comment_id }: { comment_id: number }) => ({
                    data: { id: comment_id },
                  }),
                },
                repos: {},
                pulls: {},
                git: {},
              },
            }) as never,
        },
      );
      const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, run.id));
      if (!proposal) throw new Error("legacy proposal fixture missing");
      await db
        .update(proposalEvents)
        .set({ data: { source: "architect_run", issue: issueNumber } })
        .where(
          and(eq(proposalEvents.proposalId, proposal.id), eq(proposalEvents.type, "published")),
        );
      await db
        .update(proposals)
        .set({ state: "rejected", updatedAt: new Date() })
        .where(eq(proposals.id, proposal.id));
      return proposal;
    };

    const deleted = await createLegacyPublication(76, 7601);
    const untracked = await createLegacyPublication(77);
    let updates = 0;
    let creates = 0;
    const recoveryFactory = async () =>
      ({
        rest: {
          issues: {
            listComments: async () => ({ data: [] }),
            updateComment: async () => {
              updates += 1;
              throw Object.assign(new Error("comment deleted"), { status: 404 });
            },
            createComment: async () => {
              creates += 1;
              return { data: { id: 9999 } };
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      }) as never;

    await expect(
      reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: deleted.id, orgId },
        recoveryFactory,
      ),
    ).resolves.toEqual([{ proposalId: deleted.id, status: "closed" }]);
    await expect(
      reconcileArchitectPlanPublications(
        db,
        config,
        { proposalId: untracked.id, orgId },
        recoveryFactory,
      ),
    ).resolves.toEqual([{ proposalId: untracked.id, status: "closed" }]);
    expect({ updates, creates }).toEqual({ updates: 1, creates: 0 });
    const closures = await db
      .select({ proposalId: proposalEvents.proposalId, data: proposalEvents.data })
      .from(proposalEvents)
      .where(
        and(
          inArray(proposalEvents.proposalId, [deleted.id, untracked.id]),
          eq(proposalEvents.type, "publication_closed"),
        ),
      );
    expect(closures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalId: deleted.id,
          data: expect.objectContaining({ reason: "deleted_comment", commentId: null }),
        }),
        expect.objectContaining({
          proposalId: untracked.id,
          data: expect.objectContaining({ reason: "legacy_comment_untracked", commentId: null }),
        }),
      ]),
    );
  });

  it("suppresses an expired unpublished Architect proposal without creating a stale CTA", async () => {
    const repo = await insertRepoWithInstallation(`plan-closed-${Date.now()}`);
    const run = await insertRun({
      mode: "architect",
      status: "running",
      gh: { owner: repo.owner, repo: repo.name, issueNumber: 74 },
    });
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "assistant",
      data: { text: "Do not publish a Gate 1 CTA after this proposal closes." },
    });
    await finishRun(
      db,
      run,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: async () => {
          throw new Error("github unavailable before comment");
        },
      },
    );
    const [proposal] = await db.select().from(proposals).where(eq(proposals.runId, run.id));
    if (!proposal) throw new Error("closed proposal fixture missing");
    await db
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(proposals.id, proposal.id));
    let creates = 0;
    let updates = 0;
    const result = await reconcileArchitectPlanPublications(
      db,
      config,
      { proposalId: proposal.id, orgId },
      async () =>
        ({
          rest: {
            issues: {
              listComments: async () => ({ data: [] }),
              createComment: async () => {
                creates += 1;
                return { data: { id: 7401 } };
              },
              updateComment: async () => {
                updates += 1;
                return { data: { id: 7401 } };
              },
            },
            repos: {},
            pulls: {},
            git: {},
          },
        }) as never,
      new Date(Date.now() + 2 * 60_000),
    );
    expect(result).toEqual([{ proposalId: proposal.id, status: "suppressed" }]);
    expect({ creates, updates }).toEqual({ creates: 0, updates: 0 });
    const suppressed = await db
      .select()
      .from(proposalEvents)
      .where(
        and(
          eq(proposalEvents.proposalId, proposal.id),
          eq(proposalEvents.type, "publication_suppressed"),
        ),
      );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.data).toMatchObject({ proposalState: "expired" });
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(eq(proposalEvents.proposalId, proposal.id), eq(proposalEvents.type, "published")),
        ),
    ).toHaveLength(0);
    const expirationClaims = await Promise.all([expireHitlProposals(db), expireHitlProposals(db)]);
    expect(expirationClaims.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(and(eq(proposalEvents.proposalId, proposal.id), eq(proposalEvents.type, "expired"))),
    ).toHaveLength(1);
  });

  it("cron publication gives a never-attempted tenant progress past more than one page of poison", async () => {
    const actionType = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "plan_acceptance")))
        .limit(1)
    )[0];
    if (!actionType) throw new Error("plan acceptance action fixture missing");
    const fairnessNow = new Date();
    const poisonProposalIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const poisonRunId = newId("run");
      const poisonProposalId = newId("prop");
      poisonProposalIds.push(poisonProposalId);
      await db.insert(runs).values({
        id: poisonRunId,
        orgId,
        projectId,
        mode: "architect",
        engine: "codex",
        status: "succeeded",
        receipt: {},
        gh: { issueNumber: 8_000 + index },
        trigger: {},
        createdBy: { type: "system", id: "fairness-poison" },
      });
      await db.insert(proposals).values({
        id: poisonProposalId,
        orgId,
        projectId,
        runId: poisonRunId,
        actionTypeId: actionType.id,
        payload: {},
        contextMd: "permanently invalid poison",
        expiresAt: new Date(fairnessNow.getTime() + 60 * 60_000),
      });
      await db.insert(proposalEvents).values({
        orgId,
        proposalId: poisonProposalId,
        seq: 1,
        type: "open",
        actor: { type: "agent", id: poisonRunId },
        data: { source: "architect_run" },
      });
    }

    const otherOrgId = newId("org");
    const otherProjectId = newId("proj");
    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Publication Fairness Tenant",
      slug: `publication-fairness-${Date.now()}`,
    });
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: otherOrgId,
      name: "Publication Fairness Project",
      slug: `publication-fairness-project-${Date.now()}`,
      settings: {},
    });
    const otherActionType = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId: otherOrgId,
          name: "plan_acceptance",
          payloadSchema: actionType.payloadSchema,
          resolver: actionType.resolver,
          executor: actionType.executor,
          defaultTtlHours: actionType.defaultTtlHours,
        })
        .returning()
    )[0];
    const otherInstallation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId: otherOrgId,
          installationId: nextInstallationId(),
          accountLogin: "fairness-owner",
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!otherActionType || !otherInstallation) throw new Error("fairness tenant fixtures missing");
    const otherRepo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId: otherOrgId,
          projectId: otherProjectId,
          installationId: otherInstallation.id,
          owner: "fairness-owner",
          name: "repo",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    const targetRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId: otherOrgId,
          projectId: otherProjectId,
          mode: "architect",
          engine: "codex",
          status: "running",
          trigger: {},
          gh: { owner: "fairness-owner", repo: "repo", issueNumber: 99 },
          createdBy: { type: "user", id: "fairness-human" },
        })
        .returning()
    )[0];
    if (!otherRepo || !targetRun) throw new Error("fairness run fixtures missing");
    await db.insert(runEvents).values({
      orgId: otherOrgId,
      runId: targetRun.id,
      seq: 1,
      type: "assistant",
      data: { text: "This never-attempted tenant must not starve behind poison rows." },
    });
    await finishRun(
      db,
      targetRun,
      { status: "succeeded" },
      {
        config,
        githubClientFactory: async () => {
          throw new Error("first fairness publication attempt fails");
        },
      },
    );
    const [targetProposal] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.orgId, otherOrgId), eq(proposals.runId, targetRun.id)));
    if (!targetProposal) throw new Error("fairness proposal missing");
    await db
      .delete(platformIssues)
      .where(
        and(
          eq(platformIssues.orgId, otherOrgId),
          eq(platformIssues.fingerprint, `plan_publication_failed:${targetRun.id}`),
        ),
      );
    let creates = 0;
    const publicationFactory = async (installationId: number) => {
      if (installationId !== otherInstallation.installationId) {
        throw new Error("unrelated publication candidate");
      }
      return {
        rest: {
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async ({ issue_number }: { issue_number: number }) => {
              if (issue_number === 99) creates += 1;
              return { data: { id: 9901 } };
            },
          },
          repos: {},
          pulls: {},
          git: {},
        },
      } as never;
    };
    const publicationOrgCount = (
      await db.selectDistinct({ orgId: proposals.orgId }).from(proposals)
    ).length;
    const maxSweeps = Math.max(1, Math.ceil(publicationOrgCount / 25));
    const sweepEpoch = Math.floor(fairnessNow.getTime() / 60_000) * 60_000;
    const results = [];
    for (let index = 0; index < maxSweeps; index += 1) {
      const sweep = await reconcileArchitectPlanPublications(
        db,
        config,
        {},
        publicationFactory,
        new Date(sweepEpoch + index * 60_000),
      );
      results.push(...sweep);
      if (sweep.some((entry) => entry.proposalId === targetProposal.id)) break;
    }
    expect(results).toContainEqual({ proposalId: targetProposal.id, status: "published" });
    expect(creates).toBe(1);
    expect(
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(
            inArray(proposalEvents.proposalId, poisonProposalIds),
            eq(proposalEvents.type, "published"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("keeps a successful run durable while transient PR delivery retries", async () => {
    const repo = await insertRepoWithInstallation(`finish-fail-${Date.now()}`);
    const run = await insertRun({ status: "running", gh: { owner: repo.owner, repo: repo.name } });
    await finishAndDeliver(
      run,
      {
        status: "succeeded",
        git: {
          changed: true,
          branch: "fix/github-delivery",
          headSha: "deadbeef",
          pullRequestTitle: "fix: deliver pull request",
          pullRequestBody: "## Summary\n\n- Exercise PR delivery failure handling.",
        },
      },
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
    expect(stored?.error).toBeNull();
    const [delivery] = await db.select().from(runDeliveries).where(eq(runDeliveries.runId, run.id));
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "github down",
      expectedHeadSha: "deadbeef",
    });
    const [artifact] = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "artifact_error")));
    expect(artifact?.data).toMatchObject({ kind: "pr_delivery_pending", attempt: 1 });
    const [issue] = await db
      .select()
      .from(platformIssues)
      .where(eq(platformIssues.fingerprint, `pr_delivery_pending:${run.id}`));
    expect(issue?.state).toBe("open");
  });

  it("dispatches address-review only for trusted reviews of Facility-delivered bot PRs", async () => {
    const agent = await insertAgent("address-review", [
      { type: "github", event: "pull_request_review", action: "submitted" },
    ]);
    const scenarios: Array<{
      name: string;
      admitted: boolean;
      reason?: string;
    }> = [
      { name: "admitted", admitted: true },
      { name: "human-authored", admitted: false, reason: "human_authored_pull_request" },
      { name: "fork", admitted: false, reason: "cross_repository_pull_request" },
      { name: "draft", admitted: false, reason: "draft_pull_request" },
      { name: "untrusted-reviewer", admitted: false, reason: "untrusted_reviewer" },
      { name: "self-review", admitted: false, reason: "self_review" },
      { name: "stale-head", admitted: false, reason: "stale_pull_request_event" },
      { name: "stale-review", admitted: false, reason: "stale_review" },
      { name: "wrong-installation", admitted: false, reason: "installation_mismatch" },
      { name: "wrong-base", admitted: false, reason: "delivery_base_mismatch" },
      { name: "missing-delivery", admitted: false, reason: "not_facility_delivered" },
      { name: "cross-tenant-delivery", admitted: false, reason: "not_facility_delivered" },
      { name: "repair-lineage", admitted: true },
      { name: "unauthorized-head", admitted: false, reason: "unauthorized_head" },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const suffix = `${scenario.name}-${Date.now()}-${index}`;
      const owner = `review-owner-${suffix}`;
      const repoName = `review-repo-${suffix}`;
      const branch = `facility/issue-${index + 1}`;
      const headSha = `live-head-${index + 1}`;
      const pullNumber = 500 + index;
      const installation = await insertInstallation(owner);
      const repo = await insertRepo({
        owner,
        name: repoName,
        installationId: installation.id,
      });
      await db
        .update(repos)
        .set({ renderAnswers: { execution_lane: { "address-review": "platform" } } })
        .where(eq(repos.id, repo.id));
      const producingRun = await insertRun({
        mode: "builder",
        status: "succeeded",
        trigger: { source: "plan_acceptance", approvedPlan: "Implement the reviewed change." },
        gh: { owner, repo: repoName, branch },
      });
      if (!new Set(["missing-delivery", "cross-tenant-delivery"]).has(scenario.name)) {
        await db.insert(runDeliveries).values({
          runId: producingRun.id,
          orgId,
          projectId,
          repoId: repo.id,
          owner,
          repoName,
          headBranch: branch,
          expectedHeadSha: new Set(["repair-lineage", "unauthorized-head"]).has(scenario.name)
            ? "builder-head"
            : headSha,
          baseBranch: "main",
          title: "Facility delivery",
          body: "Delivery body",
          status: "delivered",
          prNumber: pullNumber,
          prUrl: `https://github.test/${owner}/${repoName}/pull/${pullNumber}`,
          deliveredAt: new Date(),
        });
      }
      if (scenario.name === "repair-lineage") {
        await insertRun({
          mode: "address_review",
          status: "succeeded",
          trigger: { deliveryContext: { producingRunId: producingRun.id } },
          gh: { owner, repo: repoName, branch, headSha },
        });
      }
      if (scenario.name === "cross-tenant-delivery") {
        const otherOrgId = newId("org");
        const otherProjectId = newId("proj");
        const otherRepoId = newId("repo");
        const otherRunId = newId("run");
        await db.insert(orgs).values({
          id: otherOrgId,
          name: `Other ${suffix}`,
          slug: `other-${suffix}`,
        });
        await db.insert(projects).values({
          id: otherProjectId,
          orgId: otherOrgId,
          name: `Other ${suffix}`,
          slug: `other-${suffix}`,
        });
        await db.insert(repos).values({
          id: otherRepoId,
          orgId: otherOrgId,
          projectId: otherProjectId,
          owner,
          name: repoName,
          defaultBranch: "main",
        });
        await db.insert(runs).values({
          id: otherRunId,
          orgId: otherOrgId,
          projectId: otherProjectId,
          mode: "builder",
          engine: "codex",
          status: "succeeded",
          gh: { owner, repo: repoName, branch },
          createdBy: { type: "system", id: "test" },
        });
        await db.insert(runDeliveries).values({
          runId: otherRunId,
          orgId: otherOrgId,
          projectId: otherProjectId,
          repoId: otherRepoId,
          owner,
          repoName,
          headBranch: branch,
          expectedHeadSha: headSha,
          baseBranch: "main",
          title: "Foreign delivery",
          body: "Must not authorize the managed tenant",
          status: "delivered",
          prNumber: pullNumber,
          deliveredAt: new Date(),
        });
      }

      const integration = (
        await db
          .insert(integrations)
          .values({ id: newId("int"), orgId, kind: "github", name: suffix })
          .returning()
      )[0];
      if (!integration) throw new Error("integration insert failed");
      const reviewer =
        scenario.name === "self-review"
          ? "facility-test[bot]"
          : scenario.name === "untrusted-reviewer"
            ? "outsider"
            : "maintainer";
      const eventId = newId("evt");
      await db.insert(inboundEvents).values({
        id: eventId,
        orgId,
        integrationId: integration.id,
        verified: true,
        eventType: "pull_request_review",
        payload: {
          action: "submitted",
          installation: {
            id:
              scenario.name === "wrong-installation"
                ? installation.installationId + 10_000
                : installation.installationId,
          },
          sender: { login: reviewer, type: reviewer.endsWith("[bot]") ? "Bot" : "User" },
          repository: {
            owner: { login: owner },
            name: repoName,
            full_name: `${owner}/${repoName}`,
          },
          review: {
            id: 900 + index,
            state: "changes_requested",
            commit_id: scenario.name === "stale-review" ? "reviewed-old-head" : headSha,
            user: { login: reviewer },
          },
          pull_request: {
            number: pullNumber,
            title: "Facility PR",
            body: "Body",
            state: "open",
            draft: scenario.name === "draft",
            user: {
              login: "facility-builder[bot]",
              type: scenario.name === "human-authored" ? "User" : "Bot",
            },
            html_url: `https://github.test/${owner}/${repoName}/pull/${pullNumber}`,
            head: {
              ref: branch,
              sha: scenario.name === "stale-head" ? "stale-head" : headSha,
              repo: { full_name: `${owner}/${repoName}` },
            },
            base: {
              ref: scenario.name === "wrong-base" ? "release" : "main",
              repo: { full_name: `${owner}/${repoName}` },
            },
          },
        },
      });

      const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
      let liveReadCount = 0;
      let releaseLiveReads: () => void = () => undefined;
      const liveReadsReady = new Promise<void>((resolve) => {
        releaseLiveReads = resolve;
      });
      const factory: GithubClientFactory = async () =>
        ({
          rest: {
            pulls: {
              get: async () => {
                if (scenario.name === "admitted") {
                  liveReadCount += 1;
                  if (liveReadCount === 2) releaseLiveReads();
                  await liveReadsReady;
                }
                return {
                  data: {
                    number: pullNumber,
                    title: "Facility PR",
                    body: "Body",
                    state: "open",
                    draft: scenario.name === "draft",
                    user: {
                      login: "facility-builder[bot]",
                      type: scenario.name === "human-authored" ? "User" : "Bot",
                    },
                    html_url: `https://github.test/${owner}/${repoName}/pull/${pullNumber}`,
                    head: {
                      ref: branch,
                      sha: headSha,
                      repo: {
                        full_name:
                          scenario.name === "fork" ? `fork/${repoName}` : `${owner}/${repoName}`,
                      },
                    },
                    base: {
                      ref: scenario.name === "wrong-base" ? "release" : "main",
                      repo: { full_name: `${owner}/${repoName}` },
                    },
                  },
                };
              },
              getReview: async () => ({
                data: {
                  id: 900 + index,
                  state: "CHANGES_REQUESTED",
                  commit_id: scenario.name === "stale-review" ? "reviewed-old-head" : headSha,
                  user: { login: reviewer },
                  body: "Address the submitted findings.",
                  submitted_at: "2026-08-07T00:00:00Z",
                },
              }),
              listCommentsForReview: async () => ({
                data: [
                  {
                    id: 2_000 + index,
                    path: "src/example.ts",
                    line: 17,
                    body: "Handle the boundary case.",
                    diff_hunk: "@@ -16,1 +16,2 @@",
                    html_url: `https://github.test/${owner}/${repoName}/pull/${pullNumber}#review`,
                  },
                ],
              }),
            },
            repos: {
              getCollaboratorPermissionLevel: async () => ({
                data: { permission: scenario.name === "untrusted-reviewer" ? "read" : "write" },
              }),
            },
            issues: {
              createComment: async () => ({
                data: {
                  id: 1_000 + index,
                  html_url: `https://github.test/${owner}/${repoName}/pull/${pullNumber}#comment`,
                },
              }),
            },
          },
        }) as never;
      const process = () =>
        processGithubWebhook(
          db,
          { ...config, githubAppSlug: "facility-test" },
          { inboundEventId: eventId },
          factory,
          async (queue, data) => {
            jobs.push({ queue, data });
            return null;
          },
        );
      if (scenario.name === "admitted") await Promise.all([process(), process()]);
      else await process();

      const dispatched = await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.agentDefId, agent.id),
            sql`${runs.gh}->>'owner' = ${owner}`,
            sql`${runs.gh}->>'repo' = ${repoName}`,
          ),
        );
      if (scenario.admitted) {
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]?.trigger).toMatchObject({
          pullRequest: { number: pullNumber, head: branch, headSha },
          review: {
            id: 900 + index,
            author: reviewer,
            comments: [{ path: "src/example.ts", line: 17, body: "Handle the boundary case." }],
          },
          deliveryContext: { producingRunId: producingRun.id },
        });
        expect(dispatched[0]?.githubDeliveryId).toBe(eventId);
        expect(jobs).toEqual([
          { queue: "runs.dispatch", data: { runId: dispatched[0]?.id, orgId } },
        ]);
        await processGithubWebhook(
          db,
          { ...config, githubAppSlug: "facility-test" },
          { inboundEventId: eventId },
          factory,
          async (queue, data) => {
            jobs.push({ queue, data });
            return null;
          },
        );
        expect(jobs).toHaveLength(1);
      } else {
        expect(dispatched).toHaveLength(0);
        expect(jobs).toHaveLength(0);
        const denial = (
          await db
            .select()
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.orgId, orgId),
                eq(auditEvents.action, "github.review_repair.denied"),
                sql`${auditEvents.target}->>'id' = ${repo.id}`,
              ),
            )
            .orderBy(sql`${auditEvents.seq} desc`)
            .limit(1)
        )[0];
        expect(denial?.payload).toMatchObject({ pullNumber, reason: scenario.reason });
      }
    }
  });

  function deliveryFactory(input: {
    branch: string;
    headSha: string;
    number: number;
  }): GithubClientFactory {
    return async () =>
      ({
        rest: {
          git: { getRef: async () => ({ data: { object: { sha: input.headSha } } }) },
          pulls: {
            list: async () => ({ data: [] }),
            create: async () => ({
              data: { number: input.number, html_url: `https://github.test/pr/${input.number}` },
            }),
            get: async () => ({
              data: {
                number: input.number,
                title: "Facility delivery",
                body: "",
                state: "open",
                html_url: `https://github.test/pr/${input.number}`,
                head: { ref: input.branch, sha: input.headSha },
                base: { ref: "main" },
              },
            }),
          },
          issues: { createComment: async () => ({ data: { id: 1 } }) },
          repos: {},
        },
      }) as never;
  }

  async function finishAndDeliver(
    run: Parameters<typeof finishRun>[1],
    input: Parameters<typeof finishRun>[2],
    deps: NonNullable<Parameters<typeof finishRun>[3]>,
  ) {
    const originalFactory = deps.githubClientFactory;
    const git = input.git;
    if (!originalFactory || !git?.branch || !git.headSha) {
      throw new Error("delivery test requires a GitHub factory and exact git ref");
    }
    const factory: GithubClientFactory = async (installationId) => {
      const octokit = await originalFactory(installationId);
      const originalCreate = octokit.rest.pulls.create.bind(octokit.rest.pulls);
      let created:
        | { number: number; html_url: string; title?: string; body?: string | null }
        | undefined;
      return {
        ...octokit,
        rest: {
          ...octokit.rest,
          git: {
            ...octokit.rest.git,
            getRef:
              octokit.rest.git.getRef ??
              (async () => ({ data: { object: { sha: git.headSha as string } } })),
          },
          pulls: {
            ...octokit.rest.pulls,
            create: async (args) => {
              const response = await originalCreate(args);
              created = response.data;
              return response;
            },
            list: octokit.rest.pulls.list ?? (async () => ({ data: [] })),
            get:
              octokit.rest.pulls.get ??
              (async ({ pull_number }) => {
                if (!created || created.number !== pull_number) {
                  throw new Error("delivery test PR was not created");
                }
                return {
                  data: {
                    number: created.number,
                    title: created.title ?? "Facility delivery",
                    body: created.body ?? "",
                    state: "open",
                    html_url: created.html_url,
                    head: { ref: git.branch as string, sha: git.headSha as string },
                    base: { ref: "main" },
                  },
                };
              }),
          },
        },
      } as Octokit;
    };
    const finished = await finishRun(db, run, input, { ...deps, githubClientFactory: factory });
    await deliverPendingRunDeliveries(db, config, {
      runId: run.id,
      githubClientFactory: factory,
      enqueue: deps.enqueue,
    });
    return finished;
  }

  async function insertInstallation(owner: string) {
    const row = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: nextInstallationId(),
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

  async function insertPullRequest(
    repoId: string,
    number: number,
    overrides: Partial<typeof ghPullRequests.$inferInsert> = {},
  ) {
    await db.insert(ghPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repoId,
      number,
      title: `PR ${number}`,
      state: "open",
      draft: false,
      headRef: `feature/${number}`,
      headSha: `head-${number}`,
      baseRef: "main",
      htmlUrl: `https://github.com/o/r/pull/${number}`,
      closingIssues: [],
      ghCreatedAt: new Date("2026-08-01T00:00:00Z"),
      ghUpdatedAt: new Date("2026-08-01T00:00:00Z"),
      ...overrides,
    });
  }

  async function insertAgent(name: string, triggers: unknown[] = [{ command: name }]) {
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
          triggers,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent insert failed");
    return agent;
  }

  async function insertRun(
    input: {
      mode?: string;
      status?: string;
      trigger?: Record<string, unknown>;
      gh?: Record<string, unknown>;
      sandbox?: Record<string, unknown>;
      workspaceBaseSha?: string;
    } = {},
  ) {
    const row = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: input.mode ?? "builder",
          engine: "codex",
          status: input.status ?? "queued",
          trigger: input.trigger ?? {},
          sandbox: input.sandbox ?? {},
          gh: input.gh ?? {},
          workspaceBaseSha: input.workspaceBaseSha,
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!row) throw new Error("run insert failed");
    return row;
  }
});

function pullRequestNode(
  repo: { owner: string; name: string; defaultBranch: string },
  number: number,
  body: string,
  closingIssues: number[],
) {
  return {
    number,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat" },
    headRefName: `feature/${number}`,
    headRefOid: `head-${number}`,
    baseRefName: repo.defaultBranch,
    url: `https://github.test/${repo.owner}/${repo.name}/pull/${number}`,
    body,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    closingIssuesReferences: {
      nodes: closingIssues.map((issueNumber) => ({
        number: issueNumber,
        repository: { nameWithOwner: `${repo.owner}/${repo.name}` },
      })),
      pageInfo: { endCursor: null, hasNextPage: false },
    },
    commits: {
      nodes: [{ commit: { oid: `head-${number}`, statusCheckRollup: null } }],
    },
  };
}
