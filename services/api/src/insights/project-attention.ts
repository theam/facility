import { readDecisionBrief } from "@facility/core";
import { attentionItems, type FacilityDb, stories, storyPlanRevisions } from "@facility/db";
import { and, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { CostBudgetService } from "./costs.js";
import { deliveryNeedsReview, readProjectDeliveryReviews } from "./project-delivery-reviews.js";
import { attentionAction, type StoryStatus } from "./project-overview.js";

// Every notice a project raised for a person: an agent waiting for a reply, a
// failed or interrupted run, a turn that could not start. The overview shows
// the latest few; this is the complete, searchable list behind it. Like the
// overview it reads persisted control-plane state only.

export const ATTENTION_STATUSES = ["open", "resolved", "all"] as const;
export type AttentionStatusFilter = (typeof ATTENTION_STATUSES)[number];

export type AttentionQuery = {
  status: AttentionStatusFilter;
  kind?: string[];
  q?: string;
  limit: number;
  offset: number;
};

// Details are error excerpts or agent questions; the full text stays on the story.
const DETAIL_EXCERPT = 1_000;

export type AttentionStoriesQuery = {
  category: "all" | "plans" | "notices" | "deliveries" | "pulls";
  q?: string;
  limit: number;
  offset: number;
  pullOffset?: number;
};

type AttentionStoryRow = {
  storyId: string;
  storyTitle: string;
  storyStatus: StoryStatus;
  waitingSince: string;
  noticeCount: number;
  planRevision: number | null;
  hasDelivery: boolean;
};

export class ProjectAttentionService {
  constructor(private readonly db: FacilityDb) {}

  /** Pages contain whole stories, not a grouping of a truncated notice page.
   * Counts and revision details share a read-only snapshot. This projection
   * does not classify urgency or decide who may approve a particular plan.
   */
  async listStories(
    orgId: string,
    projectId: string,
    query: AttentionStoriesQuery,
    now = new Date(),
    access = { budgets: false },
  ) {
    const pattern = `%${(query.q?.trim() ?? "").replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db.transaction(
      async (rawTx) => {
        const tx = rawTx;
        const scopedDb = rawTx as unknown as FacilityDb;
        const [deliverySnapshot, budget] = await Promise.all([
          readProjectDeliveryReviews(scopedDb, { orgId, projectId }, now),
          access.budgets
            ? new CostBudgetService(scopedDb).budgetState(orgId, projectId, now)
            : null,
        ]);
        const deliveries = new Map(
          [...deliverySnapshot.stories].filter(([, review]) => deliveryNeedsReview(review)),
        );
        const pullSearch = query.q?.trim().toLowerCase() ?? "";
        const otherPulls =
          query.category === "all" || query.category === "pulls"
            ? deliverySnapshot.otherPullRequests.filter((pull) =>
                [
                  pull.title,
                  pull.repository,
                  `#${pull.number}`,
                  ...pull.stories.map((story) => story.title),
                ].some((text) => text.toLowerCase().includes(pullSearch)),
              )
            : [];
        const deliveryRows = [...deliveries].map(([storyId, review]) => ({
          story_id: storyId,
          waiting_since: review.waitingSince.toISOString(),
          search_text: review.pullRequests
            .map((pull) => `${pull.repository} #${pull.number} ${pull.title ?? ""}`)
            .join("\n"),
        }));
        const candidates = sql`
      with delivery_groups as (
        select * from jsonb_to_recordset(${JSON.stringify(deliveryRows)}::jsonb)
          as r(story_id text, waiting_since timestamptz, search_text text)
      ), notice_groups as (
        select story_id, count(*)::int as notice_count, min(created_at) as waiting_since
        from attention_items
        where org_id = ${orgId} and project_id = ${projectId} and status = 'open'
        group by story_id
      ), pending_plans as (
        select p.story_id, p.revision, p.proposed_at
        from story_plan_states s
        join story_plan_revisions p on p.org_id = s.org_id and p.project_id = s.project_id
          and p.story_id = s.story_id and p.revision = s.revision
        left join story_plan_decisions d on d.org_id = s.org_id and d.project_id = s.project_id
          and d.story_id = s.story_id and d.decision_revision = s.decision_revision
        where s.org_id = ${orgId} and s.project_id = ${projectId}
          and (d.plan_revision is null or d.plan_revision <> s.revision)
      ), candidates as (
        select s.id as "storyId", s.title as "storyTitle", s.status as "storyStatus",
          least(n.waiting_since, p.proposed_at, d.waiting_since) as "waitingSince",
          (d.story_id is not null) as "hasDelivery",
          coalesce(n.notice_count, 0)::int as "noticeCount", p.revision as "planRevision"
        from stories s
        left join notice_groups n on n.story_id = s.id
        left join pending_plans p on p.story_id = s.id
        left join delivery_groups d on d.story_id = s.id
        where s.org_id = ${orgId} and s.project_id = ${projectId}
          and s.deleted_at is null
          and (n.story_id is not null or p.story_id is not null or d.story_id is not null)
          and (${query.category} = 'all'
            or (${query.category} = 'plans' and p.story_id is not null)
            or (${query.category} = 'notices' and n.story_id is not null)
            or (${query.category} = 'deliveries' and d.story_id is not null))
          and (s.title ilike ${pattern} or d.search_text ilike ${pattern} or exists (
            select 1 from attention_items a
            where a.org_id = s.org_id and a.project_id = s.project_id and a.story_id = s.id
              and a.status = 'open' and (a.title ilike ${pattern} or a.detail ilike ${pattern})
          ))
      )`;
        const [counts] = await tx.execute<{
          stories: number;
          plans: number;
          notices: number;
          deliveries: number;
        }>(sql`
        ${candidates}
        select count(*)::int as stories, count("planRevision")::int as plans,
          coalesce(sum("noticeCount"), 0)::int as notices,
          count(*) filter (where "hasDelivery")::int as deliveries from candidates
      `);
        if (!counts) throw new Error("Attention story count was not returned");
        const rows = await tx.execute<AttentionStoryRow>(sql`
        ${candidates} select * from candidates
        order by "waitingSince" asc, "storyId" asc limit ${query.limit} offset ${query.offset}
      `);
        const ids = rows.map((row) => row.storyId);
        // Only this page's original plans are read and parsed; counts never load
        // Markdown. The persisted current revision was selected above.
        const planFilters = rows.flatMap((row) =>
          row.planRevision === null
            ? []
            : [
                and(
                  eq(storyPlanRevisions.storyId, row.storyId),
                  eq(storyPlanRevisions.revision, row.planRevision),
                ),
              ],
        );
        const plans = planFilters.length
          ? await tx
              .select({
                storyId: storyPlanRevisions.storyId,
                revision: storyPlanRevisions.revision,
                digest: storyPlanRevisions.digest,
                proposedAt: storyPlanRevisions.proposedAt,
                markdown: storyPlanRevisions.markdown,
              })
              .from(storyPlanRevisions)
              .where(
                and(
                  eq(storyPlanRevisions.orgId, orgId),
                  eq(storyPlanRevisions.projectId, projectId),
                  or(...planFilters),
                ),
              )
          : [];
        const kinds = ids.length
          ? await tx
              .select({
                storyId: attentionItems.storyId,
                kind: attentionItems.kind,
                count: sql<number>`count(*)::int`,
              })
              .from(attentionItems)
              .where(
                and(
                  eq(attentionItems.orgId, orgId),
                  eq(attentionItems.projectId, projectId),
                  eq(attentionItems.status, "open"),
                  inArray(attentionItems.storyId, ids),
                ),
              )
              .groupBy(attentionItems.storyId, attentionItems.kind)
              .orderBy(attentionItems.kind)
          : [];
        return {
          generatedAt: now,
          total: counts.stories,
          counts,
          otherPullRequests: {
            total: otherPulls.length,
            limit: query.limit,
            offset: query.pullOffset ?? 0,
            items: otherPulls.slice(query.pullOffset ?? 0, (query.pullOffset ?? 0) + query.limit),
          },
          workflowPolicy: {
            available: !deliverySnapshot.policyError,
            error: deliverySnapshot.policyError,
          },
          budget: budget
            ? {
                available: true as const,
                state: budget.state,
                enabled: budget.budget?.enabled ?? false,
                monthlyLimitCents: budget.budget?.monthlyLimitCents ?? null,
                spentCents: budget.spentCents,
                remainingCents: budget.remainingCents,
                windowStart: budget.windowStart,
                windowEnd: budget.windowEnd,
              }
            : { available: false as const, reason: "permission" as const },
          limit: query.limit,
          offset: query.offset,
          items: rows.map((row) => {
            const plan = plans.find((plan) => plan.storyId === row.storyId);
            const { planRevision: _revision, hasDelivery: _hasDelivery, ...story } = row;
            return {
              ...story,
              delivery: deliveries.get(row.storyId) ?? null,
              waitingSince: new Date(story.waitingSince),
              noticeKinds: kinds
                .filter((kind) => kind.storyId === row.storyId)
                .map(({ kind, count }) => ({ kind, count })),
              plan: plan
                ? {
                    revision: plan.revision,
                    digest: plan.digest,
                    proposedAt: plan.proposedAt,
                    decisionBrief: readDecisionBrief(plan.markdown),
                  }
                : null,
            };
          }),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async list(orgId: string, projectId: string, query: AttentionQuery, now = new Date()) {
    const scope = and(eq(attentionItems.orgId, orgId), eq(attentionItems.projectId, projectId));
    const search = searchCondition(query.q);
    const status = query.status === "all" ? undefined : eq(attentionItems.status, query.status);
    const kind =
      query.kind && query.kind.length > 0 ? inArray(attentionItems.kind, query.kind) : undefined;
    const storyJoin = and(
      eq(stories.orgId, attentionItems.orgId),
      eq(stories.projectId, attentionItems.projectId),
      eq(stories.id, attentionItems.storyId),
    );

    const [rows, statusRows, kindRows] = await Promise.all([
      this.db
        .select({
          id: attentionItems.id,
          storyId: attentionItems.storyId,
          storyTitle: stories.title,
          storyStatus: stories.status,
          turnId: attentionItems.turnId,
          kind: attentionItems.kind,
          title: attentionItems.title,
          detail: sql<string | null>`left(${attentionItems.detail}, ${DETAIL_EXCERPT}::int)`,
          status: attentionItems.status,
          resolution: attentionItems.resolution,
          createdAt: attentionItems.createdAt,
          resolvedAt: attentionItems.resolvedAt,
        })
        .from(attentionItems)
        .innerJoin(stories, storyJoin)
        .where(and(scope, status, kind, search))
        .orderBy(desc(attentionItems.createdAt), desc(attentionItems.id))
        .limit(query.limit)
        .offset(query.offset),
      // Status counts honour the search and kind filters so the tabs say how
      // many matches each one holds.
      this.db
        .select({ status: attentionItems.status, count: sql<number>`count(*)::int` })
        .from(attentionItems)
        .innerJoin(stories, storyJoin)
        .where(and(scope, kind, search))
        .groupBy(attentionItems.status),
      // Kind facets ignore the kind filter itself, so choosing one kind still
      // shows what the others hold.
      this.db
        .select({ kind: attentionItems.kind, count: sql<number>`count(*)::int` })
        .from(attentionItems)
        .innerJoin(stories, storyJoin)
        .where(and(scope, status, search))
        .groupBy(attentionItems.kind)
        .orderBy(desc(sql`count(*)`), attentionItems.kind),
    ]);

    const counts = { open: 0, resolved: 0 };
    for (const row of statusRows) {
      if (row.status === "open" || row.status === "resolved") counts[row.status] = row.count;
    }
    return {
      generatedAt: now,
      total: query.status === "all" ? counts.open + counts.resolved : counts[query.status],
      limit: query.limit,
      offset: query.offset,
      counts,
      facets: { kinds: kindRows },
      items: rows.map((row) => {
        const open = row.status === "open";
        return {
          id: row.id,
          storyId: row.storyId,
          storyTitle: row.storyTitle,
          storyStatus: row.storyStatus as StoryStatus,
          turnId: row.turnId,
          kind: row.kind,
          title: row.title,
          detail: row.detail,
          status: open ? ("open" as const) : ("resolved" as const),
          resolution: open ? null : row.resolution,
          createdAt: row.createdAt,
          resolvedAt: open ? null : row.resolvedAt,
          action: open ? attentionAction(row) : null,
        };
      }),
    };
  }
}

/** Words match the notice, its detail, or the story it belongs to. */
function searchCondition(q: string | undefined): SQL | undefined {
  const text = q?.trim();
  if (!text) return undefined;
  const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return or(
    ilike(attentionItems.title, pattern),
    ilike(attentionItems.detail, pattern),
    ilike(stories.title, pattern),
  );
}
