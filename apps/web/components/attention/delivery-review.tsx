import type { ProjectAttentionStories } from "@facility/sdk";
import Link from "next/link";
import { DeliveryDecisionBrief } from "@/components/story/delivery-decision-brief";
import { formatTime, safeExternalUrl } from "@/lib/story-presentation";

type Delivery = NonNullable<ProjectAttentionStories["items"][number]["delivery"]>;
type Pull = Delivery["pullRequests"][number];

export function currentCheckLabel(pull: Pick<Pull, "checks">) {
  if (pull.checks.state === "unobserved") return "Checks not observed";
  if (!pull.checks.current) return "Checks belong to another or unknown head";
  return {
    success: "Passing at this head",
    failure: "Failing at this head",
    pending: "Pending at this head",
  }[pull.checks.state];
}

/** Observed facts about the complete candidate; no synthesized recommendation
 * and no implication that reading a candidate grants permission to accept it. */
export function DeliveryReview({ delivery, storyUrl }: { delivery: Delivery; storyUrl: string }) {
  const { candidate, acceptance, preview } = delivery;
  const servingCurrent =
    preview?.state === "ready" &&
    candidate.revision !== null &&
    preview.desiredGeneration === candidate.revision &&
    preview.deployedGeneration === candidate.revision;
  const acceptanceLabel = {
    current: "Accepted for the current candidate",
    stale: "Previous acceptance is no longer current",
    missing: "No acceptance recorded",
  }[acceptance.status];
  const candidateLabel = {
    recorded: "Complete candidate observed",
    scope_incomplete: "Delivery scope is incomplete",
    unobserved: "Required heads have not all been observed",
    stale: "Candidate observations need refreshing",
  }[candidate.state];
  return (
    <section
      aria-label="Delivery to review"
      className="mt-4 flex min-w-0 flex-col gap-3 border-t border-(--line) pt-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">
          Delivery · {candidate.requiredCount} required{" "}
          {candidate.requiredCount === 1 ? "PR" : "PRs"}
        </h3>
        <Link
          href={`${storyUrl}#story-delivery`}
          className="inline-flex min-h-11 items-center border border-(--line) px-3 text-(--ink) hover:bg-(--card)"
        >
          Review delivery
        </Link>
      </div>
      <DeliveryDecisionBrief projection={delivery.decisionBrief} storyUrl={storyUrl} />
      <p>
        {candidateLabel}.{" "}
        <span className="text-(--mut)">
          {candidate.mergedCount} of {candidate.requiredCount} required PRs merged.
        </span>
      </p>
      <p>
        {acceptanceLabel}.
        {acceptance.required === true
          ? " Human acceptance is required by project policy."
          : acceptance.required === false
            ? " Project policy does not require acceptance."
            : " Acceptance policy could not be read."}
      </p>
      {acceptance.status === "current" ? (
        <p className="text-(--mut)">
          Acceptance records this candidate. Pull request review, merge and story completion remain
          separate.
        </p>
      ) : delivery.blocked ? (
        <p className="border-l-2 border-(--line-strong) pl-3 text-(--mut)">
          Before acceptance: {delivery.blocked.message}
        </p>
      ) : delivery.acceptanceReady ? (
        <p className="text-(--mut)">
          The candidate meets the configured acceptance conditions. Review its checks and evidence
          before requesting confirmation.
        </p>
      ) : null}
      <ul aria-label="Candidate pull requests" className="flex flex-col gap-3">
        {delivery.pullRequests.map((pull) => {
          const url = safeExternalUrl(pull.url);
          return (
            <li
              key={`${pull.repository}:${pull.number}`}
              className="min-w-0 border border-(--line) bg-(--card) p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 min-w-0 items-center break-all text-(--info) underline underline-offset-4"
                  >
                    {pull.repository} #{pull.number} ↗
                  </a>
                ) : (
                  <span className="break-all">
                    {pull.repository} #{pull.number} · link not observed
                  </span>
                )}
                <span className="text-xs text-(--mut)">
                  {pull.required ? "Required" : "Related"}
                  {pull.primary ? " · Primary" : ""}
                  {pull.draft ? " · Draft" : ""} · {pull.state}
                </span>
              </div>
              {pull.title ? <p className="break-words">{pull.title}</p> : null}
              <p className="mt-2">
                {currentCheckLabel(pull)}
                {pull.stale ? " · observation outdated" : ""}
              </p>
              <p className="mt-1 break-all text-xs text-(--mut)">
                Observed head: <code>{pull.headSha ?? "unavailable"}</code>
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-(--mut)">
        Preview:{" "}
        {servingCurrent
          ? "the current candidate is recorded as served"
          : preview?.state === "suspended"
            ? "suspended; the recorded acceptance is evaluated separately"
            : preview
              ? `${preview.state}; serving the current candidate is not confirmed`
              : "not observed"}
        .
      </p>
      <details className="min-w-0">
        <summary className="min-h-11 cursor-pointer py-3 text-(--info)">
          Exact candidate, preview and acceptance evidence
        </summary>
        <dl className="flex min-w-0 flex-col gap-3 border-t border-(--line) pt-3 text-xs text-(--mut)">
          <div>
            <dt>Current candidate · delivery scope r{delivery.scopeRevision}</dt>
            <dd className="break-all font-mono">{candidate.revision ?? "Not established"}</dd>
          </div>
          <div>
            <dt>Desired preview</dt>
            <dd className="break-all font-mono">{preview?.desiredGeneration ?? "Not observed"}</dd>
          </div>
          <div>
            <dt>Last recorded served preview</dt>
            <dd className="break-all font-mono">{preview?.deployedGeneration ?? "Not observed"}</dd>
          </div>
          {preview ? (
            <div>
              <dt>Preview observation</dt>
              <dd>{formatTime(preview.observedAt)}</dd>
            </div>
          ) : null}
          {acceptance.receipt ? (
            <>
              <div>
                <dt>Accepted candidate</dt>
                <dd className="break-all font-mono">{acceptance.receipt.candidateRevision}</dd>
              </div>
              <div>
                <dt>Acceptance receipt r{acceptance.receipt.revision}</dt>
                <dd>
                  {acceptance.receipt.confirmedBy.name ?? "Project member"} ·{" "}
                  {formatTime(acceptance.receipt.confirmedAt)}
                  <br />
                  <code className="break-all">{acceptance.receipt.id}</code>
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      </details>
      <p className="text-xs text-(--mut)">
        Links open the current story or pull request. Compare its revision with this observation
        before deciding.
      </p>
    </section>
  );
}
