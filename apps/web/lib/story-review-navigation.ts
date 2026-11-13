import type { StoryPlan } from "@facility/sdk";

export type PlanSelection = {
  revision: number | null;
  digest?: string;
  plan?: StoryPlan;
  error?: string;
};
type Search = Record<string, string | string[] | undefined>;
export function readStoryReviewLink(raw: Search) {
  let selection: PlanSelection | undefined;
  if (raw.planRevision !== undefined || raw.planDigest !== undefined) {
    const revision =
      typeof raw.planRevision === "string" && /^[1-9]\d*$/.test(raw.planRevision)
        ? Number(raw.planRevision)
        : NaN;
    const digest = typeof raw.planDigest === "string" ? raw.planDigest : undefined;
    selection =
      Number.isSafeInteger(revision) &&
      revision <= 2_147_483_647 &&
      (raw.planDigest === undefined || (digest !== undefined && /^[a-f0-9]{64}$/.test(digest)))
        ? { revision, digest }
        : {
            revision: null,
            error:
              "This plan link has an invalid revision or digest. Open the current plan explicitly to continue.",
          };
  }
  const messageId =
    typeof raw.messageId === "string" &&
    raw.messageId.length > 0 &&
    raw.messageId.length <= 200 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: mirror the API identifier validation
    !/[\s\x00-\x1f\x7f]/.test(raw.messageId)
      ? raw.messageId
      : undefined;
  return {
    selection,
    messageId,
    messageError:
      raw.messageId !== undefined && !messageId
        ? "This source message link is invalid."
        : undefined,
  };
}

/** All destinations stay inside the selected story. Query values never become paths. */
export function storyReviewHref(
  projectId: string,
  storyId: string,
  selection?: Pick<PlanSelection, "revision" | "digest">,
  messageId?: string,
  section = "story-plan",
) {
  const search = new URLSearchParams();
  if (selection?.revision) search.set("planRevision", String(selection.revision));
  if (selection?.revision && selection.digest) search.set("planDigest", selection.digest);
  if (messageId) search.set("messageId", messageId);
  return `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}${search.size ? `?${search}` : ""}#${encodeURIComponent(section)}`;
}

export function selectionMatchesPlan(selection: PlanSelection, plan: StoryPlan | null | undefined) {
  return (
    !selection.error &&
    !!plan &&
    plan.revision === selection.revision &&
    (!selection.digest || plan.digest === selection.digest) &&
    !!selection.plan &&
    plan.digest === selection.plan.digest
  );
}
