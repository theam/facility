import {
  attentionItems,
  type FacilityDb,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  orgMembers,
  projectRepositories,
  stories,
  storyAssignees,
  turns,
  userIdentities,
  users,
  workspaces,
} from "@facility/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  derivePhase,
  type PhaseReason,
  type PullRequestSummary,
  pickPullRequest,
  reviewDecision,
  WORK_PHASES,
  type WorkPhase,
} from "./phase.js";

// The backlog reads persisted control-plane state only. It never inspects a
// workspace provider, so listing it cannot wake a machine or start a turn.
// Large text columns (issue and pull request bodies, manifests) are never
// selected here.

const MIRROR_STALE_AFTER_MS = 30 * 60 * 1_000;
const MAX_LIMIT = 100;

export type BacklogPhaseFilter = WorkPhase | "open" | "all";

export type BacklogQuery = {
  q?: string;
  phase?: BacklogPhaseFilter[];
  label?: string[];
  assignee?: string[];
  repository?: string[];
  sort?: "priority" | "updated" | "created";
  limit?: number;
  offset?: number;
};

export type BacklogViewer = { userId?: string; githubLogin?: string };

export type BacklogPerson = {
  key: string;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  sources: Array<"github" | "facility">;
};

export type BacklogItem = {
  key: string;
  kind: "story" | "issue" | "pull_request";
  title: string;
  titleSource: string;
  phase: WorkPhase;
  reason: PhaseReason;
  activity: {
    state: "running" | "queued" | "idle";
    agentName: string | null;
    engine: string | null;
    turnId: string | null;
    since: Date | null;
  };
  environment: { recordedState: string | null; lastActivityAt: Date | null };
  attention: Array<{
    id: string | null;
    source: "facility" | "github";
    kind: string;
    title: string;
    turnId: string | null;
    createdAt: Date | null;
  }>;
  story: {
    id: string;
    status: string;
    provider: string;
    externalId: string;
    branch: string | null;
    activeAgentName: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  issue: {
    repository: string;
    repositoryId: string;
    number: number;
    url: string;
    state: "open" | "closed";
    labels: string[];
    author: string | null;
    createdAt: Date | null;
    updatedAt: Date;
    closedAt: Date | null;
    syncedAt: Date;
    stale: boolean;
  } | null;
  pullRequest: (PullRequestSummary & { author: string | null }) | null;
  labels: string[];
  assignees: BacklogPerson[];
  createdAt: Date;
  lastActivityAt: Date;
};

export type BacklogResult = {
  generatedAt: Date;
  total: number;
  limit: number;
  offset: number;
  counts: Record<WorkPhase, number>;
  items: BacklogItem[];
  facets: {
    labels: Array<{ name: string; count: number }>;
    assignees: Array<BacklogPerson & { count: number }>;
    unassigned: number;
    repositories: Array<{ id: string; name: string; count: number }>;
  };
};

type PersonDirectory = {
  byLogin: Map<string, BacklogPerson>;
  byUserId: Map<string, BacklogPerson>;
};

const PHASE_PRIORITY: Record<WorkPhase, number> = {
  attention: 0,
  in_progress: 1,
  review: 2,
  not_started: 3,
  done: 4,
  archived: 5,
};

export class ProjectBacklogService {
  constructor(private readonly db: FacilityDb) {}

  async list(
    orgId: string,
    projectId: string,
    query: BacklogQuery = {},
    viewer: BacklogViewer = {},
    now = new Date(),
  ): Promise<BacklogResult> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const items = await this.items(orgId, projectId, now);

    const phases = expandPhases(query.phase);
    const labels = new Set((query.label ?? []).map((label) => label.toLowerCase()));
    const repositories = new Set(query.repository ?? []);
    const assigneeFilter = (query.assignee ?? []).map((value) =>
      resolveAssigneeFilter(value, viewer),
    );
    const search = (query.q ?? "").trim();

    const matchesSearch = (item: BacklogItem) => searchMatches(item, search);
    const matchesLabels = (item: BacklogItem) =>
      labels.size === 0 || item.labels.some((label) => labels.has(label.toLowerCase()));
    const matchesRepository = (item: BacklogItem) =>
      repositories.size === 0 ||
      (item.issue !== null && repositories.has(item.issue.repositoryId)) ||
      (item.pullRequest !== null && repositories.has(item.pullRequest.repository));
    const matchesAssignees = (item: BacklogItem) =>
      assigneeFilter.length === 0 || assigneeFilter.some((filter) => filter(item));

    const narrowed = items.filter(
      (item) =>
        matchesSearch(item) &&
        matchesLabels(item) &&
        matchesRepository(item) &&
        matchesAssignees(item),
    );
    const counts = Object.fromEntries(WORK_PHASES.map((phase) => [phase, 0])) as Record<
      WorkPhase,
      number
    >;
    for (const item of narrowed) counts[item.phase] += 1;
    const selected = narrowed.filter((item) => phases.has(item.phase));
    selected.sort(sorter(query.sort ?? "priority"));

    return {
      generatedAt: now,
      total: selected.length,
      limit,
      offset,
      counts,
      items: selected.slice(offset, offset + limit),
      facets: facets(items),
    };
  }

  private async items(orgId: string, projectId: string, now: Date): Promise<BacklogItem[]> {
    const storyScope = and(eq(stories.orgId, orgId), eq(stories.projectId, projectId));
    const [
      repositoryRows,
      issueRows,
      storyRows,
      pullRows,
      activeTurns,
      turnCounts,
      openAttention,
      workspaceRows,
      assigneeRows,
      directory,
    ] = await Promise.all([
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
          id: githubIssues.id,
          repositoryId: githubIssues.repositoryId,
          number: githubIssues.number,
          title: githubIssues.title,
          state: githubIssues.state,
          labels: githubIssues.labels,
          assignees: githubIssues.assignees,
          author: githubIssues.author,
          htmlUrl: githubIssues.htmlUrl,
          githubCreatedAt: githubIssues.githubCreatedAt,
          githubUpdatedAt: githubIssues.githubUpdatedAt,
          closedAt: githubIssues.closedAt,
          syncedAt: githubIssues.syncedAt,
          updatedAt: githubIssues.updatedAt,
        })
        .from(githubIssues)
        .where(and(eq(githubIssues.orgId, orgId), eq(githubIssues.projectId, projectId))),
      this.db
        .select({
          id: stories.id,
          repositoryId: stories.repositoryId,
          provider: stories.provider,
          externalId: stories.externalId,
          title: stories.title,
          titleSource: stories.titleSource,
          status: stories.status,
          activeAgentName: stories.activeAgentName,
          branch: stories.branch,
          pullRequestNumber: stories.pullRequestNumber,
          pullRequestUrl: stories.pullRequestUrl,
          createdAt: stories.createdAt,
          updatedAt: stories.updatedAt,
          deletedAt: stories.deletedAt,
        })
        .from(stories)
        .where(storyScope),
      this.db
        .select({
          repositoryId: githubPullRequests.repositoryId,
          number: githubPullRequests.number,
          title: githubPullRequests.title,
          state: githubPullRequests.state,
          draft: githubPullRequests.draft,
          author: githubPullRequests.author,
          headRef: githubPullRequests.headRef,
          htmlUrl: githubPullRequests.htmlUrl,
          closingIssues: githubPullRequests.closingIssues,
          ciState: githubPullRequests.ciState,
          ciFailureNames: githubPullRequests.ciFailureNames,
          githubUpdatedAt: githubPullRequests.githubUpdatedAt,
          githubCreatedAt: githubPullRequests.githubCreatedAt,
          updatedAt: githubPullRequests.updatedAt,
        })
        .from(githubPullRequests)
        .where(
          and(eq(githubPullRequests.orgId, orgId), eq(githubPullRequests.projectId, projectId)),
        ),
      this.db
        .select({
          id: turns.id,
          storyId: turns.storyId,
          state: turns.state,
          agentName: turns.agentName,
          engine: turns.engine,
          createdAt: turns.createdAt,
          startedAt: turns.startedAt,
        })
        .from(turns)
        .where(
          and(
            eq(turns.orgId, orgId),
            eq(turns.projectId, projectId),
            inArray(turns.state, ["queued", "running"]),
          ),
        ),
      this.db
        .select({ storyId: turns.storyId, count: sql<number>`count(*)::int` })
        .from(turns)
        .where(and(eq(turns.orgId, orgId), eq(turns.projectId, projectId)))
        .groupBy(turns.storyId),
      this.db
        .select({
          id: attentionItems.id,
          storyId: attentionItems.storyId,
          turnId: attentionItems.turnId,
          kind: attentionItems.kind,
          title: attentionItems.title,
          createdAt: attentionItems.createdAt,
        })
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.orgId, orgId),
            eq(attentionItems.projectId, projectId),
            eq(attentionItems.status, "open"),
          ),
        ),
      this.db
        .select({
          storyId: workspaces.storyId,
          state: workspaces.state,
          lastActivityAt: workspaces.lastActivityAt,
          createdAt: workspaces.createdAt,
        })
        .from(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.projectId, projectId))),
      this.db
        .select({
          storyId: storyAssignees.storyId,
          kind: storyAssignees.kind,
          subject: storyAssignees.subject,
          source: storyAssignees.source,
        })
        .from(storyAssignees)
        .where(and(eq(storyAssignees.orgId, orgId), eq(storyAssignees.projectId, projectId))),
      this.directory(orgId),
    ]);

    const repositoryName = new Map(
      repositoryRows.map((repository) => [repository.id, `${repository.owner}/${repository.name}`]),
    );
    const openPullKeys = pullRows
      .filter((pull) => pull.state === "open")
      .map((pull) => `${pull.repositoryId}:${pull.number}`);
    const reviewRows =
      openPullKeys.length === 0
        ? []
        : await this.db
            .select({
              repositoryId: githubPullRequestReviews.repositoryId,
              pullNumber: githubPullRequestReviews.pullNumber,
              author: githubPullRequestReviews.author,
              state: githubPullRequestReviews.state,
              submittedAt: githubPullRequestReviews.submittedAt,
            })
            .from(githubPullRequestReviews)
            .where(
              and(
                eq(githubPullRequestReviews.orgId, orgId),
                eq(githubPullRequestReviews.projectId, projectId),
                inArray(
                  sql`${githubPullRequestReviews.repositoryId} || ':' || ${githubPullRequestReviews.pullNumber}`,
                  openPullKeys,
                ),
              ),
            );
    const reviewsByPull = new Map<string, typeof reviewRows>();
    for (const review of reviewRows) {
      const key = `${review.repositoryId}:${review.pullNumber}`;
      reviewsByPull.set(key, [...(reviewsByPull.get(key) ?? []), review]);
    }
    const pulls = pullRows.map((pull) => ({
      ...pull,
      key: `${pull.repositoryId}:${pull.number}`,
      summary: {
        number: pull.number,
        title: pull.title,
        url: pull.htmlUrl,
        repository: repositoryName.get(pull.repositoryId) ?? pull.repositoryId,
        state: pull.state as "open" | "closed" | "merged",
        draft: pull.draft,
        ciState: (pull.ciState ?? null) as "pending" | "success" | "failure" | null,
        ciFailureNames: pull.ciFailureNames,
        reviewState:
          pull.state === "open"
            ? reviewDecision(
                reviewsByPull.get(`${pull.repositoryId}:${pull.number}`) ?? [],
                pull.author,
              )
            : null,
        headRef: pull.headRef,
        updatedAt: pull.githubUpdatedAt ?? pull.updatedAt,
        author: pull.author,
      } satisfies BacklogItem["pullRequest"],
    }));

    const activeByStory = new Map(activeTurns.map((turn) => [turn.storyId, turn]));
    const turnCountByStory = new Map(turnCounts.map((row) => [row.storyId, row.count]));
    const attentionByStory = new Map<string, typeof openAttention>();
    for (const item of openAttention) {
      attentionByStory.set(item.storyId, [...(attentionByStory.get(item.storyId) ?? []), item]);
    }
    const workspaceByStory = new Map<string, (typeof workspaceRows)[number]>();
    for (const workspace of workspaceRows) {
      const previous = workspaceByStory.get(workspace.storyId);
      if (!previous || workspace.createdAt > previous.createdAt) {
        workspaceByStory.set(workspace.storyId, workspace);
      }
    }
    const assigneesByStory = new Map<string, typeof assigneeRows>();
    for (const row of assigneeRows) {
      assigneesByStory.set(row.storyId, [...(assigneesByStory.get(row.storyId) ?? []), row]);
    }

    const storyByIssue = new Map<string, (typeof storyRows)[number]>();
    for (const story of storyRows) {
      if (story.provider === "github" && story.repositoryId) {
        const existing = storyByIssue.get(`${story.repositoryId}:${story.externalId}`);
        // Prefer a live story over a deleted one when both exist for the same issue.
        if (!existing || (existing.deletedAt && !story.deletedAt)) {
          storyByIssue.set(`${story.repositoryId}:${story.externalId}`, story);
        }
      }
    }
    const pullsForStory = (story: (typeof storyRows)[number]) =>
      pulls.filter(
        (pull) =>
          pull.repositoryId === story.repositoryId &&
          (story.pullRequestNumber === pull.number ||
            story.externalId === `pull-request:${pull.number}` ||
            (story.branch !== null && pull.headRef === story.branch)),
      );
    const pullsForIssue = (issue: (typeof issueRows)[number]) =>
      pulls.filter(
        (pull) =>
          pull.repositoryId === issue.repositoryId && pull.closingIssues.includes(issue.number),
      );

    const items: BacklogItem[] = [];
    const consumedStories = new Set<string>();
    const consumedPulls = new Set<string>();

    const buildStoryItem = (
      story: (typeof storyRows)[number],
      issue: (typeof issueRows)[number] | null,
    ): BacklogItem => {
      consumedStories.add(story.id);
      const linkedPulls = [...pullsForStory(story), ...(issue ? pullsForIssue(issue) : [])];
      for (const pull of linkedPulls) consumedPulls.add(pull.key);
      const pull = pickPullRequest(
        linkedPulls.map((entry) => ({ ...entry.summary, key: entry.key })),
      );
      const active = activeByStory.get(story.id) ?? null;
      const attention = attentionByStory.get(story.id) ?? [];
      const workspace = workspaceByStory.get(story.id) ?? null;
      const phase = derivePhase({
        story: {
          status: story.status,
          deletedAt: story.deletedAt,
          hasTurns: (turnCountByStory.get(story.id) ?? 0) > 0,
        },
        issue: issue ? { state: issue.state as "open" | "closed" } : null,
        pullRequest: pull,
        activeTurn: active ? { state: active.state as "queued" | "running" } : null,
        openAttention: attention,
      });
      const issueUpdatedAt = issue ? (issue.githubUpdatedAt ?? issue.updatedAt) : null;
      const lastActivityAt = latest([
        story.updatedAt,
        issueUpdatedAt,
        pull?.updatedAt ?? null,
        workspace?.lastActivityAt ?? null,
        active?.createdAt ?? null,
      ]);
      const persons = mergePersons(
        issue?.assignees ?? [],
        (assigneesByStory.get(story.id) ?? []).map((row) => ({
          kind: row.kind,
          subject: row.subject,
        })),
        directory,
      );
      return {
        key: `story:${story.id}`,
        kind: "story",
        title: story.title,
        titleSource: story.titleSource,
        phase: phase.phase,
        reason: phase.reason,
        activity: {
          state: active ? (active.state as "queued" | "running") : "idle",
          agentName: active?.agentName ?? null,
          engine: active?.engine ?? null,
          turnId: active?.id ?? null,
          since: active ? (active.startedAt ?? active.createdAt) : null,
        },
        environment: {
          recordedState: workspace?.state ?? null,
          lastActivityAt: workspace?.lastActivityAt ?? null,
        },
        attention: [
          ...attention.map((item) => ({
            id: item.id,
            source: "facility" as const,
            kind: item.kind,
            title: item.title,
            turnId: item.turnId,
            createdAt: item.createdAt,
          })),
          ...pullAttention(pull),
        ],
        story: {
          id: story.id,
          status: story.status,
          provider: story.provider,
          externalId: story.externalId,
          branch: story.branch,
          activeAgentName: story.activeAgentName,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
        },
        issue: issue ? presentIssue(issue, repositoryName, now) : null,
        pullRequest: pull,
        labels: issue?.labels ?? [],
        assignees: persons,
        createdAt: issue?.githubCreatedAt ?? story.createdAt,
        lastActivityAt,
      };
    };

    for (const issue of issueRows) {
      const story = storyByIssue.get(`${issue.repositoryId}:issue:${issue.number}`);
      if (story) {
        items.push(buildStoryItem(story, issue));
        continue;
      }
      const linkedPulls = pullsForIssue(issue);
      for (const pull of linkedPulls) consumedPulls.add(pull.key);
      const pull = pickPullRequest(linkedPulls.map((entry) => entry.summary));
      const phase = derivePhase({
        story: null,
        issue: { state: issue.state as "open" | "closed" },
        pullRequest: pull,
        activeTurn: null,
        openAttention: [],
      });
      const updatedAt = issue.githubUpdatedAt ?? issue.updatedAt;
      items.push({
        key: `issue:${issue.repositoryId}:${issue.number}`,
        kind: "issue",
        title: issue.title,
        titleSource: "github",
        phase: phase.phase,
        reason: phase.reason,
        activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
        environment: { recordedState: null, lastActivityAt: null },
        attention: pullAttention(pull),
        story: null,
        issue: presentIssue(issue, repositoryName, now),
        pullRequest: pull,
        labels: issue.labels,
        assignees: mergePersons(issue.assignees, [], directory),
        createdAt: issue.githubCreatedAt ?? issue.updatedAt,
        lastActivityAt: latest([updatedAt, pull?.updatedAt ?? null]),
      });
    }

    for (const story of storyRows) {
      if (consumedStories.has(story.id)) continue;
      items.push(buildStoryItem(story, null));
    }

    // Open pull requests nobody claimed are still reviewable work.
    for (const pull of pulls) {
      if (consumedPulls.has(pull.key) || pull.state !== "open") continue;
      const phase = derivePhase({
        story: null,
        issue: null,
        pullRequest: pull.summary,
        activeTurn: null,
        openAttention: [],
      });
      items.push({
        key: `pull-request:${pull.repositoryId}:${pull.number}`,
        kind: "pull_request",
        title: pull.title,
        titleSource: "github",
        phase: phase.phase,
        reason: phase.reason,
        activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
        environment: { recordedState: null, lastActivityAt: null },
        attention: pullAttention(pull.summary),
        story: null,
        issue: null,
        pullRequest: pull.summary,
        labels: [],
        assignees: mergePersons(pull.author ? [pull.author] : [], [], directory),
        createdAt: pull.githubCreatedAt ?? pull.updatedAt,
        lastActivityAt: pull.summary.updatedAt,
      });
    }
    return items;
  }

  /** Organization members with their GitHub login, so both sources name the same person. */
  private async directory(orgId: string): Promise<PersonDirectory> {
    const rows = await this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        login: userIdentities.login,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .leftJoin(
        userIdentities,
        and(eq(userIdentities.userId, users.id), eq(userIdentities.provider, "github")),
      )
      .where(eq(orgMembers.orgId, orgId));
    const byLogin = new Map<string, BacklogPerson>();
    const byUserId = new Map<string, BacklogPerson>();
    for (const row of rows) {
      const person: BacklogPerson = {
        key: `user:${row.userId}`,
        login: row.login ?? null,
        name: row.name ?? row.login ?? row.email,
        avatarUrl: row.avatarUrl ?? null,
        sources: [],
      };
      byUserId.set(row.userId, person);
      if (row.login) byLogin.set(row.login.toLowerCase(), person);
    }
    return { byLogin, byUserId };
  }
}

function presentIssue(
  issue: {
    repositoryId: string;
    number: number;
    htmlUrl: string;
    state: string;
    labels: string[];
    author: string | null;
    githubCreatedAt: Date | null;
    githubUpdatedAt: Date | null;
    updatedAt: Date;
    closedAt: Date | null;
    syncedAt: Date;
  },
  repositoryName: Map<string, string>,
  now: Date,
): NonNullable<BacklogItem["issue"]> {
  return {
    repository: repositoryName.get(issue.repositoryId) ?? issue.repositoryId,
    repositoryId: issue.repositoryId,
    number: issue.number,
    url: issue.htmlUrl,
    state: issue.state === "closed" ? "closed" : "open",
    labels: issue.labels,
    author: issue.author,
    createdAt: issue.githubCreatedAt,
    updatedAt: issue.githubUpdatedAt ?? issue.updatedAt,
    closedAt: issue.closedAt,
    syncedAt: issue.syncedAt,
    stale: now.getTime() - issue.syncedAt.getTime() > MIRROR_STALE_AFTER_MS,
  };
}

function pullAttention(pull: PullRequestSummary | null): BacklogItem["attention"] {
  if (pull?.state !== "open") return [];
  const items: BacklogItem["attention"] = [];
  if (pull.ciState === "failure") {
    items.push({
      id: null,
      source: "github",
      kind: "checks_failing",
      title:
        pull.ciFailureNames.length > 0
          ? `Checks failing: ${pull.ciFailureNames.join(", ")}`
          : "Checks failing",
      turnId: null,
      createdAt: pull.updatedAt,
    });
  }
  if (pull.reviewState === "changes_requested") {
    items.push({
      id: null,
      source: "github",
      kind: "changes_requested",
      title: "Changes requested in review",
      turnId: null,
      createdAt: pull.updatedAt,
    });
  }
  return items;
}

export function mergePersons(
  githubLogins: string[],
  facilityAssignees: Array<{ kind: string; subject: string }>,
  directory: PersonDirectory,
): BacklogPerson[] {
  const merged = new Map<string, BacklogPerson>();
  const add = (person: BacklogPerson, source: "github" | "facility") => {
    const existing = merged.get(person.key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    merged.set(person.key, { ...person, sources: [source] });
  };
  for (const login of githubLogins) {
    const member = directory.byLogin.get(login.toLowerCase());
    add(
      member ?? { key: `github:${login}`, login, name: null, avatarUrl: null, sources: [] },
      "github",
    );
  }
  for (const assignee of facilityAssignees) {
    if (assignee.kind === "user") {
      const member = directory.byUserId.get(assignee.subject);
      add(
        member ?? {
          key: `user:${assignee.subject}`,
          login: null,
          name: null,
          avatarUrl: null,
          sources: [],
        },
        "facility",
      );
    } else {
      const member = directory.byLogin.get(assignee.subject.toLowerCase());
      add(
        member ?? {
          key: `github:${assignee.subject}`,
          login: assignee.subject,
          name: null,
          avatarUrl: null,
          sources: [],
        },
        "facility",
      );
    }
  }
  return [...merged.values()];
}

function expandPhases(filter: BacklogPhaseFilter[] | undefined): Set<WorkPhase> {
  const values = filter && filter.length > 0 ? filter : ["open" as const];
  const phases = new Set<WorkPhase>();
  for (const value of values) {
    if (value === "all") for (const phase of WORK_PHASES) phases.add(phase);
    else if (value === "open") {
      for (const phase of WORK_PHASES)
        if (phase !== "done" && phase !== "archived") phases.add(phase);
    } else phases.add(value);
  }
  return phases;
}

/** Ticket ids (`#42`, `42`), story ids, and words in the title all match. */
export function searchMatches(item: BacklogItem, search: string): boolean {
  if (!search) return true;
  const numeric = /^(#?)(\d+)$/.exec(search);
  if (numeric) {
    const number = Number(numeric[2]);
    if (item.issue?.number === number || item.pullRequest?.number === number) return true;
    // `#12` is a ticket reference and nothing else; a bare number may still be a word.
    if (numeric[1] === "#") return false;
  }
  const haystack = [
    item.title,
    item.story?.id ?? "",
    item.story?.externalId ?? "",
    item.story?.branch ?? "",
    item.issue ? `${item.issue.repository}#${item.issue.number}` : "",
    item.pullRequest ? `${item.pullRequest.repository}#${item.pullRequest.number}` : "",
    ...item.labels,
    ...item.assignees.flatMap((person) => [person.login ?? "", person.name ?? ""]),
  ]
    .join("\n")
    .toLowerCase();
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function resolveAssigneeFilter(
  value: string,
  viewer: BacklogViewer,
): (item: BacklogItem) => boolean {
  if (value === "unassigned") return (item) => item.assignees.length === 0;
  if (value === "me") {
    const keys = new Set<string>();
    if (viewer.userId) keys.add(`user:${viewer.userId}`);
    const login = viewer.githubLogin?.toLowerCase();
    return (item) =>
      item.assignees.some(
        (person) =>
          keys.has(person.key) || (login !== undefined && person.login?.toLowerCase() === login),
      );
  }
  const [kind, ...rest] = value.split(":");
  const subject = rest.join(":");
  if (kind === "github" && subject) {
    const login = subject.toLowerCase();
    return (item) => item.assignees.some((person) => person.login?.toLowerCase() === login);
  }
  if (kind === "user" && subject) {
    return (item) => item.assignees.some((person) => person.key === `user:${subject}`);
  }
  return () => false;
}

function sorter(sort: NonNullable<BacklogQuery["sort"]>) {
  if (sort === "created") {
    return (left: BacklogItem, right: BacklogItem) =>
      right.createdAt.getTime() - left.createdAt.getTime() || left.key.localeCompare(right.key);
  }
  if (sort === "updated") {
    return (left: BacklogItem, right: BacklogItem) =>
      right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
      left.key.localeCompare(right.key);
  }
  return (left: BacklogItem, right: BacklogItem) =>
    PHASE_PRIORITY[left.phase] - PHASE_PRIORITY[right.phase] ||
    right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
    left.key.localeCompare(right.key);
}

function facets(items: BacklogItem[]): BacklogResult["facets"] {
  const labels = new Map<string, { name: string; count: number }>();
  const assignees = new Map<string, BacklogPerson & { count: number }>();
  const repositories = new Map<string, { id: string; name: string; count: number }>();
  let unassigned = 0;
  for (const item of items) {
    if (item.phase === "done" || item.phase === "archived") continue;
    for (const label of item.labels) {
      const entry = labels.get(label.toLowerCase()) ?? { name: label, count: 0 };
      entry.count += 1;
      labels.set(label.toLowerCase(), entry);
    }
    if (item.assignees.length === 0) unassigned += 1;
    for (const person of item.assignees) {
      const entry = assignees.get(person.key) ?? {
        ...person,
        sources: [...person.sources],
        count: 0,
      };
      entry.count += 1;
      for (const source of person.sources) {
        if (!entry.sources.includes(source)) entry.sources.push(source);
      }
      assignees.set(person.key, entry);
    }
    if (item.issue) {
      const entry = repositories.get(item.issue.repositoryId) ?? {
        id: item.issue.repositoryId,
        name: item.issue.repository,
        count: 0,
      };
      entry.count += 1;
      repositories.set(item.issue.repositoryId, entry);
    }
  }
  const byCount = <T extends { count: number }>(left: T, right: T) => right.count - left.count;
  return {
    labels: [...labels.values()].sort(
      (left, right) => byCount(left, right) || left.name.localeCompare(right.name),
    ),
    assignees: [...assignees.values()].sort(
      (left, right) =>
        byCount(left, right) ||
        (left.name ?? left.login ?? "").localeCompare(right.name ?? right.login ?? ""),
    ),
    unassigned,
    repositories: [...repositories.values()].sort(byCount),
  };
}

function latest(values: Array<Date | null | undefined>): Date {
  let result: Date | null = null;
  for (const value of values) {
    if (value && (!result || value > result)) result = value;
  }
  return result ?? new Date(0);
}
