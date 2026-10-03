import { attentionItems, type FacilityDb, stories } from "@facility/db";
import { and, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
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

export class ProjectAttentionService {
  constructor(private readonly db: FacilityDb) {}

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
