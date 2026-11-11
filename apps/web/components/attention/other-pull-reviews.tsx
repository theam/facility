import type { ProjectAttentionStories } from "@facility/sdk";
import { buttonClassName, cardClassName, StatusPill } from "@facility/ui";
import Link from "next/link";
import { storyHref } from "@/lib/overview-presentation";
import { formatTime, safeExternalUrl } from "@/lib/story-presentation";
import { currentCheckLabel } from "./delivery-review";

export function OtherPullReviews({
  data,
  projectId,
  page,
  href,
}: {
  data: ProjectAttentionStories["otherPullRequests"] | undefined;
  projectId: string;
  page: number;
  href: (page: number) => string;
}) {
  const control = buttonClassName();
  return (
    <section
      id="other-pull-requests"
      aria-labelledby="other-pulls-heading"
      className={`${cardClassName} flex min-w-0 scroll-mt-6 flex-col gap-3 py-4`}
    >
      <h2 id="other-pulls-heading" className="px-5 text-[15px] font-semibold sm:px-6">
        Other pull requests
      </h2>
      {!data ? (
        <p role="status" className="px-5 text-sm sm:px-6">
          The other pull request inventory is unavailable in this response. Open the project
          overview to inspect recorded PRs.
        </p>
      ) : (
        <>
          <p className="-mt-2 px-5 text-[13px] text-(--dim) sm:px-6" role="status">
            {data.total} matching open {data.total === 1 ? "PR" : "PRs"}
          </p>
          {!data.items.length ? (
            <p className="px-5 py-2 text-sm sm:px-6">
              {data.total
                ? "No pull requests on this page."
                : "No other observed open PRs match this selection."}{" "}
              Ongoing work remains in Stories.
            </p>
          ) : (
            <ol
              aria-label="Other open pull requests"
              className="flex flex-col border-t border-(--line)"
            >
              {data.items.map((pull) => {
                const url = safeExternalUrl(pull.url);
                return (
                  <li
                    key={`${pull.repository}#${pull.number}`}
                    className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1 border-b border-(--line) px-5 py-3.5 text-sm last:border-b-0 sm:px-6"
                  >
                    <div className="min-w-0 flex-1">
                      <h3 className="min-w-0 break-words font-medium">
                        {pull.title ?? `${pull.repository} #${pull.number}`}
                      </h3>
                      <p className="text-[13px] text-(--mut)">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-(--info) hover:underline"
                          >
                            {pull.repository} #{pull.number} ↗
                          </a>
                        ) : (
                          <span className="break-all">
                            {pull.repository} #{pull.number} · link unavailable
                          </span>
                        )}
                        {pull.draft ? " · Draft" : ""}
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        !pull.checks.current || pull.stale
                          ? "neutral"
                          : pull.checks.state === "failure"
                            ? "bad"
                            : pull.checks.state === "success"
                              ? "ok"
                              : pull.checks.state === "pending"
                                ? "human"
                                : "neutral"
                      }
                    >
                      {currentCheckLabel(pull)}
                      {pull.stale ? " · observation outdated" : ""}
                    </StatusPill>
                    <details className="basis-full text-xs text-(--mut)">
                      <summary className="min-h-9 w-fit cursor-pointer py-2">PR details</summary>
                      <p className="break-all">
                        Observed head: <code>{pull.headSha ?? "unavailable"}</code>
                      </p>
                      <p className="mt-2 text-xs text-(--mut)">
                        PR updated {formatTime(pull.updatedAt)} · mirror observed{" "}
                        {formatTime(pull.observedAt)}
                      </p>
                      {pull.stories.length ? (
                        <ul className="mt-3 flex flex-col gap-1" aria-label="Related stories">
                          {pull.stories.map((story) => (
                            <li key={story.id}>
                              <Link
                                className="inline-flex min-h-11 items-center break-words text-(--info) underline underline-offset-4"
                                href={storyHref(projectId, story.id)}
                              >
                                {story.title}
                              </Link>
                              <span className="text-(--mut)">
                                {" "}
                                · {story.status} ·{" "}
                                {story.relation === "source" ? "PR source" : "delivery link"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-(--mut)">No story association recorded.</p>
                      )}
                    </details>
                  </li>
                );
              })}
            </ol>
          )}
          <nav
            aria-label="Other pull request pages"
            className="flex flex-wrap items-center justify-between gap-3 px-5 text-sm sm:px-6"
          >
            <p>
              {data.items.length ? `${data.offset + 1}–${data.offset + data.items.length}` : "0"} of{" "}
              {data.total} PRs
            </p>
            <div className="flex flex-wrap gap-3">
              {page > 1 ? (
                <Link href={href(page - 1)} className={control}>
                  Previous PRs
                </Link>
              ) : null}
              {data.offset + data.items.length < data.total ? (
                <Link href={href(page + 1)} className={control}>
                  Next PRs
                </Link>
              ) : null}
              {page > 1 && !data.items.length ? (
                <Link href={href(1)} className={control}>
                  First PR page
                </Link>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
