import {
  type FacilityDb,
  githubIssues,
  githubPullRequests,
  projectRepositories,
  stories,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";

export type PipelineStage =
  | "backlog"
  | "planning"
  | "building"
  | "validating"
  | "review"
  | "shipped";

export const PIPELINE_STAGES: Array<{ key: PipelineStage; label: string }> = [
  { key: "backlog", label: "Backlog" },
  { key: "planning", label: "Planning" },
  { key: "building", label: "Building" },
  { key: "validating", label: "Validating" },
  { key: "review", label: "In review" },
  { key: "shipped", label: "Shipped" },
];

type PipelineItem = {
  key: string;
  source: "issue" | "pull_request";
  number: number;
  title: string;
  url: string;
  repository: string;
  labels: string[];
  assignees: string[];
  updatedAt: Date;
  stage: PipelineStage;
  state: string;
  story: ReturnType<typeof presentStory>;
  pullRequests: Array<ReturnType<typeof presentPullRequest>>;
};

export class GithubPipelineService {
  constructor(private readonly db: FacilityDb) {}

  async get(orgId: string, projectId: string) {
    const [repositories, issues, pulls, storyRows] = await Promise.all([
      this.db
        .select()
        .from(projectRepositories)
        .where(
          and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)),
        ),
      this.db
        .select()
        .from(githubIssues)
        .where(and(eq(githubIssues.orgId, orgId), eq(githubIssues.projectId, projectId)))
        .orderBy(desc(githubIssues.githubUpdatedAt)),
      this.db
        .select()
        .from(githubPullRequests)
        .where(
          and(eq(githubPullRequests.orgId, orgId), eq(githubPullRequests.projectId, projectId)),
        )
        .orderBy(desc(githubPullRequests.githubUpdatedAt)),
      this.db
        .select()
        .from(stories)
        .where(and(eq(stories.orgId, orgId), eq(stories.projectId, projectId)))
        .orderBy(desc(stories.updatedAt)),
    ]);
    const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
    const storyByExternal = new Map(
      storyRows
        .filter((story) => story.provider === "github")
        .map((story) => [`${story.repositoryId ?? "none"}:${story.externalId}`, story]),
    );
    const linkedPullNumbers = new Set<string>();
    const items: PipelineItem[] = issues.map((issue) => {
      const story = storyByExternal.get(`${issue.repositoryId}:issue:${issue.number}`);
      const relatedPulls = pulls.filter(
        (pull) =>
          pull.repositoryId === issue.repositoryId &&
          (pull.closingIssues.includes(issue.number) || story?.pullRequestNumber === pull.number),
      );
      for (const pull of relatedPulls) linkedPullNumbers.add(`${pull.repositoryId}:${pull.number}`);
      const placement = place(story, relatedPulls, issue.state === "closed" ? "closed" : "open");
      const repository = repositoryById.get(issue.repositoryId);
      return {
        key: `${issue.repositoryId}:issue:${issue.number}`,
        source: "issue" as const,
        number: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
        repository: repository ? `${repository.owner}/${repository.name}` : issue.repositoryId,
        labels: issue.labels,
        assignees: issue.assignees,
        updatedAt: issue.githubUpdatedAt ?? issue.updatedAt,
        ...placement,
        story: presentStory(story),
        pullRequests: relatedPulls.map(presentPullRequest),
      };
    });
    for (const pull of pulls) {
      if (linkedPullNumbers.has(`${pull.repositoryId}:${pull.number}`)) continue;
      const story =
        storyByExternal.get(`${pull.repositoryId}:pull-request:${pull.number}`) ??
        storyRows.find(
          (candidate) =>
            candidate.repositoryId === pull.repositoryId &&
            candidate.pullRequestNumber === pull.number,
        );
      const placement = place(story, [pull], pull.state === "open" ? "open" : "closed");
      const repository = repositoryById.get(pull.repositoryId);
      items.push({
        key: `${pull.repositoryId}:pull-request:${pull.number}`,
        source: "pull_request",
        number: pull.number,
        title: pull.title,
        url: pull.htmlUrl,
        repository: repository ? `${repository.owner}/${repository.name}` : pull.repositoryId,
        labels: [],
        assignees: [],
        updatedAt: pull.githubUpdatedAt ?? pull.updatedAt,
        ...placement,
        story: presentStory(story),
        pullRequests: [presentPullRequest(pull)],
      });
    }
    const stages = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [
        stage.key,
        items
          .filter((item) => item.stage === stage.key)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()),
      ]),
    ) as Record<PipelineStage, typeof items>;
    return {
      generatedAt: new Date(),
      counts: Object.fromEntries(
        PIPELINE_STAGES.map((stage) => [stage.key, stages[stage.key].length]),
      ),
      stages,
    };
  }
}

function place(
  story: typeof stories.$inferSelect | undefined,
  pulls: Array<typeof githubPullRequests.$inferSelect>,
  sourceState: "open" | "closed",
): { stage: PipelineStage; state: string } {
  if (
    pulls.some((pull) => pull.state === "merged") ||
    story?.status === "done" ||
    sourceState === "closed"
  ) {
    return {
      stage: "shipped",
      state: pulls.some((pull) => pull.state === "merged") ? "merged" : "closed",
    };
  }
  const openPull = pulls.find((pull) => pull.state === "open");
  if (openPull?.ciState === "failure") return { stage: "validating", state: "checks_failed" };
  if (openPull?.ciState === "pending" || (openPull && !openPull.ciState)) {
    return { stage: "validating", state: "checks_running" };
  }
  if (openPull?.ciState === "success") return { stage: "review", state: "awaiting_review" };
  if (!story) return { stage: "backlog", state: "ready" };
  if (story.status === "attention") return { stage: "building", state: "needs_attention" };
  if (story.status === "working") return { stage: "building", state: "in_progress" };
  if (story.status === "review") return { stage: "review", state: "awaiting_review" };
  return { stage: "planning", state: "ready_to_plan" };
}

function presentStory(story: typeof stories.$inferSelect | undefined) {
  return story
    ? {
        id: story.id,
        status: story.status,
        activeAgentName: story.activeAgentName,
        branch: story.branch,
      }
    : null;
}

function presentPullRequest(pull: typeof githubPullRequests.$inferSelect) {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.htmlUrl,
    state: pull.state,
    draft: pull.draft,
    ciState: pull.ciState,
    ciFailureNames: pull.ciFailureNames,
    headSha: pull.headSha,
  };
}
