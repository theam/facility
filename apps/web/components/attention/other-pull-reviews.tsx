import type { ProjectAttentionStories } from "@facility/sdk";
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
  const control =
    "inline-flex min-h-11 items-center border border-(--line) px-3 text-sm hover:bg-(--card)";
  return (
    <section
      id="other-pull-requests"
      aria-labelledby="other-pulls-heading"
      className="flex min-w-0 flex-col gap-4 border-t border-(--line) pt-6"
    >
      <h2 id="other-pulls-heading" className="text-base font-semibold">
        Other pull requests
      </h2>
      {!data ? (
        <p role="status">
          The other pull request inventory is unavailable in this response. Open the project
          overview to inspect recorded PRs.
        </p>
      ) : (
        <>
          <p className="text-sm text-(--mut)" role="status">
            {data.total} matching open {data.total === 1 ? "PR" : "PRs"}
          </p>
          {!data.items.length ? (
            <p className="py-2">
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
                    className="min-w-0 border-b border-(--line) py-4 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="min-w-0 break-words font-medium">
                        {pull.title ?? `${pull.repository} #${pull.number}`}
                      </h3>
                      <span className="text-(--mut)">{pull.draft ? "Draft · open" : "Open"}</span>
                    </div>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center break-all text-(--info) underline underline-offset-4"
                      >
                        {pull.repository} #{pull.number} ↗
                      </a>
                    ) : (
                      <p className="break-all">
                        {pull.repository} #{pull.number} · link unavailable
                      </p>
                    )}
                    <p>
                      {currentCheckLabel(pull)}
                      {pull.stale ? " · observation outdated" : ""}
                    </p>
                    <details className="mt-2 text-xs text-(--mut)">
                      <summary className="min-h-11 cursor-pointer py-3">PR details</summary>
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
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
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
