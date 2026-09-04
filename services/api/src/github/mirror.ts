import { newId } from "@facility/core";
import {
  type FacilityDb,
  githubBranches,
  githubChecks,
  githubCiEvents,
  githubInstallations,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  projectRepositories,
  projects,
  stories,
  turnGitEvidence,
} from "@facility/db";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { appendStoryEvidence } from "../stories/evidence.js";
import type { StoryWorkspaceService } from "../stories/service.js";
import { FacilityGithubClient, type GithubClientFactory } from "./client.js";

const BODY_LIMIT = 64 * 1024;
const MAX_SYNC_PAGES = 10;

type JsonObject = Record<string, unknown>;
type RepositoryRow = typeof projectRepositories.$inferSelect;

export class GithubMirrorService {
  constructor(
    private readonly db: FacilityDb,
    private readonly githubFactory: GithubClientFactory,
    private readonly storiesService?: StoryWorkspaceService,
  ) {}

  async handleWebhook(input: {
    id: string;
    orgId: string;
    eventType: string;
    payload: JsonObject;
  }) {
    const repository = await this.repositoryForPayload(input.orgId, input.payload);
    if (!repository) {
      return { mirrored: 0, branches: 0, reviews: 0, checks: 0, ciUpdated: 0 };
    }
    let mirrored = 0;
    const branches = await this.applyBranchSignal(repository, input.eventType, input.payload);
    const issue = object(input.payload.issue);
    if (Object.keys(issue).length > 0 && Object.keys(object(issue.pull_request)).length === 0) {
      if (await this.upsertIssue(repository, issue)) mirrored += 1;
    }
    const pullRequest = object(input.payload.pull_request);
    if (Object.keys(pullRequest).length > 0) {
      if (await this.upsertPullRequest(repository, pullRequest)) mirrored += 1;
    }
    const review = object(input.payload.review);
    const reviews =
      Object.keys(review).length > 0
        ? await this.upsertReview(
            repository,
            review,
            positiveInteger(pullRequest.number),
            string(object(pullRequest.head).sha),
          )
        : 0;
    const checkRun = object(input.payload.check_run);
    const checks =
      Object.keys(checkRun).length > 0
        ? await this.upsertCheck(repository, checkRun, firstPullNumber(checkRun))
        : 0;
    const ciUpdated = await this.applyCiSignal(repository, input);
    return { mirrored, branches, reviews, checks, ciUpdated };
  }

  async syncProject(orgId: string, projectId: string) {
    const repositories = await this.db
      .select()
      .from(projectRepositories)
      .where(
        and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)),
      )
      .orderBy(asc(projectRepositories.owner), asc(projectRepositories.name));
    let issues = 0;
    let pullRequests = 0;
    let branches = 0;
    let reviews = 0;
    let checks = 0;
    let ciUpdates = 0;
    for (const repository of repositories) {
      if (!repository.installationId) continue;
      const installation = (
        await this.db
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.orgId, orgId),
              eq(githubInstallations.id, repository.installationId),
            ),
          )
          .limit(1)
      )[0];
      if (!installation || installation.suspendedAt) continue;
      const client = new FacilityGithubClient(
        await this.githubFactory(installation.installationId),
        {
          owner: repository.owner,
          repo: repository.name,
          defaultBranch: repository.defaultBranch,
        },
      );
      const branchScan = await paginated(client, "GET /repos/{owner}/{repo}/branches", {});
      const seenBranches: string[] = [];
      for (const branch of branchScan.rows) {
        const name = string(branch.name);
        const headSha = string(object(branch.commit).sha);
        if (!name || !headSha) continue;
        seenBranches.push(name);
        branches += await this.upsertBranch(repository, {
          name,
          headSha,
          protected: branch.protected === true,
        });
      }
      if (branchScan.complete) {
        branches += await this.markMissingBranches(repository, seenBranches);
      }
      const issueScan = await paginated(client, "GET /repos/{owner}/{repo}/issues", {
        state: "all",
        sort: "updated",
        direction: "desc",
      });
      for (const issue of issueScan.rows) {
        if (Object.keys(object(issue.pull_request)).length > 0) continue;
        if (await this.upsertIssue(repository, issue)) issues += 1;
      }
      const pullScan = await paginated(client, "GET /repos/{owner}/{repo}/pulls", {
        state: "all",
        sort: "updated",
        direction: "desc",
      });
      for (const pull of pullScan.rows) {
        if (await this.upsertPullRequest(repository, pull)) pullRequests += 1;
        const pullNumber = positiveInteger(pull.number);
        const headSha = string(object(pull.head).sha);
        if (pullNumber && (await this.linkedStory(repository, { pullNumber, headSha }))) {
          const reviewScan = await paginated(
            client,
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            { pull_number: pullNumber },
          );
          for (const review of reviewScan.rows) {
            reviews += await this.upsertReview(repository, review, pullNumber, headSha);
          }
        }
        if (headSha) {
          const refreshed = await this.refreshCi(repository, client, pull);
          ciUpdates += refreshed.ciUpdates;
          checks += refreshed.checks;
        }
      }
    }
    return {
      repositories: repositories.length,
      issues,
      branches,
      pullRequests,
      reviews,
      checks,
      ciUpdates,
    };
  }

  async syncAll() {
    const activeProjects = await this.db
      .select({ orgId: projects.orgId, projectId: projects.id })
      .from(projects)
      .where(eq(projects.status, "active"));
    const results = [];
    for (const project of activeProjects) {
      try {
        results.push({ ...project, ...(await this.syncProject(project.orgId, project.projectId)) });
      } catch (error) {
        results.push({
          ...project,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      projects: results.length,
      failed: results.filter((result) => "error" in result).length,
      results,
    };
  }

  private async repositoryForPayload(orgId: string, payload: JsonObject) {
    const repository = object(payload.repository);
    const fullName = string(repository.full_name)?.split("/") ?? [];
    const owner = string(object(repository.owner).login) ?? fullName[0];
    const name = string(repository.name) ?? fullName[1];
    if (!owner || !name) return null;
    return (
      (
        await this.db
          .select()
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.orgId, orgId),
              eq(projectRepositories.owner, owner),
              eq(projectRepositories.name, name),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  }

  private async applyBranchSignal(
    repository: RepositoryRow,
    eventType: string,
    payload: JsonObject,
  ) {
    if (eventType === "push") {
      const ref = string(payload.ref);
      const name = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
      if (!name) return 0;
      if (payload.deleted === true) return this.markBranchDeleted(repository, name);
      const headSha = string(payload.after);
      return headSha ? this.upsertBranch(repository, { name, headSha }) : 0;
    }
    if ((eventType === "create" || eventType === "delete") && payload.ref_type === "branch") {
      const name = string(payload.ref);
      if (!name) return 0;
      if (eventType === "delete") return this.markBranchDeleted(repository, name);
      const headSha = string(payload.after);
      return headSha ? this.upsertBranch(repository, { name, headSha }) : 0;
    }
    return 0;
  }

  private async upsertBranch(
    repository: RepositoryRow,
    input: { name: string; headSha: string; protected?: boolean },
  ) {
    const previous = (
      await this.db
        .select()
        .from(githubBranches)
        .where(
          and(eq(githubBranches.repositoryId, repository.id), eq(githubBranches.name, input.name)),
        )
        .limit(1)
    )[0];
    const now = new Date();
    await this.db
      .insert(githubBranches)
      .values({
        id: newId("ghb"),
        orgId: repository.orgId,
        projectId: repository.projectId,
        repositoryId: repository.id,
        name: input.name,
        headSha: input.headSha,
        protected: input.protected ?? false,
        deletedAt: null,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [githubBranches.repositoryId, githubBranches.name],
        set: {
          headSha: input.headSha,
          protected: input.protected ?? previous?.protected ?? false,
          deletedAt: null,
          syncedAt: now,
          updatedAt: now,
        },
      });
    const changed = !(
      previous?.headSha === input.headSha &&
      previous.protected === (input.protected ?? previous.protected) &&
      !previous.deletedAt
    );
    const linked = await this.linkedStory(repository, {
      branch: input.name,
      headSha: input.headSha,
    });
    if (linked) {
      await appendStoryEvidence(this.db, {
        orgId: repository.orgId,
        projectId: repository.projectId,
        storyId: linked.story.id,
        turnId: linked.turnId,
        source: "github",
        type: "github.branch_observed",
        externalKey: `branch:${repository.id}:${input.name}:${input.headSha}`,
        occurredAt: now,
        data: {
          repository: `${repository.owner}/${repository.name}`,
          branch: input.name,
          headSha: input.headSha,
          protected: input.protected ?? previous?.protected ?? false,
          actor: linked.turnId ? "facility-turn" : "external",
        },
      });
    }
    return changed ? 1 : 0;
  }

  private async markBranchDeleted(repository: RepositoryRow, name: string) {
    const previous = (
      await this.db
        .select()
        .from(githubBranches)
        .where(and(eq(githubBranches.repositoryId, repository.id), eq(githubBranches.name, name)))
        .limit(1)
    )[0];
    if (!previous || previous.deletedAt) return 0;
    const now = new Date();
    await this.db
      .update(githubBranches)
      .set({ deletedAt: now, syncedAt: now, updatedAt: now })
      .where(and(eq(githubBranches.repositoryId, repository.id), eq(githubBranches.name, name)));
    const linked = await this.linkedStory(repository, {
      branch: name,
      headSha: previous.headSha,
    });
    if (linked) {
      await appendStoryEvidence(this.db, {
        orgId: repository.orgId,
        projectId: repository.projectId,
        storyId: linked.story.id,
        turnId: linked.turnId,
        source: "github",
        type: "github.branch_deleted",
        externalKey: `branch:${repository.id}:${name}:deleted:${previous.headSha}`,
        occurredAt: now,
        data: {
          repository: `${repository.owner}/${repository.name}`,
          branch: name,
          headSha: previous.headSha,
          actor: linked.turnId ? "facility-turn" : "external",
        },
      });
    }
    return 1;
  }

  private async markMissingBranches(repository: RepositoryRow, seen: string[]) {
    const active = await this.db
      .select({ name: githubBranches.name })
      .from(githubBranches)
      .where(
        and(
          eq(githubBranches.repositoryId, repository.id),
          isNull(githubBranches.deletedAt),
          seen.length > 0 ? notInArray(githubBranches.name, seen) : undefined,
        ),
      );
    let deleted = 0;
    for (const branch of active) deleted += await this.markBranchDeleted(repository, branch.name);
    return deleted;
  }

  private async upsertIssue(repository: RepositoryRow, issue: JsonObject) {
    const number = positiveInteger(issue.number);
    const title = string(issue.title);
    const htmlUrl = string(issue.html_url);
    if (!number || !title || !htmlUrl) return null;
    const now = new Date();
    const values = {
      id: newId("iss"),
      orgId: repository.orgId,
      projectId: repository.projectId,
      repositoryId: repository.id,
      number,
      title,
      body: cappedText(issue.body),
      state: issue.state === "closed" ? "closed" : "open",
      labels: names(issue.labels),
      assignees: logins(issue.assignees),
      author: string(object(issue.user).login) ?? null,
      htmlUrl,
      commentsCount: nonNegativeInteger(issue.comments) ?? 0,
      githubCreatedAt: date(issue.created_at),
      githubUpdatedAt: date(issue.updated_at),
      closedAt: date(issue.closed_at),
      syncedAt: now,
      updatedAt: now,
    };
    return (
      (
        await this.db
          .insert(githubIssues)
          .values(values)
          .onConflictDoUpdate({
            target: [githubIssues.repositoryId, githubIssues.number],
            set: {
              title: values.title,
              body: values.body,
              state: values.state,
              labels: values.labels,
              assignees: values.assignees,
              author: values.author,
              htmlUrl: values.htmlUrl,
              commentsCount: values.commentsCount,
              githubCreatedAt: values.githubCreatedAt,
              githubUpdatedAt: values.githubUpdatedAt,
              closedAt: values.closedAt,
              syncedAt: now,
              updatedAt: now,
            },
          })
          .returning()
      )[0] ?? null
    );
  }

  private async upsertPullRequest(repository: RepositoryRow, pull: JsonObject) {
    const number = positiveInteger(pull.number);
    const title = string(pull.title);
    const htmlUrl = string(pull.html_url);
    const headRef = string(object(pull.head).ref);
    const headSha = string(object(pull.head).sha);
    const baseRef = string(object(pull.base).ref);
    if (!number || !title || !htmlUrl || !headRef || !headSha || !baseRef) return null;
    const now = new Date();
    const bodyPresent = Object.hasOwn(pull, "body");
    const mergedAt = date(pull.merged_at);
    const state =
      pull.merged === true || mergedAt ? "merged" : pull.state === "closed" ? "closed" : "open";
    const values = {
      id: newId("ghp"),
      orgId: repository.orgId,
      projectId: repository.projectId,
      repositoryId: repository.id,
      number,
      title,
      body: cappedText(pull.body),
      state,
      draft: pull.draft === true,
      author: string(object(pull.user).login) ?? null,
      headRef,
      headSha,
      baseRef,
      htmlUrl,
      closingIssues: closingIssueNumbers(cappedText(pull.body)),
      githubCreatedAt: date(pull.created_at),
      githubUpdatedAt: date(pull.updated_at),
      closedAt: date(pull.closed_at),
      mergedAt,
      syncedAt: now,
      updatedAt: now,
    };
    const saved =
      (
        await this.db
          .insert(githubPullRequests)
          .values(values)
          .onConflictDoUpdate({
            target: [githubPullRequests.repositoryId, githubPullRequests.number],
            set: {
              title: values.title,
              body: bodyPresent ? values.body : githubPullRequests.body,
              state: values.state,
              draft: values.draft,
              author: values.author,
              headRef: values.headRef,
              headSha: values.headSha,
              baseRef: values.baseRef,
              htmlUrl: values.htmlUrl,
              closingIssues: bodyPresent ? values.closingIssues : githubPullRequests.closingIssues,
              githubCreatedAt: values.githubCreatedAt,
              githubUpdatedAt: values.githubUpdatedAt,
              closedAt: values.closedAt,
              mergedAt: values.mergedAt,
              ciState: sql`case when ${githubPullRequests.headSha} = ${values.headSha} then ${githubPullRequests.ciState} else null end`,
              ciHeadSha: sql`case when ${githubPullRequests.headSha} = ${values.headSha} then ${githubPullRequests.ciHeadSha} else null end`,
              ciFailureNames: sql`case when ${githubPullRequests.headSha} = ${values.headSha} then ${githubPullRequests.ciFailureNames} else '{}'::text[] end`,
              ciUpdatedAt: sql`case when ${githubPullRequests.headSha} = ${values.headSha} then ${githubPullRequests.ciUpdatedAt} else null end`,
              syncedAt: now,
              updatedAt: now,
            },
          })
          .returning()
      )[0] ?? null;
    if (!saved) return null;
    const linked = await this.linkedStory(repository, {
      pullNumber: number,
      branch: headRef,
      headSha,
      closingIssues: values.closingIssues,
    });
    if (linked) {
      await this.associateStoryPullRequest(linked.story, {
        number,
        url: htmlUrl,
        branch: headRef,
        state,
      });
      await appendStoryEvidence(this.db, {
        orgId: repository.orgId,
        projectId: repository.projectId,
        storyId: linked.story.id,
        turnId: linked.turnId,
        source: "github",
        type: "github.pull_request_observed",
        externalKey: [
          "pull",
          repository.id,
          number,
          state,
          headSha,
          values.githubUpdatedAt?.toISOString() ?? "unknown",
        ].join(":"),
        occurredAt: values.githubUpdatedAt ?? now,
        data: {
          repository: `${repository.owner}/${repository.name}`,
          number,
          title,
          state,
          draft: values.draft,
          headRef,
          headSha,
          baseRef,
          url: htmlUrl,
          actor: linked.turnId ? "facility-turn" : "external",
        },
      });
    }
    return saved;
  }

  private async associateStoryPullRequest(
    story: typeof stories.$inferSelect,
    pull: { number: number; url: string; branch: string; state: "open" | "closed" | "merged" },
  ) {
    if (
      (story.pullRequestNumber !== null && story.pullRequestNumber !== pull.number) ||
      (story.branch !== null && story.branch !== pull.branch)
    ) {
      return;
    }
    if (this.storiesService) {
      if (pull.state === "merged") {
        if (
          story.status === "done" &&
          story.pullRequestNumber === pull.number &&
          story.pullRequestUrl === pull.url &&
          story.branch === pull.branch
        ) {
          return;
        }
        await this.storiesService.markMerged({
          orgId: story.orgId,
          projectId: story.projectId,
          storyId: story.id,
          pullRequestNumber: pull.number,
          pullRequestUrl: pull.url,
          branch: pull.branch,
        });
      } else {
        if (
          story.pullRequestNumber === pull.number &&
          story.pullRequestUrl === pull.url &&
          story.branch === pull.branch
        ) {
          return;
        }
        await this.storiesService.associatePullRequest({
          orgId: story.orgId,
          projectId: story.projectId,
          storyId: story.id,
          pullRequestNumber: pull.number,
          pullRequestUrl: pull.url,
          branch: pull.branch,
        });
      }
      return;
    }
    await this.db
      .update(stories)
      .set({
        branch: story.branch ?? pull.branch,
        pullRequestNumber: pull.number,
        pullRequestUrl: pull.url,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stories.orgId, story.orgId),
          eq(stories.projectId, story.projectId),
          eq(stories.id, story.id),
        ),
      );
  }

  private async upsertReview(
    repository: RepositoryRow,
    review: JsonObject,
    pullNumber?: number,
    pullHeadSha?: string,
  ) {
    const reviewId = scalarId(review.id);
    const state = string(review.state)?.toLowerCase();
    const number = pullNumber;
    if (!reviewId || !state || !number) return 0;
    const now = new Date();
    const submittedAt = date(review.submitted_at);
    const commitSha = string(review.commit_id) ?? pullHeadSha ?? null;
    const values = {
      id: newId("ghr"),
      orgId: repository.orgId,
      projectId: repository.projectId,
      repositoryId: repository.id,
      pullNumber: number,
      reviewId,
      state,
      author: string(object(review.user).login) ?? null,
      body: cappedText(review.body),
      htmlUrl: string(review.html_url) ?? null,
      commitSha,
      submittedAt,
      syncedAt: now,
      updatedAt: now,
    };
    await this.db
      .insert(githubPullRequestReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [githubPullRequestReviews.repositoryId, githubPullRequestReviews.reviewId],
        set: {
          pullNumber: number,
          state,
          author: values.author,
          body: values.body,
          htmlUrl: values.htmlUrl,
          commitSha,
          submittedAt,
          syncedAt: now,
          updatedAt: now,
        },
      });
    const linked = await this.linkedStory(repository, {
      pullNumber: number,
      headSha: commitSha ?? undefined,
    });
    if (!linked) return 1;
    await appendStoryEvidence(this.db, {
      orgId: repository.orgId,
      projectId: repository.projectId,
      storyId: linked.story.id,
      turnId: linked.turnId,
      source: "github",
      type: "github.review_observed",
      externalKey: `review:${repository.id}:${reviewId}:${state}:${submittedAt?.toISOString() ?? "unknown"}`,
      occurredAt: submittedAt ?? now,
      data: {
        repository: `${repository.owner}/${repository.name}`,
        pullNumber: number,
        reviewId,
        state,
        author: values.author,
        commitSha,
        url: values.htmlUrl,
        actor: "external",
      },
    });
    return 1;
  }

  private async upsertCheck(repository: RepositoryRow, check: JsonObject, pullNumber?: number) {
    const checkId = scalarId(check.id);
    const headSha = string(check.head_sha);
    const name = string(check.name);
    const status = string(check.status);
    if (!checkId || !headSha || !name || !status) return 0;
    const now = new Date();
    const completedAt = date(check.completed_at);
    const conclusion = string(check.conclusion) ?? null;
    const values = {
      id: newId("ghc"),
      orgId: repository.orgId,
      projectId: repository.projectId,
      repositoryId: repository.id,
      pullNumber,
      checkId,
      headSha,
      name: name.slice(0, 240),
      status: status.slice(0, 64),
      conclusion: conclusion?.slice(0, 64) ?? null,
      detailsUrl: string(check.details_url) ?? null,
      startedAt: date(check.started_at),
      completedAt,
      syncedAt: now,
      updatedAt: now,
    };
    await this.db
      .insert(githubChecks)
      .values(values)
      .onConflictDoUpdate({
        target: [githubChecks.repositoryId, githubChecks.checkId],
        set: {
          pullNumber,
          headSha,
          name: values.name,
          status: values.status,
          conclusion: values.conclusion,
          detailsUrl: values.detailsUrl,
          startedAt: values.startedAt,
          completedAt,
          syncedAt: now,
          updatedAt: now,
        },
      });
    const linked = await this.linkedStory(repository, { pullNumber, headSha });
    if (!linked) return 1;
    await appendStoryEvidence(this.db, {
      orgId: repository.orgId,
      projectId: repository.projectId,
      storyId: linked.story.id,
      turnId: linked.turnId,
      source: "github",
      type: "github.check_observed",
      externalKey: `check:${repository.id}:${checkId}:${status}:${conclusion ?? "none"}:${completedAt?.toISOString() ?? "active"}`,
      occurredAt: completedAt ?? values.startedAt ?? now,
      data: {
        repository: `${repository.owner}/${repository.name}`,
        pullNumber: pullNumber ?? null,
        checkId,
        headSha,
        name: values.name,
        status: values.status,
        conclusion: values.conclusion,
        url: values.detailsUrl,
        actor: linked.turnId ? "facility-turn" : "external",
      },
    });
    return 1;
  }

  private async linkedStory(
    repository: RepositoryRow,
    input: {
      pullNumber?: number;
      branch?: string;
      headSha?: string;
      closingIssues?: number[];
    },
  ): Promise<{ story: typeof stories.$inferSelect; turnId?: string } | null> {
    let branch = input.branch;
    let closingIssues = input.closingIssues ?? [];
    if (input.headSha) {
      const exactTurn = (
        await this.db
          .select({ story: stories, turnId: turnGitEvidence.turnId })
          .from(turnGitEvidence)
          .innerJoin(stories, eq(stories.id, turnGitEvidence.storyId))
          .where(
            and(
              eq(turnGitEvidence.orgId, repository.orgId),
              eq(turnGitEvidence.projectId, repository.projectId),
              eq(turnGitEvidence.finalSha, input.headSha),
              eq(stories.repositoryId, repository.id),
            ),
          )
          .orderBy(desc(turnGitEvidence.completedAt))
          .limit(1)
      )[0];
      if (exactTurn) return exactTurn;
    }
    if (input.pullNumber) {
      const byPull = (
        await this.db
          .select()
          .from(stories)
          .where(
            and(
              eq(stories.orgId, repository.orgId),
              eq(stories.projectId, repository.projectId),
              eq(stories.repositoryId, repository.id),
              eq(stories.pullRequestNumber, input.pullNumber),
            ),
          )
          .orderBy(desc(stories.updatedAt))
          .limit(1)
      )[0];
      if (byPull) return { story: byPull };
      const mirroredPull = (
        await this.db
          .select({
            headRef: githubPullRequests.headRef,
            closingIssues: githubPullRequests.closingIssues,
          })
          .from(githubPullRequests)
          .where(
            and(
              eq(githubPullRequests.repositoryId, repository.id),
              eq(githubPullRequests.number, input.pullNumber),
            ),
          )
          .limit(1)
      )[0];
      branch ??= mirroredPull?.headRef;
      if (closingIssues.length === 0) closingIssues = mirroredPull?.closingIssues ?? [];
    }
    if (branch) {
      const byBranch = (
        await this.db
          .select()
          .from(stories)
          .where(
            and(
              eq(stories.orgId, repository.orgId),
              eq(stories.projectId, repository.projectId),
              eq(stories.repositoryId, repository.id),
              eq(stories.branch, branch),
            ),
          )
          .orderBy(desc(stories.updatedAt))
          .limit(1)
      )[0];
      if (byBranch) return { story: byBranch };
    }
    for (const issueNumber of closingIssues) {
      const byIssue = (
        await this.db
          .select()
          .from(stories)
          .where(
            and(
              eq(stories.orgId, repository.orgId),
              eq(stories.projectId, repository.projectId),
              eq(stories.repositoryId, repository.id),
              eq(stories.provider, "github"),
              eq(stories.externalId, `issue:${issueNumber}`),
            ),
          )
          .orderBy(desc(stories.updatedAt))
          .limit(1)
      )[0];
      if (byIssue) return { story: byIssue };
    }
    return null;
  }

  private async applyCiSignal(
    repository: RepositoryRow,
    input: {
      id: string;
      eventType: string;
      payload: JsonObject;
    },
  ) {
    const signal = webhookCiSignal(input.eventType, input.payload);
    if (!signal) return 0;
    const pullNumbers =
      signal.pullNumbers.length > 0
        ? signal.pullNumbers
        : await this.pullNumbersForHead(repository.id, signal.headSha);
    let updated = 0;
    for (const pullNumber of pullNumbers) {
      updated += await this.recordCi(repository, {
        pullNumber,
        headSha: signal.headSha,
        state: signal.state,
        failureNames: signal.failureNames,
        sourceEventId: `${repository.id}:${input.id}:${pullNumber}:${signal.headSha}:${signal.state}`,
      });
    }
    return updated;
  }

  private async refreshCi(
    repository: RepositoryRow,
    client: FacilityGithubClient,
    pull: JsonObject,
  ) {
    const pullNumber = positiveInteger(pull.number);
    const headSha = string(object(pull.head).sha);
    if (!pullNumber || !headSha) return { ciUpdates: 0, checks: 0 };
    const [statusResponse, checkRunsResponse] = await Promise.all([
      client.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { ref: headSha }),
      client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ref: headSha,
        per_page: 100,
      }),
    ]);
    const checkRuns = array(object(checkRunsResponse).check_runs).map(object);
    let checks = 0;
    for (const check of checkRuns) checks += await this.upsertCheck(repository, check, pullNumber);
    const signal = restCiSignal(statusResponse, checkRunsResponse);
    if (!signal) return { ciUpdates: 0, checks };
    const ciUpdates = await this.recordCi(repository, {
      pullNumber,
      headSha,
      state: signal.state,
      failureNames: signal.failureNames,
    });
    return { ciUpdates, checks };
  }

  private async recordCi(
    repository: RepositoryRow,
    input: {
      pullNumber: number;
      headSha: string;
      state: "pending" | "success" | "failure";
      failureNames: string[];
      sourceEventId?: string;
    },
  ) {
    const previous = (
      await this.db
        .select({
          currentHeadSha: githubPullRequests.headSha,
          ciHeadSha: githubPullRequests.ciHeadSha,
          state: githubPullRequests.ciState,
          failureNames: githubPullRequests.ciFailureNames,
        })
        .from(githubPullRequests)
        .where(
          and(
            eq(githubPullRequests.repositoryId, repository.id),
            eq(githubPullRequests.number, input.pullNumber),
          ),
        )
        .limit(1)
    )[0];
    if (!previous) return 0;
    if (previous.currentHeadSha !== input.headSha) return 0;
    const failureNames = sanitizedNames(input.failureNames);
    const now = new Date();
    await this.db
      .update(githubPullRequests)
      .set({
        ciState: input.state,
        ciHeadSha: input.headSha,
        ciFailureNames: failureNames,
        ciUpdatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPullRequests.repositoryId, repository.id),
          eq(githubPullRequests.number, input.pullNumber),
          eq(githubPullRequests.headSha, input.headSha),
        ),
      );
    if (
      previous.ciHeadSha === input.headSha &&
      previous.state === input.state &&
      sameStrings(previous.failureNames, failureNames)
    ) {
      return 1;
    }
    await this.db
      .insert(githubCiEvents)
      .values({
        id: newId("cie"),
        orgId: repository.orgId,
        projectId: repository.projectId,
        repositoryId: repository.id,
        pullNumber: input.pullNumber,
        headSha: input.headSha,
        state: input.state,
        failureNames,
        sourceEventId: input.sourceEventId,
        observedAt: now,
      })
      .onConflictDoNothing();
    return 1;
  }

  private async pullNumbersForHead(repositoryId: string, headSha: string) {
    return this.db
      .select({ number: githubPullRequests.number })
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.repositoryId, repositoryId),
          eq(githubPullRequests.headSha, headSha),
          eq(githubPullRequests.state, "open"),
        ),
      )
      .then((rows) => rows.map((row) => row.number));
  }
}

async function paginated(
  client: FacilityGithubClient,
  route: string,
  query: Record<string, unknown>,
) {
  const rows: JsonObject[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_SYNC_PAGES; page += 1) {
    const result = array(await client.request(route, { ...query, per_page: 100, page }));
    rows.push(...result.map(object));
    if (result.length < 100) {
      complete = true;
      break;
    }
  }
  return { rows, complete };
}

export function webhookCiSignal(
  eventType: string,
  payload: JsonObject,
): {
  headSha: string;
  state: "pending" | "success" | "failure";
  pullNumbers: number[];
  failureNames: string[];
} | null {
  const source =
    eventType === "workflow_run"
      ? object(payload.workflow_run)
      : eventType === "check_suite"
        ? object(payload.check_suite)
        : eventType === "check_run"
          ? object(payload.check_run)
          : null;
  if (!source) return null;
  const headSha = string(source.head_sha);
  if (!headSha) return null;
  const state: "pending" | "success" | "failure" | null =
    source.status !== "completed" ? "pending" : conclusionState(source.conclusion);
  if (!state) return null;
  const pullNumbers = array(source.pull_requests)
    .map((pull) => positiveInteger(object(pull).number))
    .filter((number): number is number => number !== undefined);
  const name = string(source.name);
  return {
    headSha,
    state,
    pullNumbers,
    failureNames: state === "failure" && name ? [name] : [],
  };
}

export function restCiSignal(
  commitStatus: unknown,
  checkRunsResponse: unknown,
): { state: "pending" | "success" | "failure"; failureNames: string[] } | null {
  const status = object(commitStatus);
  const statuses = array(status.statuses).map(object);
  const checkRuns = array(object(checkRunsResponse).check_runs).map(object);
  const combinedState = ciState(status.state);
  if (!combinedState && statuses.length === 0 && checkRuns.length === 0) return null;

  const failedStatusNames = statuses.flatMap((item) => {
    if (!["failure", "error"].includes(String(item.state))) return [];
    const name = string(item.context);
    return name ? [name] : [];
  });
  const failedCheckNames = checkRuns.flatMap((item) => {
    if (conclusionState(item.conclusion) !== "failure") return [];
    const name = string(item.name);
    return name ? [name] : [];
  });
  const failureNames = sanitizedNames([...failedStatusNames, ...failedCheckNames]);
  if (combinedState === "failure" || failureNames.length > 0) {
    return { state: "failure", failureNames };
  }
  if (combinedState === "pending" || checkRuns.some((check) => check.status !== "completed")) {
    return { state: "pending", failureNames: [] };
  }
  return { state: "success", failureNames: [] };
}

function conclusionState(value: unknown): "success" | "failure" | null {
  if (["success", "neutral", "skipped"].includes(String(value))) return "success";
  if (["failure", "timed_out", "cancelled", "action_required", "stale"].includes(String(value))) {
    return "failure";
  }
  return null;
}

function ciState(value: unknown): "pending" | "success" | "failure" | null {
  if (value === "pending") return "pending";
  if (value === "success") return "success";
  if (value === "failure" || value === "error") return "failure";
  return null;
}

function closingIssueNumbers(body: string | null) {
  if (!body) return [];
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isSafeInteger(number) && number > 0);
}

function names(value: unknown) {
  return sanitizedNames(
    array(value).flatMap((item) => {
      const name = typeof item === "string" ? item : string(object(item).name);
      return name ? [name] : [];
    }),
  );
}

function logins(value: unknown) {
  return sanitizedNames(
    array(value).flatMap((item) => {
      const login = string(object(item).login);
      return login ? [login] : [];
    }),
  );
}

function sanitizedNames(values: string[]) {
  return [
    ...new Set(values.map((value) => value.replace(/[\r\n\t]+/g, " ").trim()).filter(Boolean)),
  ]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100)
    .map((value) => value.slice(0, 160));
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cappedText(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, BODY_LIMIT);
}

function date(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function scalarId(value: unknown) {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined;
}

function firstPullNumber(value: JsonObject) {
  return array(value.pull_requests)
    .map((pull) => positiveInteger(object(pull).number))
    .find((number) => number !== undefined);
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
