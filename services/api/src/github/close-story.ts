import { type FacilityDb, ghIssues, type repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { facilityBotLogins } from "./address-review-policy.js";
import type {
  FacilityGithubClient,
  GithubIssueCloseReason,
  GithubIssueStateSnapshot,
} from "./client.js";

// GitHub has no field for why an issue was closed, so the comment carrying the
// reason is the record on that side. The marker names the close attempt that
// wrote it: a retry of that same attempt recovers its own comment, while a
// later close — after a reopen, say — writes a new one, so the thread keeps
// every decision instead of overwriting the previous rationale.
const CLOSE_MARKER = "<!-- facility:story-close";

export type StoryStateMutation = {
  state: "open" | "closed";
  stateReason: string | null;
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
  /** Identifies this close attempt across its own retries; absent without an idempotency key. */
  attemptId: string | null;
  /** The configured GitHub App slug, without which no comment can be proven ours. */
  appSlug?: string;
}): Promise<StoryStateMutation> {
  const before = await input.client.getIssueState(input.issueNumber);
  if (before.state === "closed") {
    // Already closed on GitHub — a replayed request, or a human closed it there.
    // Reconcile the mirror and never post the reason a second time.
    await mirrorIssueState(input.db, input.repo, before);
    return mutation(before, { changed: false, commentId: null });
  }

  // The reason is written before the transition: a story closed without the
  // decision that closed it is exactly the record this endpoint exists to keep.
  const marker = closeMarker(input.attemptId);
  const commentId = await upsertReasonComment({
    client: input.client,
    issueNumber: input.issueNumber,
    body: closeCommentBody(input.reason, input.stateReason, input.actor, marker),
    // Recovery is scoped to this attempt and to comments GitHub attributes to
    // this app. Anyone can write the marker text; only the app can author as
    // the app, and only this attempt knows its own id.
    recover: input.attemptId ? { marker, appLogins: facilityBotLogins(input.appSlug) } : null,
  });
  const after = await input.client.closeIssue(input.issueNumber, input.stateReason);
  await mirrorIssueState(input.db, input.repo, after);
  return mutation(after, { changed: true, commentId });
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
    return mutation(before, { changed: false, commentId: null });
  }

  const after = await input.client.reopenIssue(input.issueNumber);
  await mirrorIssueState(input.db, input.repo, after);
  return mutation(after, { changed: true, commentId: null });
}

export function closeMarker(attemptId: string | null) {
  return attemptId ? `${CLOSE_MARKER}:${attemptId} -->` : `${CLOSE_MARKER} -->`;
}

export function closeCommentBody(
  reason: string,
  stateReason: GithubIssueCloseReason,
  actor: string,
  marker: string,
) {
  const label = stateReason === "not_planned" ? "not planned" : "completed";
  return `${marker}\n**Closed from Facility** by ${actor} · ${label}\n\n${reason}`;
}

/**
 * The comment this close attempt owns. An earlier try whose transition failed
 * leaves its marker behind; that comment is corrected rather than duplicated.
 * A comment is only ever reused when GitHub attributes it to this app, so a
 * marker forged by any other commenter is left untouched.
 */
async function upsertReasonComment(input: {
  client: FacilityGithubClient;
  issueNumber: number;
  body: string;
  recover: { marker: string; appLogins: ReadonlySet<string> } | null;
}) {
  const existing = input.recover?.appLogins.size
    ? (await input.client.listIssueComments(input.issueNumber)).find(
        (comment) =>
          comment.body.startsWith(input.recover?.marker ?? "") &&
          comment.authorType === "Bot" &&
          input.recover?.appLogins.has(comment.author.toLowerCase()),
      )
    : undefined;
  if (!existing) return (await input.client.createIssueComment(input.issueNumber, input.body)).id;
  if (existing.body !== input.body) await input.client.updateIssueComment(existing.id, input.body);
  return existing.id;
}

function mutation(
  snapshot: GithubIssueStateSnapshot,
  rest: { changed: boolean; commentId: number | null },
): StoryStateMutation {
  return {
    state: snapshot.state,
    stateReason: snapshot.stateReason,
    closedAt: snapshot.closedAt,
    ...rest,
  };
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
      stateReason: snapshot.stateReason,
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
