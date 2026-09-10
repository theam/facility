import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  attentionItems,
  createDb,
  githubInstallations,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  migrate,
  orgMembers,
  orgs,
  projectRepositories,
  projects,
  roles,
  stories,
  storyAssignees,
  storyConversations,
  turns,
  userIdentities,
  users,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectBacklogService } from "../src/stories/backlog.js";

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

describe("unified project backlog", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; backlog tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const otherOrgId = newId("org");
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const repositoryId = newId("repo");
  const otherRepositoryId = newId("repo");
  const anaId = newId("user");
  const benId = newId("user");
  const roleId = newId("role");
  const service = new ProjectBacklogService(db);
  const at = (iso: string) => new Date(iso);
  const ids = {
    runningStory: newId("story"),
    queuedStory: newId("story"),
    attentionStory: newId("story"),
    dismissedStory: newId("story"),
    reviewStory: newId("story"),
    draftStory: newId("story"),
    changesStory: newId("story"),
    closedPullStory: newId("story"),
    mergedStory: newId("story"),
    manualStory: newId("story"),
    archivedStory: newId("story"),
    readyStory: newId("story"),
  };

  async function story(input: {
    id: string;
    externalId: string;
    title: string;
    status?: string;
    branch?: string | null;
    pullRequestNumber?: number | null;
    provider?: "github" | "manual";
    repository?: string | null;
    titleSource?: string;
    updatedAt?: Date;
    turn?: "queued" | "running" | "succeeded";
    workspace?: "running" | "sleeping";
    attention?: "open" | "resolved";
  }) {
    await db.insert(stories).values({
      id: input.id,
      orgId,
      projectId,
      repositoryId: input.repository === undefined ? repositoryId : input.repository,
      provider: input.provider ?? "github",
      externalId: input.externalId,
      title: input.title,
      titleSource: input.titleSource ?? (input.provider === "manual" ? "user" : "github"),
      status: input.status ?? "working",
      branch: input.branch ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      createdBy: { type: "user", id: anaId },
      updatedAt: input.updatedAt ?? at("2026-09-05T00:00:00Z"),
    });
    const conversationId = newId("sess");
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId, projectId, storyId: input.id });
    if (input.turn) {
      const turnId = newId("turn");
      await db.insert(turns).values({
        id: turnId,
        orgId,
        projectId,
        storyId: input.id,
        conversationId,
        agentName: "builder",
        manifestHash: "hash",
        manifest: {},
        engine: "codex",
        model: "gpt-5.5",
        state: input.turn,
        triggerType: "ui",
        createdBy: { type: "user", id: anaId },
      });
      if (input.attention) {
        await db.insert(attentionItems).values({
          id: newId("attn"),
          orgId,
          projectId,
          storyId: input.id,
          turnId,
          kind: "turn_error",
          title: "builder failed",
          status: input.attention,
          resolution: input.attention === "resolved" ? "dismissed" : null,
        });
      }
    }
    if (input.workspace) {
      await db.insert(workspaces).values({
        id: newId("ws"),
        orgId,
        projectId,
        storyId: input.id,
        provider: "fake",
        volumeRef: `vol-${input.id}`,
        state: input.workspace,
        environment: {},
      });
    }
  }

  async function issue(input: {
    number: number;
    title: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
    repository?: string;
    updatedAt?: Date;
    syncedAt?: Date;
  }) {
    await db.insert(githubIssues).values({
      id: newId("iss"),
      orgId,
      projectId,
      repositoryId: input.repository ?? repositoryId,
      number: input.number,
      title: input.title,
      state: input.state ?? "open",
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      htmlUrl: `https://github.com/acme/app/issues/${input.number}`,
      githubCreatedAt: at("2026-09-01T00:00:00Z"),
      githubUpdatedAt: input.updatedAt ?? at("2026-09-04T00:00:00Z"),
      closedAt: input.state === "closed" ? at("2026-09-06T00:00:00Z") : null,
      syncedAt: input.syncedAt ?? new Date(),
    });
  }

  async function pull(input: {
    number: number;
    state: "open" | "closed" | "merged";
    headRef: string;
    draft?: boolean;
    ciState?: "pending" | "success" | "failure" | null;
    closingIssues?: number[];
    author?: string;
    reviews?: Array<{ author: string; state: string }>;
  }) {
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repositoryId,
      number: input.number,
      title: `PR ${input.number}`,
      state: input.state,
      draft: input.draft ?? false,
      author: input.author ?? "ana",
      headRef: input.headRef,
      headSha: "a".repeat(40),
      baseRef: "main",
      htmlUrl: `https://github.com/acme/app/pull/${input.number}`,
      closingIssues: input.closingIssues ?? [],
      ciState: input.ciState ?? null,
      ciFailureNames: input.ciState === "failure" ? ["test"] : [],
      githubUpdatedAt: at("2026-09-07T00:00:00Z"),
      mergedAt: input.state === "merged" ? at("2026-09-07T00:00:00Z") : null,
    });
    for (const [index, review] of (input.reviews ?? []).entries()) {
      await db.insert(githubPullRequestReviews).values({
        id: newId("ghr"),
        orgId,
        projectId,
        repositoryId,
        pullNumber: input.number,
        reviewId: `${input.number}-${index}`,
        state: review.state,
        author: review.author,
        submittedAt: at(`2026-09-07T0${index}:00:00Z`),
      });
    }
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Backlog", slug: `backlog-${suffix}`, settings: {} },
      { id: otherOrgId, name: "Other", slug: `backlog-other-${suffix}`, settings: {} },
    ]);
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Backlog", slug: `backlog-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other",
        slug: `other-${suffix}`,
        settings: {},
      },
    ]);
    const installationId = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 700_000,
      accountId: 1,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values([
      {
        id: repositoryId,
        orgId,
        projectId,
        installationId,
        owner: "acme",
        name: `app-${suffix}`,
        defaultBranch: "main",
        role: "primary",
      },
      {
        id: otherRepositoryId,
        orgId,
        projectId,
        installationId,
        owner: "acme",
        name: `docs-${suffix}`,
        defaultBranch: "main",
        role: "related",
      },
    ]);
    await db.insert(users).values([
      { id: anaId, email: `ana-${suffix}@example.com`, name: "Ana Example" },
      { id: benId, email: `ben-${suffix}@example.com`, name: "Ben Example" },
    ]);
    await db.insert(userIdentities).values({
      id: newId("user"),
      userId: anaId,
      provider: "github",
      providerSubject: `gh-${suffix}`,
      login: "ana",
    });
    await db.insert(roles).values({ id: roleId, orgId, name: `member-${suffix}`, permissions: [] });
    await db.insert(orgMembers).values([
      { id: newId("member"), orgId, userId: anaId, roleId },
      { id: newId("member"), orgId, userId: benId, roleId },
    ]);

    // GitHub issues that nobody started, one in a related repository, one closed.
    for (let number = 100; number < 160; number += 1) {
      await issue({
        number,
        title: `Backlog item ${number}`,
        labels: number % 2 === 0 ? ["bug"] : ["enhancement"],
        assignees: number % 3 === 0 ? ["ana"] : [],
        updatedAt: at(`2026-08-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`),
      });
    }
    await issue({
      number: 1,
      title: "Unassigned new idea",
      labels: ["idea"],
      updatedAt: at("2026-09-09T00:00:00Z"),
    });
    await issue({ number: 2, title: "Docs typo", repository: otherRepositoryId, labels: ["docs"] });
    await issue({ number: 3, title: "Closed without a story", state: "closed" });
    await issue({ number: 4, title: "Stale mirror", syncedAt: at("2026-09-01T00:00:00Z") });
    await issue({ number: 5, title: "Shared work", assignees: ["ana", "carol"] });

    // Issues with stories in every phase.
    await issue({ number: 10, title: "Running work", labels: ["bug"], assignees: ["ben"] });
    await story({
      id: ids.runningStory,
      externalId: "issue:10",
      title: "Running work",
      turn: "running",
      workspace: "running",
    });
    await issue({ number: 11, title: "Queued work" });
    await story({
      id: ids.queuedStory,
      externalId: "issue:11",
      title: "Queued work",
      turn: "queued",
    });
    await issue({ number: 12, title: "Failed work", assignees: ["ana"] });
    await story({
      id: ids.attentionStory,
      externalId: "issue:12",
      title: "Failed work",
      status: "attention",
      turn: "succeeded",
      attention: "open",
    });
    await issue({ number: 13, title: "Dismissed failure" });
    await story({
      id: ids.dismissedStory,
      externalId: "issue:13",
      title: "Dismissed failure",
      turn: "succeeded",
      attention: "resolved",
    });
    await issue({ number: 14, title: "Awaiting review" });
    await story({
      id: ids.reviewStory,
      externalId: "issue:14",
      title: "Awaiting review",
      branch: "feature/14",
      pullRequestNumber: 214,
      turn: "succeeded",
      workspace: "sleeping",
    });
    await pull({
      number: 214,
      state: "open",
      headRef: "feature/14",
      ciState: "success",
      reviews: [{ author: "ben", state: "APPROVED" }],
    });
    await issue({ number: 15, title: "Draft pull request" });
    await story({
      id: ids.draftStory,
      externalId: "issue:15",
      title: "Draft pull request",
      branch: "feature/15",
      pullRequestNumber: 215,
      turn: "succeeded",
    });
    await pull({ number: 215, state: "open", headRef: "feature/15", draft: true });
    await issue({ number: 16, title: "Changes requested" });
    await story({
      id: ids.changesStory,
      externalId: "issue:16",
      title: "Changes requested",
      branch: "feature/16",
      pullRequestNumber: 216,
      turn: "succeeded",
    });
    await pull({
      number: 216,
      state: "open",
      headRef: "feature/16",
      ciState: "success",
      reviews: [{ author: "ben", state: "CHANGES_REQUESTED" }],
    });
    await issue({ number: 17, title: "Closed pull request" });
    await story({
      id: ids.closedPullStory,
      externalId: "issue:17",
      title: "Closed pull request",
      branch: "feature/17",
      pullRequestNumber: 217,
      turn: "succeeded",
    });
    await pull({ number: 217, state: "closed", headRef: "feature/17" });
    await issue({ number: 18, title: "Merged work", state: "closed" });
    await story({
      id: ids.mergedStory,
      externalId: "issue:18",
      title: "Merged work",
      status: "done",
      branch: "feature/18",
      pullRequestNumber: 218,
      turn: "succeeded",
      workspace: "sleeping",
    });
    await pull({ number: 218, state: "merged", headRef: "feature/18", closingIssues: [18] });
    await story({
      id: ids.manualStory,
      externalId: "manual:key",
      title: "Spontaneous request",
      provider: "manual",
      repository: null,
      titleSource: "pending",
      turn: "succeeded",
    });
    await story({
      id: ids.archivedStory,
      externalId: "manual:old",
      title: "Archived request",
      provider: "manual",
      repository: null,
      status: "archived",
    });
    await story({
      id: ids.readyStory,
      externalId: "manual:ready",
      title: "Restored but idle",
      provider: "manual",
      repository: null,
      status: "ready",
    });
    await db.insert(storyAssignees).values([
      {
        id: newId("asg"),
        orgId,
        projectId,
        storyId: ids.runningStory,
        kind: "user",
        subject: anaId,
        addedBy: { type: "user", id: anaId },
      },
      {
        id: newId("asg"),
        orgId,
        projectId,
        storyId: ids.manualStory,
        kind: "user",
        subject: benId,
        addedBy: { type: "user", id: benId },
      },
    ]);
    // An open pull request with no issue and no story.
    await pull({ number: 300, state: "open", headRef: "chore/unlinked", ciState: "pending" });

    // Another tenant's data must never appear.
    await db.insert(githubInstallations).values({
      id: newId("ghi"),
      orgId: otherOrgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 800_000,
      accountId: 2,
      accountLogin: "other",
      targetType: "Organization",
    });
  });

  afterAll(async () => {
    await client.end();
  });

  function itemFor(result: Awaited<ReturnType<typeof service.list>>, key: string) {
    const item = result.items.find((entry) => entry.key === key);
    if (!item) throw new Error(`missing ${key}`);
    return item;
  }

  it("lists unstarted issues without creating a workspace or a turn", async () => {
    const before = {
      workspaces: (await db.select().from(workspaces).where(eq(workspaces.projectId, projectId)))
        .length,
      turns: (await db.select().from(turns).where(eq(turns.projectId, projectId))).length,
    };
    const result = await service.list(orgId, projectId, { phase: ["not_started"], limit: 100 });
    expect(result.total).toBe(60 + 4 + 1);
    const idea = itemFor(result, `issue:${repositoryId}:1`);
    expect(idea).toMatchObject({
      kind: "issue",
      phase: "not_started",
      reason: "issue_open",
      story: null,
      activity: { state: "idle" },
      assignees: [],
      labels: ["idea"],
    });
    expect(idea.issue?.url).toBe("https://github.com/acme/app/issues/1");
    expect(itemFor(result, `story:${ids.readyStory}`)).toMatchObject({ reason: "ready" });
    expect(itemFor(result, `issue:${repositoryId}:4`).issue?.stale).toBe(true);
    expect(idea.issue?.stale).toBe(false);
    expect(
      (await db.select().from(workspaces).where(eq(workspaces.projectId, projectId))).length,
    ).toBe(before.workspaces);
    expect((await db.select().from(turns).where(eq(turns.projectId, projectId))).length).toBe(
      before.turns,
    );
  });

  it("shows each unit of work once with its provenance, activity, and links", async () => {
    const result = await service.list(orgId, projectId, { phase: ["all"], limit: 100 });
    expect(result.items.filter((item) => item.issue?.number === 10)).toHaveLength(1);
    const running = itemFor(result, `story:${ids.runningStory}`);
    expect(running).toMatchObject({
      kind: "story",
      phase: "in_progress",
      reason: "running",
      activity: { state: "running", agentName: "builder", engine: "codex" },
      environment: { recordedState: "running" },
      issue: { number: 10, repository: `acme/app-${suffix}` },
    });
    expect(running.activity.turnId).toMatch(/^turn_/);
    expect(running.assignees).toEqual([
      expect.objectContaining({ key: "github:ben", login: "ben", sources: ["github"] }),
      expect.objectContaining({
        key: `user:${anaId}`,
        login: "ana",
        name: "Ana Example",
        sources: ["facility"],
      }),
    ]);
    expect(itemFor(result, `story:${ids.queuedStory}`)).toMatchObject({
      phase: "in_progress",
      reason: "queued",
      activity: { state: "queued" },
    });
    expect(itemFor(result, `story:${ids.manualStory}`)).toMatchObject({
      phase: "in_progress",
      reason: "started",
      titleSource: "pending",
      issue: null,
      story: { provider: "manual" },
    });
    expect(itemFor(result, `pull-request:${repositoryId}:300`)).toMatchObject({
      kind: "pull_request",
      phase: "review",
      pullRequest: { number: 300, ciState: "pending" },
    });
    expect(result.items.find((item) => item.key === `story:${ids.archivedStory}`)).toMatchObject({
      phase: "archived",
    });
  });

  it("separates attention, review, draft, closed and merged pull request states", async () => {
    const result = await service.list(orgId, projectId, { phase: ["all"], limit: 100 });
    expect(itemFor(result, `story:${ids.attentionStory}`)).toMatchObject({
      phase: "attention",
      reason: "attention",
      attention: [{ source: "facility", kind: "turn_error", title: "builder failed" }],
    });
    expect(itemFor(result, `story:${ids.dismissedStory}`)).toMatchObject({
      phase: "in_progress",
      attention: [],
    });
    expect(itemFor(result, `story:${ids.reviewStory}`)).toMatchObject({
      phase: "review",
      reason: "approved",
      environment: { recordedState: "sleeping" },
      pullRequest: { number: 214, reviewState: "approved", state: "open" },
    });
    expect(itemFor(result, `story:${ids.draftStory}`)).toMatchObject({
      phase: "in_progress",
      reason: "draft_pull_request",
    });
    expect(itemFor(result, `story:${ids.changesStory}`)).toMatchObject({
      phase: "attention",
      reason: "changes_requested",
      attention: [{ source: "github", kind: "changes_requested" }],
    });
    expect(itemFor(result, `story:${ids.closedPullStory}`)).toMatchObject({
      phase: "in_progress",
      reason: "pull_request_closed",
      pullRequest: { state: "closed" },
    });
    expect(itemFor(result, `story:${ids.mergedStory}`)).toMatchObject({
      phase: "done",
      reason: "merged",
      pullRequest: { number: 218, state: "merged" },
    });
    expect(itemFor(result, `issue:${repositoryId}:3`)).toMatchObject({
      phase: "done",
      reason: "issue_closed",
    });
  });

  it("searches, filters, combines filters, and paginates over the whole backlog", async () => {
    const byNumber = await service.list(orgId, projectId, { q: "#12" });
    expect(byNumber.items.map((item) => item.key)).toEqual([`story:${ids.attentionStory}`]);
    const byWords = await service.list(orgId, projectId, { q: "review awaiting", phase: ["all"] });
    expect(byWords.items.map((item) => item.title)).toEqual(["Awaiting review"]);

    const bugs = await service.list(orgId, projectId, {
      label: ["Bug"],
      phase: ["all"],
      limit: 100,
    });
    expect(bugs.total).toBe(31);
    expect(bugs.items.every((item) => item.labels.includes("bug"))).toBe(true);

    const ana = await service.list(orgId, projectId, {
      assignee: ["github:ana"],
      phase: ["all"],
      limit: 100,
    });
    expect(ana.items.map((item) => item.key)).toContain(`story:${ids.runningStory}`);
    expect(ana.items.map((item) => item.key)).toContain(`story:${ids.attentionStory}`);
    expect(ana.items.map((item) => item.key)).toContain(`issue:${repositoryId}:5`);
    const anaByUser = await service.list(orgId, projectId, {
      assignee: [`user:${anaId}`],
      phase: ["all"],
      limit: 100,
    });
    expect(anaByUser.total).toBe(ana.total);
    const me = await service.list(
      orgId,
      projectId,
      { assignee: ["me"], phase: ["all"], limit: 100 },
      { userId: benId },
    );
    expect(me.items.map((item) => item.key)).toEqual(
      expect.arrayContaining([`story:${ids.manualStory}`]),
    );
    expect(me.items.map((item) => item.key)).not.toContain(`story:${ids.attentionStory}`);
    const unassigned = await service.list(orgId, projectId, {
      assignee: ["unassigned"],
      phase: ["not_started"],
      limit: 100,
    });
    expect(unassigned.items.every((item) => item.assignees.length === 0)).toBe(true);
    expect(unassigned.total).toBeGreaterThan(0);
    const shared = itemFor(
      await service.list(orgId, projectId, { assignee: ["github:carol"], phase: ["all"] }),
      `issue:${repositoryId}:5`,
    );
    expect(shared.assignees).toHaveLength(2);

    const combined = await service.list(orgId, projectId, {
      label: ["bug"],
      assignee: ["github:ana"],
      phase: ["not_started"],
      repository: [repositoryId],
    });
    expect(
      combined.items.every(
        (item) => item.labels.includes("bug") && item.assignees.some((p) => p.login === "ana"),
      ),
    ).toBe(true);
    expect(combined.counts.not_started).toBe(combined.total);

    const docs = await service.list(orgId, projectId, { repository: [otherRepositoryId] });
    expect(docs.items.map((item) => item.title)).toEqual(["Docs typo"]);

    const first = await service.list(orgId, projectId, {
      phase: ["all"],
      sort: "updated",
      limit: 25,
    });
    const second = await service.list(orgId, projectId, {
      phase: ["all"],
      sort: "updated",
      limit: 25,
      offset: 25,
    });
    expect(first.total).toBe(second.total);
    expect(first.items).toHaveLength(25);
    expect(new Set([...first.items, ...second.items].map((item) => item.key)).size).toBe(50);
    expect(first.items[0]?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      first.items[24]?.lastActivityAt.getTime() ?? 0,
    );
    expect(first.counts.done).toBe(2);
    expect(first.counts.archived).toBe(1);
  });

  it("orders open work by what needs a person first and exposes filter vocabulary", async () => {
    const result = await service.list(orgId, projectId, { limit: 100 });
    const phases = result.items.map((item) => item.phase);
    expect(phases.indexOf("attention")).toBeLessThan(phases.indexOf("in_progress"));
    expect(phases.lastIndexOf("in_progress")).toBeLessThan(phases.indexOf("review"));
    expect(phases.lastIndexOf("review")).toBeLessThan(phases.indexOf("not_started"));
    expect(phases).not.toContain("done");
    expect(result.facets.labels.map((label) => label.name)).toEqual(
      expect.arrayContaining(["bug", "enhancement", "idea", "docs"]),
    );
    expect(result.facets.assignees.map((person) => person.key)).toEqual(
      expect.arrayContaining([`user:${anaId}`, "github:ben", "github:carol", `user:${benId}`]),
    );
    expect(result.facets.unassigned).toBeGreaterThan(0);
    expect(result.facets.repositories.map((repository) => repository.id)).toEqual(
      expect.arrayContaining([repositoryId, otherRepositoryId]),
    );
  });

  it("keeps tenants apart", async () => {
    const other = await service.list(otherOrgId, otherProjectId, { phase: ["all"] });
    expect(other.total).toBe(0);
    const crossed = await service.list(otherOrgId, projectId, { phase: ["all"] });
    expect(crossed.total).toBe(0);
  });
});
