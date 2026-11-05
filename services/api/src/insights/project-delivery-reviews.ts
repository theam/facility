import type { StoryDelivery, StoryWorkflowPolicyState } from "@facility/core";
import {
  type FacilityDb,
  githubPullRequests,
  projectRepositories,
  projects,
  stories,
  storyDeliveryAcceptances,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyPlanDecisions,
  storyPlanRevisions,
  storyPlanStates,
  storyPreviewConvergences,
} from "@facility/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { observeUserAuthorities } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import {
  acceptanceSnapshot,
  sameAcceptedCandidate,
} from "../stories/delivery-acceptance-snapshot.js";
import {
  type DeliveryLink,
  deliveryCandidate,
  deliveryPullProjection,
  type MirroredDeliveryPull,
} from "../stories/delivery-projection.js";
import { planState } from "../stories/plan-state.js";
import { workflowPolicyFromSettings } from "../stories/workflow-policy.js";

type Scope = { orgId: string; projectId: string };
type ScopedTable =
  | typeof storyDeliveryScopes
  | typeof storyDeliveryPullRequests
  | typeof storyPlanStates
  | typeof storyDeliveryAcceptances
  | typeof storyPreviewConvergences
  | typeof githubPullRequests;
const within = (table: ScopedTable, scope: Scope) =>
  and(eq(table.orgId, scope.orgId), eq(table.projectId, scope.projectId));

/** Bulk metadata read inside the caller's snapshot. No Markdown, per-story
 * queries, GitHub calls, model calls or confirmation requests. */
export async function readProjectDeliveryReviews(db: FacilityDb, scope: Scope, now: Date) {
  const [
    projectRows,
    storyRows,
    declarations,
    links,
    mirrors,
    planRows,
    receipts,
    previews,
    repositories,
  ] = await Promise.all([
    db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId))),
    db
      .select({
        id: stories.id,
        status: stories.status,
        repositoryId: stories.repositoryId,
        number: stories.pullRequestNumber,
        url: stories.pullRequestUrl,
        updatedAt: stories.updatedAt,
      })
      .from(stories)
      .where(
        and(
          eq(stories.orgId, scope.orgId),
          eq(stories.projectId, scope.projectId),
          isNull(stories.deletedAt),
        ),
      ),
    db.select().from(storyDeliveryScopes).where(within(storyDeliveryScopes, scope)),
    db
      .select({
        link: storyDeliveryPullRequests,
        repository: {
          id: projectRepositories.id,
          owner: projectRepositories.owner,
          name: projectRepositories.name,
        },
      })
      .from(storyDeliveryPullRequests)
      .innerJoin(
        projectRepositories,
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.id, storyDeliveryPullRequests.repositoryId),
        ),
      )
      .where(within(storyDeliveryPullRequests, scope)),
    db
      .select({
        pull: {
          title: githubPullRequests.title,
          htmlUrl: githubPullRequests.htmlUrl,
          state: githubPullRequests.state,
          draft: githubPullRequests.draft,
          headSha: githubPullRequests.headSha,
          headRef: githubPullRequests.headRef,
          baseRef: githubPullRequests.baseRef,
          syncedAt: githubPullRequests.syncedAt,
          ciState: githubPullRequests.ciState,
          ciHeadSha: githubPullRequests.ciHeadSha,
          ciUpdatedAt: githubPullRequests.ciUpdatedAt,
          repositoryId: githubPullRequests.repositoryId,
          number: githubPullRequests.number,
        },
        repository: {
          id: projectRepositories.id,
          owner: projectRepositories.owner,
          name: projectRepositories.name,
        },
      })
      .from(githubPullRequests)
      .innerJoin(
        projectRepositories,
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.id, githubPullRequests.repositoryId),
        ),
      )
      .where(
        and(
          within(githubPullRequests, scope),
          sql`(
      exists (select 1 from story_delivery_pull_requests l where l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}
        and l.repository_id = ${githubPullRequests.repositoryId} and l.pull_number = ${githubPullRequests.number})
      or exists (select 1 from stories s where s.org_id = ${scope.orgId} and s.project_id = ${scope.projectId}
        and s.deleted_at is null and s.repository_id = ${githubPullRequests.repositoryId} and s.pull_request_number = ${githubPullRequests.number})
    )`,
        ),
      ),
    db
      .select({
        state: {
          storyId: storyPlanStates.storyId,
          revision: storyPlanStates.revision,
          decisionRevision: storyPlanStates.decisionRevision,
        },
        digest: storyPlanRevisions.digest,
        decision: {
          planRevision: storyPlanDecisions.planRevision,
          intent: storyPlanDecisions.intent,
        },
      })
      .from(storyPlanStates)
      .innerJoin(
        storyPlanRevisions,
        and(
          eq(storyPlanRevisions.orgId, storyPlanStates.orgId),
          eq(storyPlanRevisions.projectId, storyPlanStates.projectId),
          eq(storyPlanRevisions.storyId, storyPlanStates.storyId),
          eq(storyPlanRevisions.revision, storyPlanStates.revision),
        ),
      )
      .leftJoin(
        storyPlanDecisions,
        and(
          eq(storyPlanDecisions.orgId, storyPlanStates.orgId),
          eq(storyPlanDecisions.projectId, storyPlanStates.projectId),
          eq(storyPlanDecisions.storyId, storyPlanStates.storyId),
          eq(storyPlanDecisions.decisionRevision, storyPlanStates.decisionRevision),
        ),
      )
      .where(within(storyPlanStates, scope)),
    db
      .selectDistinctOn([storyDeliveryAcceptances.storyId])
      .from(storyDeliveryAcceptances)
      .where(within(storyDeliveryAcceptances, scope))
      .orderBy(storyDeliveryAcceptances.storyId, desc(storyDeliveryAcceptances.revision)),
    db
      .select({
        storyId: storyPreviewConvergences.storyId,
        state: storyPreviewConvergences.state,
        desiredGeneration: storyPreviewConvergences.desiredGeneration,
        deployedGeneration: storyPreviewConvergences.deployedGeneration,
        observedAt: storyPreviewConvergences.updatedAt,
      })
      .from(storyPreviewConvergences)
      .where(within(storyPreviewConvergences, scope)),
    db
      .select({
        id: projectRepositories.id,
        owner: projectRepositories.owner,
        name: projectRepositories.name,
      })
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
        ),
      ),
  ]);
  let policy: StoryWorkflowPolicyState | null = null;
  let policyError: string | null = null;
  try {
    policy = workflowPolicyFromSettings(projectRows[0]?.settings);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    policyError = error.message;
  }
  const authorities = await observeUserAuthorities(
    db,
    scope.orgId,
    [...new Set(receipts.map((receipt) => receipt.confirmedBy.id))],
    ["projects:write"],
  );
  const declarationByStory = new Map(declarations.map((row) => [row.storyId, row]));
  const planByStory = new Map(planRows.map((row) => [row.state.storyId, row]));
  const receiptByStory = new Map(receipts.map((row) => [row.storyId, row]));
  const previewByStory = new Map(previews.map((row) => [row.storyId, row]));
  const repositoryById = new Map(repositories.map((row) => [row.id, row]));
  const mirrorByRef = new Map(
    mirrors.map((row) => [`${row.pull.repositoryId}:${row.pull.number}`, row]),
  );
  const linksByStory = new Map<string, typeof links>();
  for (const row of links) {
    const entries = linksByStory.get(row.link.storyId) ?? [];
    entries.push(row);
    linksByStory.set(row.link.storyId, entries);
  }
  const results = new Map<string, ProjectDeliveryReview>();
  for (const story of storyRows) {
    const declaration = declarationByStory.get(story.id);
    const stored = linksByStory.get(story.id) ?? [];
    const entries: Array<{ link: DeliveryLink; pull: MirroredDeliveryPull | null }> = stored.map(
      ({ link, repository }) => ({
        link: {
          repositoryId: link.repositoryId,
          repository: `${repository.owner}/${repository.name}`,
          number: link.pullNumber,
          required: link.required,
          primary: link.isPrimary,
          origin: "registered",
        },
        pull: mirrorByRef.get(`${link.repositoryId}:${link.pullNumber}`)?.pull ?? null,
      }),
    );
    if (!declaration && !stored.length && story.repositoryId && story.number !== null) {
      const legacy = mirrorByRef.get(`${story.repositoryId}:${story.number}`);
      const repository = repositoryById.get(story.repositoryId);
      if (repository)
        entries.push({
          link: {
            repositoryId: story.repositoryId,
            repository: `${repository.owner}/${repository.name}`,
            number: story.number,
            required: true,
            primary: true,
            origin: "legacy",
          },
          pull: legacy?.pull ?? null,
        });
    }
    if (!declaration && !entries.length) continue;
    const declared: StoryDelivery["scope"] = {
      revision: declaration?.revision ?? 0,
      declaredComplete: declaration?.declaredComplete ?? false,
      origin: declaration ? "registered" : "legacy",
      updatedAt: declaration?.updatedAt.toISOString() ?? null,
      updatedBy: declaration?.updatedBy ?? null,
    };
    const pulls = entries.map(({ link, pull }) => {
      const projected = deliveryPullProjection(link, pull, [], false, now);
      if (!pull && link.origin === "legacy") projected.url = story.url;
      return projected;
    });
    const candidate = deliveryCandidate(declared, pulls);
    const plan = planByStory.get(story.id);
    const receipt = receiptByStory.get(story.id);
    const preview = previewByStory.get(story.id) ?? null;
    const observation = policy
      ? {
          policy,
          delivery: { scope: declared, candidate, pullRequests: pulls },
          plan: {
            state: planState(plan?.state, plan?.decision ?? undefined),
            digest: plan?.digest ?? null,
          },
          preview,
        }
      : null;
    let current = false;
    if (receipt && observation && stored.length <= 50) {
      try {
        current =
          authorities.has(receipt.confirmedBy.id) &&
          sameAcceptedCandidate(
            acceptanceSnapshot(observation, receipt.snapshot.acceptanceRevision, false),
            receipt.snapshot,
          );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }
    let blocked: { code: string; message: string } | null = policyError
      ? { code: "workflow_policy_invalid", message: policyError }
      : null;
    if (stored.length > 50)
      blocked = {
        code: "delivery_scope_limit_exceeded",
        message: "The delivery set exceeds 50 PRs. Resolve its scope before evaluating delivery.",
      };
    if (observation && !blocked) {
      try {
        acceptanceSnapshot(observation, receipt?.revision ?? 0, true);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        blocked = { code: error.code, message: error.message };
      }
    }
    const required = policy?.policy.requireDeliveryAcceptance ?? null;
    const status = receipt
      ? current
        ? ("current" as const)
        : ("stale" as const)
      : ("missing" as const);
    const review = {
      candidate,
      scopeRevision: declared.revision,
      storyStatus: story.status,
      pullRequests: pulls.map(
        ({
          repository,
          number,
          url,
          title,
          required,
          primary,
          state,
          draft,
          headSha,
          stale,
          checks,
        }) => ({
          repository,
          number,
          url,
          title,
          required,
          primary,
          state,
          draft,
          headSha,
          stale,
          checks,
        }),
      ),
      acceptance: {
        required,
        status,
        receipt: receipt
          ? {
              id: receipt.id,
              revision: receipt.revision,
              candidateRevision: receipt.snapshot.candidateRevision,
              confirmedAt: receipt.confirmedAt,
              confirmedBy: receipt.confirmedBy,
            }
          : null,
      },
      preview: preview
        ? {
            state: preview.state,
            desiredGeneration: preview.desiredGeneration,
            deployedGeneration: preview.deployedGeneration,
            observedAt: preview.observedAt,
          }
        : null,
      acceptanceReady: Boolean(observation && !blocked && !current),
      blocked,
      waitingSince: declaration?.updatedAt ?? story.updatedAt,
    };
    results.set(story.id, review);
  }
  return { stories: results, policyError };
}

export type ProjectDeliveryReview = {
  candidate: StoryDelivery["candidate"];
  scopeRevision: number;
  storyStatus: string;
  pullRequests: Array<
    Pick<
      StoryDelivery["pullRequests"][number],
      | "repository"
      | "number"
      | "url"
      | "title"
      | "required"
      | "primary"
      | "state"
      | "draft"
      | "headSha"
      | "stale"
      | "checks"
    >
  >;
  acceptance: {
    required: boolean | null;
    status: "missing" | "current" | "stale";
    receipt: {
      id: string;
      revision: number;
      candidateRevision: string;
      confirmedAt: Date;
      confirmedBy: { type: "user"; id: string; name: string | null };
    } | null;
  };
  preview: {
    state: string;
    desiredGeneration: string;
    deployedGeneration: string | null;
    observedAt: Date;
  } | null;
  acceptanceReady: boolean;
  blocked: { code: string; message: string } | null;
  waitingSince: Date;
};
