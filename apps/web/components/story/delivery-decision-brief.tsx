import type { StoryDelivery } from "@facility/sdk";
import Link from "next/link";
import { formatTime } from "@/lib/story-presentation";
import { DecisionBrief } from "./decision-brief";

type Projection = NonNullable<StoryDelivery["decisionBrief"]>;
const reasons = {
  scope_changed: "The delivery scope has changed since this brief was written.",
  heads_changed:
    "The PR set or a required or optional head has changed since this brief was written.",
  candidate_changed: "The recorded candidate has changed since this brief was written.",
  observations_unavailable: "The complete set of current heads could not be established.",
  observations_stale:
    "The recorded GitHub observations are outdated. Refresh them before relying on this brief.",
  source_unavailable: "The original agent turn could not be verified.",
  too_large: "The latest author response exceeds the size supported for a structured brief.",
  duplicate: "The latest author response contains more than one delivery brief.",
  malformed: "The latest author brief could not be parsed.",
  unsupported_version: "The latest author brief uses an unsupported format version.",
  invalid_fields: "The latest author brief has invalid or incomplete fields.",
};

export function DeliveryDecisionBrief({
  projection,
  storyUrl,
}: {
  projection?: Projection;
  storyUrl: string;
}) {
  if (!projection) return null;
  if (projection.status === "absent")
    return (
      <p className="my-4 text-sm text-(--mut)">
        No author delivery brief is recorded. Review the PR set and its observed evidence below.
      </p>
    );
  const { source } = projection;
  const original = new URL(storyUrl, "https://facility.invalid");
  original.searchParams.set("messageId", source.messageId);
  original.hash = `message-${source.messageId}`;
  const brief =
    projection.status === "invalid" ? null : (
      <>
        <DecisionBrief brief={projection.brief} delivery={projection.subject} />
        <details className="mt-3 text-xs text-(--mut)">
          <summary className="min-h-11 cursor-pointer py-3">
            Exact subject of the author’s brief
          </summary>
          <p className="break-all">
            Candidate: <code>{projection.subject.candidateRevision}</code>
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {projection.subject.pullRequests.map((pull) => (
              <li key={`${pull.repositoryId}:${pull.number}`} className="break-all">
                {pull.repositoryId} #{pull.number} · {pull.required ? "Required" : "Related"}
                {pull.primary ? " · Primary" : ""}
                <br />
                <code>{pull.headSha}</code>
              </li>
            ))}
          </ul>
        </details>
      </>
    );
  return (
    <section
      aria-label="Author’s delivery brief"
      className="my-4 min-w-0 border-l-2 border-(--human) bg-(--bg-subtle) p-4 text-sm"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-(--mut)">
          {source.turn?.agentName ?? "Unverified author"} · {formatTime(source.createdAt)}
        </p>
        <Link
          href={`${original.pathname}${original.search}${original.hash}`}
          className="inline-flex min-h-11 items-center text-(--info) underline underline-offset-4"
        >
          Open original message and author
        </Link>
      </div>
      {projection.status === "available" ? (
        brief
      ) : (
        <>
          <p className="text-(--human)">
            {projection.status === "stale"
              ? "Historical brief. "
              : "Brief is not verified for this delivery. "}
            {reasons[projection.reason]}
          </p>
          {brief ? (
            <details className="mt-3">
              <summary className="min-h-11 cursor-pointer py-3 text-(--info)">
                Read the saved author statements
              </summary>
              {brief}
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
