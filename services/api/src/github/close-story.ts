import { type FacilityDb, ghIssues, type repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type {
  FacilityGithubClient,
  GithubIssueCloseReason,
  GithubIssueStateSnapshot,
} from "./client.js";

// GitHub has no field for why an issue was closed, so the comment carrying the
// reason is the record on that side. The marker makes that comment identifiable
// as Facility's own, so a retry after a half-completed close corrects it
// instead of stacking a second copy of the reason.
const CLOSE_MARKER = "<!-- facility:story-close -->";

export type StoryStateMutation = {
  state: "open" | "closed";
  closedAt: Date | null;
  /** False when GitHub already held the requested state and nothing was written. */
  changed: boolean;
  commentId: number | null;
};

export async function closeStory(input: {
  db: FacilityDb;
  client: FacilityGithubClient;
  repo: typeof repos.$inferSelect;
  issueNumber: number;
  reason: string;
  stateReason: GithubIssueCloseReason;
  actor: string;
}): Promise<StoryStateMutation> {
  const before = await input.client.getIssueState(input.issueNumber);
  if (before.state === "closed") {
    // Already closed on GitHub — a replayed request, or a human closed it there.
    // Reconcile the mirror and never post the reason a second time.
    await mirrorIssueState(input.db, input.repo, before);
    return { state: "closed", closedAt: before.closedAt, changed: false, commentId: null };
  }

  // The reason is written before the transition: a story closed without the
  // decision that closed it is exactly the record this endpoint exists to keep.
  const commentId = await upsertReasonComment(
    input.client,
    input.issueNumber,
    closeCommentBody(input.reason, input.stateReason, input.actor),
  );
  const after = await input.client.closeIssue(input.issueNumber, input.stateReason);
  await mirrorIssueState(input.db, input.repo, after);
  return { state: "closed", closedAt: after.closedAt, changed: true, commentId };
}

export async function reopenStory(input: {
  db: FacilityDb;
  client: FacilityGithubClient;
  repo: typeof repos.$inferSelect;
  issueNumber: number;
}): Promise<StoryStateMutation> {
  const before = await input.client.getIssueState(input.issueNumber);
  if (before.state === "open") {
    await mirrorIssueState(input.db, input.repo, before);
    return { state: "open", closedAt: before.closedAt, changed: false, commentId: null };
  }

  const after = await input.client.reopenIssue(input.issueNumber);
  await mirrorIssueState(input.db, input.repo, after);
  return { state: "open", closedAt: after.closedAt, changed: true, commentId: null };
}

export function closeCommentBody(
  reason: string,
  stateReason: GithubIssueCloseReason,
  actor: string,
) {
  const label = stateReason === "not_planned" ? "not planned" : "completed";
  return `${CLOSE_MARKER}\n**Closed from Facility** by ${actor} · ${label}\n\n${reason}`;
}

/**
 * The comment Facility owns on this story, written once. An earlier attempt
 * whose close failed leaves the marker behind; that comment is corrected to the
 * current reason rather than duplicated.
 */
async function upsertReasonComment(
  client: FacilityGithubClient,
  issueNumber: number,
  body: string,
) {
  const existing = (await client.listIssueComments(issueNumber)).find((comment) =>
    comment.body.startsWith(CLOSE_MARKER),
  );
  if (!existing) return (await client.createIssueComment(issueNumber, body)).id;
  if (existing.body !== body) await client.updateIssueComment(existing.id, body);
  return existing.id;
}

/** The mirror follows GitHub; it is never written before GitHub confirms. */
async function mirrorIssueState(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  snapshot: GithubIssueStateSnapshot,
) {
  const now = new Date();
  await db
    .update(ghIssues)
    .set({
      state: snapshot.state,
      closedAt: snapshot.closedAt,
      ghUpdatedAt: snapshot.updatedAt ?? now,
      syncedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(ghIssues.orgId, repo.orgId),
        eq(ghIssues.repoId, repo.id),
        eq(ghIssues.number, snapshot.number),
      ),
    );
}
