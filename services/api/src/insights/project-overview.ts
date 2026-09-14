import {
  attentionItems,
  type FacilityDb,
  githubIssues,
  githubPullRequests,
  projectRepositories,
  stories,
  turns,
  turnUsage,
  workspaces,
} from "@facility/db";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type CostBudgetService, monthWindow } from "./costs.js";

// The overview is the operator's entry point. It reads persisted control-plane
// state only: it never inspects a workspace provider, so opening it cannot wake
// a machine or start a turn. Text columns that can be large (issue bodies,
// webhook payloads, manifests) are never selected here.

export const STORY_STATUSES = [
  "ready",
  "working",
  "attention",
  "review",
  "done",
  "archived",
] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];
const ACTIVE_TURN_STATES = ["queued", "running"] as const;
const TERMINAL_TURN_STATES = ["succeeded", "failed", "canceled"] as const;
const RETAINED_WORKSPACE_STATES = ["creating", "running", "sleeping", "error", "deleting"] as const;

const RECENT_LIMIT = 10;
const ATTENTION_LIMIT = 20;
const REVIEW_LIMIT = 20;
const BACKLOG_LIMIT = 8;
const ACTIVE_LIMIT = 50;
const ERROR_EXCERPT = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;

type StoryRow = Pick<
  typeof stories.$inferSelect,
  | "id"
  | "title"
  | "status"
  | "provider"
  | "externalId"
  | "repositoryId"
  | "branch"
  | "pullRequestNumber"
  | "pullRequestUrl"
  | "activeAgentName"
  | "updatedAt"
  | "deletedAt"
>;

export type OverviewAccess = {
  costs: boolean;
  budgets: boolean;
};

export class ProjectOverviewService {
  constructor(
    private readonly db: FacilityDb,
    private readonly costs: CostBudgetService,
  ) {}

  async overview(orgId: string, projectId: string, access: OverviewAccess, now = new Date()) {
    const storyScope = and(eq(stories.orgId, orgId), eq(stories.projectId, projectId));
    const turnScope = and(eq(turns.orgId, orgId), eq(turns.projectId, projectId));
    const [monthStart, monthEnd] = monthWindow(now);
    const weekStart = new Date(now.getTime() - 7 * DAY_MS);
    const [
      storyRows,
      activeTurns,
      recentTurns,
      openAttention,
      openAttentionCount,
      openPulls,
      openIssues,
      repositories,
      workspaceRows,
      monthUsage,
      weekUsage,
      monthAgents,
      monthTerminalTurns,
      budget,
    ] = await Promise.all([
      this.db
        .select({
          id: stories.id,
          title: stories.title,
          status: stories.status,
          provider: stories.provider,
          externalId: stories.externalId,
          repositoryId: stories.repositoryId,
          branch: stories.branch,
          pullRequestNumber: stories.pullRequestNumber,
          pullRequestUrl: stories.pullRequestUrl,
          activeAgentName: stories.activeAgentName,
          updatedAt: stories.updatedAt,
          deletedAt: stories.deletedAt,
        })
        .from(stories)
        .where(storyScope)
        .orderBy(desc(stories.updatedAt)),
      this.db
        .select({
          id: turns.id,
          storyId: turns.storyId,
          agentName: turns.agentName,
          engine: turns.engine,
          model: turns.model,
          state: turns.state,
          triggerType: turns.triggerType,
          createdAt: turns.createdAt,
          startedAt: turns.startedAt,
          scheduledFor: turns.scheduledFor,
        })
        .from(turns)
        .where(and(turnScope, inArray(turns.state, [...ACTIVE_TURN_STATES])))
        .orderBy(asc(turns.startedAt), asc(turns.createdAt))
        .limit(ACTIVE_LIMIT),
      this.db
        .select({
          id: turns.id,
          storyId: turns.storyId,
          agentName: turns.agentName,
          state: turns.state,
          triggerType: turns.triggerType,
          error: turns.error,
          createdAt: turns.createdAt,
          startedAt: turns.startedAt,
          endedAt: turns.endedAt,
          updatedAt: turns.updatedAt,
        })
        .from(turns)
        .where(and(turnScope, inArray(turns.state, [...TERMINAL_TURN_STATES])))
        .orderBy(desc(sql`coalesce(${turns.endedAt}, ${turns.updatedAt})`))
        .limit(RECENT_LIMIT),
      this.db
        .select({
          id: attentionItems.id,
          storyId: attentionItems.storyId,
          turnId: attentionItems.turnId,
          kind: attentionItems.kind,
          title: attentionItems.title,
          detail: attentionItems.detail,
          createdAt: attentionItems.createdAt,
        })
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.orgId, orgId),
            eq(attentionItems.projectId, projectId),
            eq(attentionItems.status, "open"),
          ),
        )
        .orderBy(desc(attentionItems.createdAt))
        .limit(ATTENTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.orgId, orgId),
            eq(attentionItems.projectId, projectId),
            eq(attentionItems.status, "open"),
          ),
        )
        .then((rows) => rows[0]?.count ?? 0),
      this.db
        .select({
          repositoryId: githubPullRequests.repositoryId,
          number: githubPullRequests.number,
          title: githubPullRequests.title,
          htmlUrl: githubPullRequests.htmlUrl,
          draft: githubPullRequests.draft,
          headRef: githubPullRequests.headRef,
          ciState: githubPullRequests.ciState,
          ciFailureNames: githubPullRequests.ciFailureNames,
          githubUpdatedAt: githubPullRequests.githubUpdatedAt,
          updatedAt: githubPullRequests.updatedAt,
        })
        .from(githubPullRequests)
        .where(
          and(
            eq(githubPullRequests.orgId, orgId),
            eq(githubPullRequests.projectId, projectId),
            eq(githubPullRequests.state, "open"),
          ),
        )
        .orderBy(desc(githubPullRequests.githubUpdatedAt)),
      this.db
        .select({ repositoryId: githubIssues.repositoryId, number: githubIssues.number })
        .from(githubIssues)
        .where(
          and(
            eq(githubIssues.orgId, orgId),
            eq(githubIssues.projectId, projectId),
            eq(githubIssues.state, "open"),
          ),
        ),
      this.db
        .select({
          id: projectRepositories.id,
          owner: projectRepositories.owner,
          name: projectRepositories.name,
        })
        .from(projectRepositories)
        .where(
          and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)),
        ),
      this.db
        .select({
          state: workspaces.state,
          count: sql<number>`count(*)::int`,
          lastActivityAt: sql<string | Date | null>`max(${workspaces.lastActivityAt})`,
        })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            inArray(workspaces.state, [...RETAINED_WORKSPACE_STATES]),
          ),
        )
        .groupBy(workspaces.state),
      access.costs ? this.usageWindow(orgId, projectId, monthStart, monthEnd) : null,
      access.costs ? this.usageWindow(orgId, projectId, weekStart, now) : null,
      access.costs ? this.usageByAgent(orgId, projectId, monthStart, monthEnd) : null,
      access.costs
        ? this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(turns)
            .where(
              and(
                turnScope,
                inArray(turns.state, [...TERMINAL_TURN_STATES]),
                gte(turns.endedAt, monthStart),
                lt(turns.endedAt, monthEnd),
              ),
            )
            .then((rows) => rows[0]?.count ?? 0)
        : null,
      access.budgets ? this.costs.budgetState(orgId, projectId, now) : null,
    ]);

    const liveStories = storyRows.filter((story) => story.deletedAt === null);
    const storyById = new Map(storyRows.map((story) => [story.id, story]));
    const repositoryById = new Map(
      repositories.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]),
    );
    const storyRef = (storyId: string) => {
      const story = storyById.get(storyId);
      return {
        storyId,
        storyTitle: story?.title ?? "Unknown story",
        storyStatus: (story?.status ?? "ready") as StoryStatus,
      };
    };

    const running = activeTurns.filter((turn) => turn.state === "running");
    const queued = activeTurns.filter((turn) => turn.state === "queued");
    const presentActive = (turn: (typeof activeTurns)[number]) => ({
      turnId: turn.id,
      ...storyRef(turn.storyId),
      agentName: turn.agentName,
      engine: turn.engine,
      model: turn.model,
      triggerType: turn.triggerType,
      state: turn.state as "queued" | "running",
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      scheduledFor: turn.scheduledFor,
    });

    const attention = openAttention.map((item) => ({
      id: item.id,
      ...storyRef(item.storyId),
      turnId: item.turnId,
      kind: item.kind,
      title: item.title,
      detail: item.detail === null ? null : item.detail.slice(0, ERROR_EXCERPT * 2),
      createdAt: item.createdAt,
      action: attentionAction(item),
    }));

    const review = reviewItems(liveStories, openPulls, repositoryById);

    const recent = recentTurns.map((turn) => {
      const story = storyById.get(turn.storyId);
      const endedAt = turn.endedAt ?? turn.updatedAt;
      return {
        turnId: turn.id,
        ...storyRef(turn.storyId),
        agentName: turn.agentName,
        state: turn.state as (typeof TERMINAL_TURN_STATES)[number],
        triggerType: turn.triggerType,
        endedAt,
        durationMs: turn.startedAt
          ? Math.max(0, endedAt.getTime() - turn.startedAt.getTime())
          : null,
        error: turn.error === null ? null : turn.error.slice(0, ERROR_EXCERPT),
        pullRequest:
          story?.pullRequestNumber !== null &&
          story?.pullRequestNumber !== undefined &&
          story.pullRequestUrl
            ? { number: story.pullRequestNumber, url: story.pullRequestUrl }
            : null,
      };
    });

    const counts = Object.fromEntries(STORY_STATUSES.map((status) => [status, 0])) as Record<
      StoryStatus,
      number
    >;
    for (const story of liveStories) {
      if (story.status in counts) counts[story.status as StoryStatus] += 1;
    }
    const issueStories = new Set(
      liveStories
        .filter((story) => story.provider === "github")
        .map((story) => `${story.repositoryId ?? "none"}:${story.externalId}`),
    );
    const openIssuesWithoutStory = openIssues.filter(
      (issue) => !issueStories.has(`${issue.repositoryId}:issue:${issue.number}`),
    ).length;
    const ready = liveStories
      .filter((story) => story.status === "ready")
      .slice(0, BACKLOG_LIMIT)
      .map(presentStory);

    const recorded = Object.fromEntries(
      RETAINED_WORKSPACE_STATES.map((state) => [state, 0]),
    ) as Record<(typeof RETAINED_WORKSPACE_STATES)[number], number>;
    let lastActivityAt: Date | null = null;
    for (const row of workspaceRows) {
      if (row.state in recorded) {
        recorded[row.state as keyof typeof recorded] = row.count;
      }
      // Aggregates come back as raw values; normalize to a Date before comparing.
      const activity = row.lastActivityAt === null ? null : new Date(row.lastActivityAt);
      if (activity && Number.isFinite(activity.getTime())) {
        if (!lastActivityAt || activity > lastActivityAt) lastActivityAt = activity;
      }
    }

    return {
      generatedAt: now,
      activity: { running: running.map(presentActive), queued: queued.map(presentActive) },
      attention: { openCount: openAttentionCount, items: attention },
      review: { items: review.slice(0, REVIEW_LIMIT), total: review.length },
      recent: { items: recent },
      backlog: {
        ready,
        counts,
        openIssues: openIssues.length,
        openIssuesWithoutStory,
      },
      environments: {
        retained: workspaceRows.reduce((total, row) => total + row.count, 0),
        recorded,
        lastActivityAt,
      },
      spend: {
        agents:
          access.costs && monthUsage && weekUsage && monthAgents
            ? {
                available: true as const,
                month: {
                  from: monthStart,
                  to: monthEnd,
                  ...monthUsage,
                  unmeasuredTurns: Math.max(0, (monthTerminalTurns ?? 0) - monthUsage.turns),
                },
                lastSevenDays: { from: weekStart, to: now, ...weekUsage, unmeasuredTurns: 0 },
                byAgent: monthAgents,
              }
            : { available: false as const, reason: "permission" as const },
        budget:
          access.budgets && budget
            ? {
                available: true as const,
                state: budget.state,
                enabled: budget.budget?.enabled ?? false,
                monthlyLimitCents: budget.budget?.monthlyLimitCents ?? null,
                warningPercent: budget.budget?.warningPercent ?? null,
                windowStart: budget.windowStart,
                windowEnd: budget.windowEnd,
                spentCents: budget.spentCents,
                remainingCents: budget.remainingCents,
                percentUsed: budget.percentUsed,
              }
            : { available: false as const, reason: "permission" as const },
      },
    };
  }

  private async usageWindow(orgId: string, projectId: string, from: Date, to: Date) {
    const row = await this.db
      .select({
        turns: sql<number>`count(*)::int`,
        pricedTurns: sql<number>`count(*) filter (where ${turnUsage.priced})::int`,
        unpricedTurns: sql<number>`count(*) filter (where not ${turnUsage.priced})::int`,
        costCents: sql<number>`coalesce(sum(${turnUsage.costCents}) filter (where ${turnUsage.priced}), 0)::float8`,
      })
      .from(turnUsage)
      .where(
        and(
          eq(turnUsage.orgId, orgId),
          eq(turnUsage.projectId, projectId),
          gte(turnUsage.createdAt, from),
          lt(turnUsage.createdAt, to),
        ),
      )
      .then((rows) => rows[0]);
    return {
      turns: row?.turns ?? 0,
      pricedTurns: row?.pricedTurns ?? 0,
      unpricedTurns: row?.unpricedTurns ?? 0,
      costCents: row?.costCents ?? 0,
    };
  }

  private async usageByAgent(orgId: string, projectId: string, from: Date, to: Date) {
    const rows = await this.db
      .select({
        agentName: turnUsage.agentName,
        turns: sql<number>`count(*)::int`,
        unpricedTurns: sql<number>`count(*) filter (where not ${turnUsage.priced})::int`,
        costCents: sql<number>`coalesce(sum(${turnUsage.costCents}) filter (where ${turnUsage.priced}), 0)::float8`,
      })
      .from(turnUsage)
      .where(
        and(
          eq(turnUsage.orgId, orgId),
          eq(turnUsage.projectId, projectId),
          gte(turnUsage.createdAt, from),
          lt(turnUsage.createdAt, to),
        ),
      )
      .groupBy(turnUsage.agentName)
      .orderBy(
        desc(sql`coalesce(sum(${turnUsage.costCents}) filter (where ${turnUsage.priced}), 0)`),
      )
      .limit(5);
    return rows.map((row) => ({
      agentName: row.agentName,
      turns: row.turns,
      unpricedTurns: row.unpricedTurns,
      costCents: row.costCents,
    }));
  }
}

export function attentionAction(item: { kind: string; turnId: string | null }) {
  if (item.kind === "agent_waiting") return "reply" as const;
  if (item.turnId) return "retry" as const;
  return "dismiss" as const;
}

function presentStory(story: StoryRow) {
  return {
    storyId: story.id,
    title: story.title,
    status: story.status as StoryStatus,
    provider: story.provider as "github" | "manual" | "schedule",
    externalId: story.externalId,
    branch: story.branch,
    activeAgentName: story.activeAgentName,
    pullRequestNumber: story.pullRequestNumber,
    pullRequestUrl: story.pullRequestUrl,
    updatedAt: story.updatedAt,
  };
}

export type ReviewItem = {
  source: "mirror" | "story";
  storyId: string | null;
  storyTitle: string | null;
  storyStatus: StoryStatus | null;
  activeAgentName: string | null;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    repository: string;
    draft: boolean;
    ciState: "pending" | "success" | "failure" | null;
    ciFailureNames: string[];
    updatedAt: Date;
  };
};

type PullRow = {
  repositoryId: string;
  number: number;
  title: string;
  htmlUrl: string;
  draft: boolean;
  headRef: string;
  ciState: string | null;
  ciFailureNames: string[];
  githubUpdatedAt: Date | null;
  updatedAt: Date;
};

/**
 * Open pull requests from the GitHub mirror, each linked to its story when the
 * story recorded the pull request or was created from it. Stories that recorded
 * a pull request the mirror does not know about are listed from the story so a
 * project without mirror sync still sees what is waiting for review. Failing
 * checks come first, then reviewable, then pending; drafts last.
 */
export function reviewItems(
  liveStories: StoryRow[],
  openPulls: PullRow[],
  repositoryById: Map<string, string>,
) {
  const byRecordedPull = new Map<string, StoryRow>();
  const byExternal = new Map<string, StoryRow>();
  for (const story of liveStories) {
    if (story.pullRequestNumber !== null && story.repositoryId) {
      byRecordedPull.set(`${story.repositoryId}:${story.pullRequestNumber}`, story);
    }
    if (story.provider === "github" && story.repositoryId) {
      byExternal.set(`${story.repositoryId}:${story.externalId}`, story);
    }
  }
  const mirroredPulls = new Set<string>();
  const items: ReviewItem[] = openPulls.map((pull) => {
    const key = `${pull.repositoryId}:${pull.number}`;
    mirroredPulls.add(key);
    const story =
      byRecordedPull.get(key) ?? byExternal.get(`${pull.repositoryId}:pull-request:${pull.number}`);
    return {
      source: "mirror" as const,
      storyId: story?.id ?? null,
      storyTitle: story?.title ?? null,
      storyStatus: (story?.status ?? null) as StoryStatus | null,
      activeAgentName: story?.activeAgentName ?? null,
      pullRequest: {
        number: pull.number,
        title: pull.title,
        url: pull.htmlUrl,
        repository: repositoryById.get(pull.repositoryId) ?? pull.repositoryId,
        draft: pull.draft,
        ciState: (pull.ciState ?? null) as "pending" | "success" | "failure" | null,
        ciFailureNames: pull.ciFailureNames,
        updatedAt: pull.githubUpdatedAt ?? pull.updatedAt,
      },
    };
  });
  for (const story of liveStories) {
    if (
      story.pullRequestNumber === null ||
      !story.pullRequestUrl ||
      story.status === "done" ||
      story.status === "archived"
    ) {
      continue;
    }
    if (
      story.repositoryId &&
      mirroredPulls.has(`${story.repositoryId}:${story.pullRequestNumber}`)
    ) {
      continue;
    }
    items.push({
      source: "story" as const,
      storyId: story.id,
      storyTitle: story.title,
      storyStatus: story.status as StoryStatus,
      activeAgentName: story.activeAgentName,
      pullRequest: {
        number: story.pullRequestNumber,
        title: story.title,
        url: story.pullRequestUrl,
        repository: story.repositoryId
          ? (repositoryById.get(story.repositoryId) ?? story.repositoryId)
          : "",
        draft: false,
        ciState: null,
        ciFailureNames: [],
        updatedAt: story.updatedAt,
      },
    });
  }
  const rank = (item: ReviewItem) => {
    if (item.pullRequest.draft) return 3;
    if (item.pullRequest.ciState === "failure") return 0;
    if (item.pullRequest.ciState === "success") return 1;
    return 2;
  };
  return items.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      right.pullRequest.updatedAt.getTime() - left.pullRequest.updatedAt.getTime(),
  );
}
