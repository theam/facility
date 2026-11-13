import { AgentManifestSchema } from "@facility/agents";
import {
  type FacilityDb,
  storyMessages,
  storyPlanDecisions,
  storyPlanRevisions,
  storyPlanStates,
  storyPreviewConvergences,
  turns,
} from "@facility/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import {
  deliveryNeedsReview,
  readProjectDeliveryReviews,
} from "../insights/project-delivery-reviews.js";
import type { BacklogItem } from "./backlog.js";
import { observePlanExecutionGate } from "./workflow-execution.js";

export const TRACKING_GROUPS = [
  "review",
  "in_progress",
  "waiting",
  "backlog",
  "done",
  "archived",
] as const;
export type TrackingGroup = (typeof TRACKING_GROUPS)[number];
export type BacklogTracking = {
  group: TrackingGroup;
  pendingMessages: number;
  messageWait: "previous_turn" | "preview" | "dispatch" | null;
  previewApplying: boolean;
  plan: { revision: number; digest: string } | null;
  delivery: { ready: boolean; detail: string } | null;
  wait: {
    kind: "workflow" | "retry_delay" | "dispatch" | "unavailable";
    detail: string;
    retryAfter: string | null;
  } | null;
};

/** Presentation grouping does not replace the lifecycle phase or hide concurrent facts. */
export function trackingGroup(
  item: Pick<BacklogItem, "phase" | "activity" | "attention" | "pullRequest">,
  tracking: Omit<BacklogTracking, "group">,
): TrackingGroup {
  if (item.phase === "archived" || item.phase === "done") return item.phase;
  if (
    tracking.plan ||
    tracking.delivery?.ready ||
    item.attention.some((notice) => notice.source === "facility")
  )
    return "review";
  if (item.activity.state === "running" || tracking.previewApplying) return "in_progress";
  if (item.activity.state === "queued" || tracking.pendingMessages > 0) return "waiting";
  if (tracking.delivery) return "waiting";
  if (item.pullRequest?.state === "open" && !item.pullRequest.draft) {
    return item.pullRequest.ciState === "pending" ? "waiting" : "review";
  }
  return "backlog";
}

/** Bulk metadata only. This runs in the backlog snapshot, before filtering or paging. */
export async function trackBacklog(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  items: BacklogItem[],
  now: Date,
) {
  const [pending, previews, plans, deliveries] = await Promise.all([
    db
      .select({ storyId: storyMessages.storyId, count: sql<number>`count(*)::int` })
      .from(storyMessages)
      .where(
        and(
          eq(storyMessages.orgId, orgId),
          eq(storyMessages.projectId, projectId),
          isNull(storyMessages.turnId),
          isNotNull(storyMessages.requestedAgentName),
          eq(storyMessages.role, "user"),
        ),
      )
      .groupBy(storyMessages.storyId),
    db
      .select({ storyId: storyPreviewConvergences.storyId })
      .from(storyPreviewConvergences)
      .where(
        and(
          eq(storyPreviewConvergences.orgId, orgId),
          eq(storyPreviewConvergences.projectId, projectId),
          eq(storyPreviewConvergences.state, "applying"),
        ),
      ),
    db
      .select({
        storyId: storyPlanStates.storyId,
        revision: storyPlanStates.revision,
        digest: storyPlanRevisions.digest,
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
      .where(
        and(
          eq(storyPlanStates.orgId, orgId),
          eq(storyPlanStates.projectId, projectId),
          sql`(${storyPlanDecisions.planRevision} is null or ${storyPlanDecisions.planRevision} <> ${storyPlanStates.revision})`,
        ),
      ),
    readProjectDeliveryReviews(db, { orgId, projectId }, now),
  ]);
  const pendingByStory = new Map(pending.map((row) => [row.storyId, row.count]));
  const previewStories = new Set(previews.map((row) => row.storyId));
  const planByStory = new Map(
    plans.map((row) => [row.storyId, { revision: row.revision, digest: row.digest }]),
  );
  return items.map((item) => {
    const id = item.story?.id ?? "";
    const pendingMessages = pendingByStory.get(id) ?? 0;
    const previewApplying = previewStories.has(id);
    const delivery = deliveries.stories.get(id);
    const tracking: Omit<BacklogTracking, "group"> = {
      pendingMessages,
      messageWait: pendingMessages
        ? item.activity.state !== "idle"
          ? "previous_turn"
          : previewApplying
            ? "preview"
            : "dispatch"
        : null,
      previewApplying,
      plan: planByStory.get(id) ?? null,
      delivery:
        delivery && deliveryNeedsReview(delivery)
          ? {
              ready: delivery.acceptanceReady,
              detail: delivery.acceptanceReady
                ? "Delivery is available for acceptance review."
                : (delivery.blocked?.message ??
                  (delivery.acceptance.status === "current"
                    ? "This candidate is accepted; delivery work remains."
                    : "Delivery readiness is not confirmed.")),
            }
          : null,
      wait:
        item.activity.state === "queued"
          ? {
              kind: "dispatch",
              detail: "Queued for dispatch. Available worker capacity is not reported.",
              retryAfter: null,
            }
          : null,
    };
    return { ...item, tracking: { ...tracking, group: trackingGroup(item, tracking) } };
  });
}

/** Recheck only this page's retained queued turns with the dispatcher's checks,
 * read without its row locks. No reservation, enqueue, provider inspection or
 * mutation occurs here. */
export async function observeBacklogWaits(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  items: BacklogItem[],
  now: Date,
) {
  const ids = items
    .filter((item) => item.activity.state === "queued")
    .flatMap((item) => (item.activity.turnId ? [item.activity.turnId] : []));
  if (!ids.length) return;
  const rows = await db
    .select()
    .from(turns)
    .where(
      and(
        eq(turns.orgId, orgId),
        eq(turns.projectId, projectId),
        inArray(turns.id, ids),
        eq(turns.state, "queued"),
      ),
    );
  for (const item of items) {
    if (!item.tracking || item.activity.state !== "queued") continue;
    const turn = rows.find(
      (row) => row.id === item.activity.turnId && row.storyId === item.story?.id,
    );
    const manifest = AgentManifestSchema.safeParse(turn?.manifest);
    if (!turn || !manifest.success) {
      item.tracking.wait = {
        kind: "unavailable",
        detail:
          "The retained agent configuration could not be assessed. Inspect the story before continuing.",
        retryAfter: null,
      };
      continue;
    }
    try {
      await observePlanExecutionGate(
        db,
        { orgId, projectId, storyId: turn.storyId },
        manifest.data,
        turn.createdBy,
        turn.id,
      );
      item.tracking.wait =
        turn.retryAfter && turn.retryAfter > now
          ? {
              kind: "retry_delay",
              detail:
                "Dispatch is deferred until the recorded retry time. This does not establish worker capacity.",
              retryAfter: turn.retryAfter.toISOString(),
            }
          : {
              kind: "dispatch",
              detail: "Queued for dispatch. Available worker capacity is not reported.",
              retryAfter: null,
            };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      item.tracking.wait = {
        kind: "workflow",
        detail: error.message,
        retryAfter: turn.retryAfter?.toISOString() ?? null,
      };
    }
  }
}
