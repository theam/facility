import type { ReplaceStoryDelivery, StoryDelivery } from "@facility/core";
import {
  type FacilityDb,
  githubPullRequestReviews,
  githubPullRequests,
  projectRepositories,
  stories,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
} from "@facility/db";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { MIRROR_STALE_AFTER_MS } from "./backlog.js";
import {
  type DeliveryLink,
  deliveryCandidate,
  deliveryPullProjection,
} from "./delivery-projection.js";
import { appendStoryEvidence } from "./evidence.js";

type Scope = { orgId: string; projectId: string; storyId: string };
type Actor = { type: "user" | "service"; id: string };
type ReadOptions = {
  includeAvailable?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  now?: Date;
};
const linkIdentity = (repositoryId: string, number: number) => `${repositoryId}:${number}`;

/** A consistent read of the register and mirror. No runtime, queue, secrets or GitHub client. */
export async function readStoryDelivery(
  db: FacilityDb,
  scope: Scope,
  options: ReadOptions = {},
): Promise<StoryDelivery> {
  return db.transaction((tx) => readSnapshot(tx as unknown as FacilityDb, scope, options), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function replaceStoryDelivery(
  db: FacilityDb,
  scope: Scope,
  body: ReplaceStoryDelivery,
  actor: Actor,
): Promise<StoryDelivery> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    // Same topology lock as repository connect/disconnect, followed by the story lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
    );
    const [story] = await tx
      .select({ id: stories.id })
      .from(stories)
      .where(storyWhere(scope))
      .for("update")
      .limit(1);
    if (!story) throw new ApiError(404, "not_found", "Story not found");
    const [previous] = await tx
      .select()
      .from(storyDeliveryScopes)
      .where(scopeWhere(scope))
      .limit(1);
    const revision = previous?.revision ?? 0;
    if (body.expected_revision !== revision)
      throw new ApiError(
        409,
        "delivery_revision_conflict",
        "The delivery set changed. Reload it before saving your edits.",
      );
    const names = body.pull_requests.map((pull) => pull.repository.toLowerCase());
    const repositories = names.length
      ? await tx
          .select()
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.orgId, scope.orgId),
              eq(projectRepositories.projectId, scope.projectId),
              inArray(
                sql<string>`lower(${projectRepositories.owner} || '/' || ${projectRepositories.name})`,
                names,
              ),
            ),
          )
      : [];
    const byName = new Map(
      repositories.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), repo]),
    );
    const links = body.pull_requests.map((pull) => {
      const repo = byName.get(pull.repository.toLowerCase());
      if (!repo)
        throw new ApiError(
          404,
          "delivery_repository_not_found",
          "A selected repository is not connected to this project",
        );
      return {
        repositoryId: repo.id,
        pullNumber: pull.number,
        required: pull.required,
        isPrimary: pull.primary,
      };
    });
    if (
      new Set(links.map((link) => linkIdentity(link.repositoryId, link.pullNumber))).size !==
      links.length
    )
      throw new ApiError(
        400,
        "delivery_duplicate_pull_request",
        "A pull request can appear only once",
      );
    const observed = links.length
      ? await tx
          .select({
            repositoryId: githubPullRequests.repositoryId,
            number: githubPullRequests.number,
          })
          .from(githubPullRequests)
          .where(
            and(
              eq(githubPullRequests.orgId, scope.orgId),
              eq(githubPullRequests.projectId, scope.projectId),
              or(
                ...links.map((link) =>
                  and(
                    eq(githubPullRequests.repositoryId, link.repositoryId),
                    eq(githubPullRequests.number, link.pullNumber),
                  ),
                ),
              ),
            ),
          )
      : [];
    const observedIds = new Set(
      observed.map((pull) => linkIdentity(pull.repositoryId, pull.number)),
    );
    if (links.some((link) => !observedIds.has(linkIdentity(link.repositoryId, link.pullNumber))))
      throw new ApiError(
        404,
        "delivery_pull_request_unobserved",
        "A selected pull request is not in this project's GitHub mirror. Synchronize GitHub before retrying.",
      );
    const oldLinks = await tx
      .select({
        repositoryId: storyDeliveryPullRequests.repositoryId,
        pullNumber: storyDeliveryPullRequests.pullNumber,
        required: storyDeliveryPullRequests.required,
        isPrimary: storyDeliveryPullRequests.isPrimary,
      })
      .from(storyDeliveryPullRequests)
      .where(linkWhere(scope))
      .limit(51);
    if (
      previous &&
      previous.declaredComplete === body.declared_complete &&
      canonicalLinks(oldLinks) === canonicalLinks(links)
    )
      return readSnapshot(tx, scope, {});
    await tx
      .insert(storyDeliveryScopes)
      .values({
        ...scope,
        revision: revision + 1,
        declaredComplete: body.declared_complete,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: storyDeliveryScopes.storyId,
        set: {
          revision: revision + 1,
          declaredComplete: body.declared_complete,
          updatedBy: actor,
          updatedAt: new Date(),
        },
      });
    await tx.delete(storyDeliveryPullRequests).where(linkWhere(scope));
    if (links.length)
      await tx
        .insert(storyDeliveryPullRequests)
        .values(links.map((link) => ({ ...scope, ...link })));
    await appendStoryEvidence(tx, {
      ...scope,
      source: "facility",
      type: "delivery.scope_updated",
      externalKey: `delivery:scope:${revision + 1}`,
      data: {
        revision: revision + 1,
        declared_complete: body.declared_complete,
        pull_requests: JSON.parse(canonicalLinks(links)),
        actor,
      },
    });
    return readSnapshot(tx, scope, {});
  });
}

async function readSnapshot(
  db: FacilityDb,
  scope: Scope,
  options: ReadOptions,
): Promise<StoryDelivery> {
  const now = options.now ?? new Date();
  const [story] = await db
    .select({
      repositoryId: stories.repositoryId,
      number: stories.pullRequestNumber,
      url: stories.pullRequestUrl,
    })
    .from(stories)
    .where(storyWhere(scope))
    .limit(1);
  if (!story) throw new ApiError(404, "not_found", "Story not found");
  const [declaration] = await db
    .select()
    .from(storyDeliveryScopes)
    .where(scopeWhere(scope))
    .limit(1);
  const stored = await db
    .select({
      link: storyDeliveryPullRequests,
      repository: {
        id: projectRepositories.id,
        owner: projectRepositories.owner,
        name: projectRepositories.name,
      },
      pull: githubPullRequests,
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
    .leftJoin(
      githubPullRequests,
      and(
        eq(githubPullRequests.orgId, scope.orgId),
        eq(githubPullRequests.projectId, scope.projectId),
        eq(githubPullRequests.repositoryId, storyDeliveryPullRequests.repositoryId),
        eq(githubPullRequests.number, storyDeliveryPullRequests.pullNumber),
      ),
    )
    .where(linkWhere(scope))
    .orderBy(
      asc(projectRepositories.owner),
      asc(projectRepositories.name),
      asc(storyDeliveryPullRequests.pullNumber),
    )
    .limit(51);
  if (stored.length > 50)
    throw new ApiError(
      409,
      "delivery_scope_limit_exceeded",
      "The stored delivery set exceeds 50 PRs. Resolve its scope before evaluating delivery.",
    );
  const entries: Array<{
    link: DeliveryLink;
    pull: typeof githubPullRequests.$inferSelect | null;
  }> = stored.map((row) => ({
    link: {
      repositoryId: row.link.repositoryId,
      repository: `${row.repository.owner}/${row.repository.name}`,
      number: row.link.pullNumber,
      required: row.link.required,
      primary: row.link.isPrimary,
      origin: "registered",
    },
    pull: row.pull,
  }));
  if (!declaration && !entries.length && story.repositoryId && story.number !== null) {
    const [legacy] = await db
      .select({ repository: projectRepositories, pull: githubPullRequests })
      .from(projectRepositories)
      .leftJoin(
        githubPullRequests,
        and(
          eq(githubPullRequests.orgId, scope.orgId),
          eq(githubPullRequests.projectId, scope.projectId),
          eq(githubPullRequests.repositoryId, projectRepositories.id),
          eq(githubPullRequests.number, story.number),
        ),
      )
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.id, story.repositoryId),
        ),
      )
      .limit(1);
    if (legacy)
      entries.push({
        link: {
          repositoryId: legacy.repository.id,
          repository: `${legacy.repository.owner}/${legacy.repository.name}`,
          number: story.number,
          required: true,
          primary: true,
          origin: "legacy",
        },
        pull: legacy.pull,
      });
  }
  const pulls: StoryDelivery["pullRequests"] = [];
  for (const entry of entries) {
    const reviews = await db
      .select({
        reviewId: githubPullRequestReviews.reviewId,
        author: githubPullRequestReviews.author,
        state: githubPullRequestReviews.state,
        commitSha: githubPullRequestReviews.commitSha,
        submittedAt: githubPullRequestReviews.submittedAt,
        htmlUrl: githubPullRequestReviews.htmlUrl,
      })
      .from(githubPullRequestReviews)
      .where(
        and(
          eq(githubPullRequestReviews.orgId, scope.orgId),
          eq(githubPullRequestReviews.projectId, scope.projectId),
          eq(githubPullRequestReviews.repositoryId, entry.link.repositoryId),
          eq(githubPullRequestReviews.pullNumber, entry.link.number),
        ),
      )
      .orderBy(
        desc(githubPullRequestReviews.submittedAt),
        desc(githubPullRequestReviews.updatedAt),
        desc(githubPullRequestReviews.reviewId),
      )
      .limit(101);
    const pull = deliveryPullProjection(
      entry.link,
      entry.pull,
      reviews.slice(0, 100),
      reviews.length > 100,
      now,
    );
    if (!entry.pull && entry.link.origin === "legacy") pull.url = story.url;
    pulls.push(pull);
  }
  const declared: StoryDelivery["scope"] = {
    revision: declaration?.revision ?? 0,
    declaredComplete: declaration?.declaredComplete ?? false,
    origin: declaration ? "registered" : "legacy",
    updatedAt: declaration?.updatedAt.toISOString() ?? null,
    updatedBy: declaration?.updatedBy ?? null,
  };
  return {
    schemaVersion: 1,
    ...scope,
    generatedAt: now.toISOString(),
    scope: declared,
    pullRequests: pulls,
    candidate: deliveryCandidate(declared, pulls),
    available: options.includeAvailable ? await availablePulls(db, scope, options, now) : null,
  };
}

async function availablePulls(
  db: FacilityDb,
  scope: Scope,
  options: ReadOptions,
  now: Date,
): Promise<NonNullable<StoryDelivery["available"]>> {
  const limit = options.limit ?? 25,
    offset = options.offset ?? 0;
  const pattern = options.q ? `%${options.q.replace(/[\\%_]/g, "\\$&")}%` : undefined;
  const rows = await db
    .select({
      repositoryId: projectRepositories.id,
      owner: projectRepositories.owner,
      name: projectRepositories.name,
      pull: githubPullRequests,
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
        eq(githubPullRequests.orgId, scope.orgId),
        eq(githubPullRequests.projectId, scope.projectId),
        pattern
          ? or(
              ilike(githubPullRequests.title, pattern),
              ilike(
                sql<string>`${projectRepositories.owner} || '/' || ${projectRepositories.name}`,
                pattern,
              ),
              ilike(sql<string>`${githubPullRequests.number}::text`, pattern),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(githubPullRequests.githubUpdatedAt),
      asc(githubPullRequests.repositoryId),
      desc(githubPullRequests.number),
    )
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, limit).map((row) => ({
      repositoryId: row.repositoryId,
      repository: `${row.owner}/${row.name}`,
      number: row.pull.number,
      title: row.pull.title,
      url: row.pull.htmlUrl,
      headSha: row.pull.headSha,
      state: row.pull.state as "open" | "closed" | "merged",
      draft: row.pull.draft,
      stale: now.getTime() - row.pull.syncedAt.getTime() > MIRROR_STALE_AFTER_MS,
    })),
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

function storyWhere(scope: Scope) {
  return and(
    eq(stories.orgId, scope.orgId),
    eq(stories.projectId, scope.projectId),
    eq(stories.id, scope.storyId),
  );
}
function scopeWhere(scope: Scope) {
  return and(
    eq(storyDeliveryScopes.orgId, scope.orgId),
    eq(storyDeliveryScopes.projectId, scope.projectId),
    eq(storyDeliveryScopes.storyId, scope.storyId),
  );
}
function linkWhere(scope: Scope) {
  return and(
    eq(storyDeliveryPullRequests.orgId, scope.orgId),
    eq(storyDeliveryPullRequests.projectId, scope.projectId),
    eq(storyDeliveryPullRequests.storyId, scope.storyId),
  );
}
function canonicalLinks(
  links: Array<{ repositoryId: string; pullNumber: number; required: boolean; isPrimary: boolean }>,
) {
  return JSON.stringify(
    [...links]
      .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.pullNumber - b.pullNumber)
      .map((link) => ({
        repositoryId: link.repositoryId,
        number: link.pullNumber,
        required: link.required,
        primary: link.isPrimary,
      })),
  );
}
