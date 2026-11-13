import type { StoryWorkflowStatus } from "@facility/sdk";
import Link from "next/link";
import { safeExternalUrl } from "@/lib/story-presentation";

type ReviewCycle = NonNullable<StoryWorkflowStatus["reviewCycle"]>;
type Candidate = NonNullable<ReviewCycle["candidate"]>;

export const cyclePhases: Record<ReviewCycle["phase"], string> = {
  waiting_for_evidence: "Waiting for review evidence",
  review: "Reviewer is checking the candidate",
  correction: "Builder is correcting the findings",
  human_review: "Ready for human review",
  decision_required: "Human decision required",
};

const activePhases: ReviewCycle["phase"][] = ["waiting_for_evidence", "review", "correction"];

/** True while the cycle is still running. At a human stop the person decides, as
 * the server allows; the stop's reason stays next to the acceptance action. */
export function reviewCycleBlocksAcceptance(cycle: ReviewCycle | undefined) {
  return !!cycle && activePhases.includes(cycle.phase);
}

function sourceLink(
  candidate: Candidate,
  repository: string,
  number: number,
  path: string,
  line: number,
) {
  const pull = candidate.pullRequests.find(
    (item) => item.repository === repository && item.number === number,
  );
  const url = pull && safeExternalUrl(pull.url);
  if (!pull || !url || !/^[a-f0-9]{40}$/.test(pull.headSha)) return null;
  const parsed = new URL(url);
  // Anchor evidence to the report's immutable head, never the latest PR branch.
  parsed.pathname = `/${repository.split("/").map(encodeURIComponent).join("/")}/blob/${pull.headSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
  parsed.search = "";
  parsed.hash = `L${line}`;
  return parsed.href;
}

function CandidateDetails({ candidate }: { candidate: Candidate }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="break-all text-(--dim)">
        Candidate <code>{candidate.id}</code> · scope r{candidate.scopeRevision}
      </p>
      <ul aria-label="Pinned delivery candidate" className="space-y-2">
        {candidate.pullRequests.map((pull) => {
          const url = safeExternalUrl(pull.url);
          return (
            <li key={`${pull.repository}:${pull.number}`} className="min-w-0 break-words">
              {url ? (
                <a className="underline" href={url}>
                  {pull.repository} #{pull.number}
                </a>
              ) : (
                <span>
                  {pull.repository} #{pull.number}
                </span>
              )}
              <p className="break-all text-(--mut)">
                Base <code>{pull.baseSha}</code>
                <br />
                Head <code>{pull.headSha}</code>
              </p>
              <p className="text-(--mut)">
                CI {pull.checks.state} ·{" "}
                {pull.checks.observedAt ? (
                  <time dateTime={pull.checks.observedAt}>{pull.checks.observedAt}</time>
                ) : (
                  "not observed"
                )}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="break-all text-(--mut)">
        {candidate.preview ? (
          <>
            Recorded preview <code>{candidate.preview.generation}</code> ·{" "}
            {candidate.preview.observedAt}
          </>
        ) : (
          "No preview recorded for this review candidate."
        )}
      </p>
    </div>
  );
}

export function ReviewCycleDetails({ cycle }: { cycle: ReviewCycle }) {
  return (
    <section
      aria-label="Recorded delivery review"
      className="flex min-w-0 flex-col gap-3 border-b border-(--line) pb-4 text-sm"
    >
      <p role="status">
        <strong>{cyclePhases[cycle.phase]}</strong>
      </p>
      {cycle.reason ? <p className="break-words text-(--mut)">{cycle.reason}</p> : null}
      <p className="break-words">
        Builder <strong>{cycle.builderAgent}</strong> · Reviewer{" "}
        <strong>{cycle.reviewerAgent}</strong>
      </p>
      <p>
        Reviews {cycle.reviewsStarted}/2 · Corrections {cycle.correctionsStarted}/1
      </p>
      <p className="break-words text-(--mut)">
        Cost {cycle.costCents === null ? "unconfirmed" : `${cycle.costCents.toFixed(2)} cents`} ·
        deadline <time dateTime={cycle.deadline}>{cycle.deadline}</time>
      </p>
      {cycle.phase === "decision_required" ? (
        <p className="text-(--mut)">
          Review the reason and evidence before deciding.{" "}
          <Link className="underline" href="#story-plan">
            Review the plan
          </Link>{" "}
          or{" "}
          <Link className="underline" href="#conversation">
            continue in the conversation
          </Link>
          . Neither action restarts the cycle.
        </p>
      ) : null}
      {cycle.candidate ? (
        <details>
          <summary className="cursor-pointer">
            Pinned candidate · {cycle.candidate.pullRequests.length} PRs
          </summary>
          <div className="pt-3">
            <CandidateDetails candidate={cycle.candidate} />
          </div>
        </details>
      ) : (
        <p className="text-(--mut)">No pinned review candidate is available.</p>
      )}
      {cycle.reviews.map(
        (
          {
            turnId,
            result,
            candidate,
            planRevision,
            policyRevision,
            reviewerManifestHash,
            publication,
          },
          index,
        ) => (
          <details key={turnId} className="min-w-0 break-words">
            <summary className="cursor-pointer">
              Review {index + 1} · {result.findings.filter((f) => f.disposition === "open").length}{" "}
              open · {result.findings.filter((f) => f.disposition === "resolved").length} resolved
            </summary>
            <div className="space-y-3 pt-3">
              <p className="text-(--mut)">
                {candidate.id === cycle.candidate?.id
                  ? "Pinned candidate report"
                  : "Previous candidate · historical report"}{" "}
                · plan r{planRevision} · policy r{policyRevision}
              </p>
              {publication?.length ? (
                <ul aria-label="Reviews on GitHub" className="flex flex-wrap gap-x-4 gap-y-1">
                  {publication.map((item) => (
                    <li key={`${item.repository}#${item.number}`}>
                      {item.state === "published" && item.url ? (
                        <a
                          className="text-(--info) underline underline-offset-4"
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Review on {item.repository} #{item.number} ↗
                        </a>
                      ) : (
                        <span className="text-(--human)">
                          Not published on {item.repository} #{item.number}
                          {item.reason ? `: ${item.reason}` : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul aria-label="Acceptance evidence" className="space-y-3">
                {result.acceptance.map((criterion) => (
                  <li key={criterion.id}>
                    <strong>{criterion.state}</strong> · {criterion.criterion}
                    <p className="text-(--mut)">{criterion.evidence}</p>
                  </li>
                ))}
              </ul>
              <ul aria-label="Review findings" className="space-y-3">
                {result.findings.map((finding) => {
                  const source = sourceLink(
                    candidate,
                    finding.repository,
                    finding.number,
                    finding.path,
                    finding.line,
                  );
                  return (
                    <li key={finding.id} className="border-t border-(--line) pt-3">
                      <p>
                        <strong>
                          {finding.priority} · {finding.disposition}
                        </strong>{" "}
                        ·{" "}
                        {finding.correction === "requires_decision"
                          ? "Human decision required"
                          : "Correction within the plan"}
                      </p>
                      <p>{finding.impact}</p>
                      <p className="text-(--mut)">Requirement: {finding.requirement}</p>
                      <p className="text-(--mut)">Evidence: {finding.evidence}</p>
                      <p>Reviewer recommendation: {finding.fix}</p>
                      <p className="break-all text-(--dim)">
                        {finding.repository} · {finding.path}:{finding.line}
                      </p>
                      {source ? (
                        <a className="inline-flex min-h-11 items-center underline" href={source}>
                          View exact source
                        </a>
                      ) : (
                        <p className="text-(--mut)">Exact source link unavailable.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {result.findings.length === 0 ? <p>No findings reported in this review.</p> : null}
              {result.missingEvidence.length ? (
                <div>
                  <p className="font-medium">Missing evidence reported by the Reviewer</p>
                  <ul className="list-inside list-disc">
                    {[...new Set(result.missingEvidence)].map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <details>
                <summary className="cursor-pointer">Candidate and review provenance</summary>
                <div className="space-y-3 pt-3">
                  <p className="break-all text-(--dim)">
                    Reviewer version <code>{reviewerManifestHash}</code> · turn{" "}
                    <code>{turnId}</code>
                  </p>
                  <CandidateDetails candidate={candidate} />
                </div>
              </details>
            </div>
          </details>
        ),
      )}
      <p className="text-(--dim)">
        These are the recorded Reviewer results. Human acceptance, merge and source completion
        remain separate.
      </p>
    </section>
  );
}
