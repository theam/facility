import Link from "next/link";
import { DeliveryReview } from "@/components/attention/delivery-review";
import { OtherPullReviews } from "@/components/attention/other-pull-reviews";
import { ProjectConditions } from "@/components/attention/project-conditions";
import { ErrorNotice, Offline } from "@/components/offline";
import { type AttentionStoriesQuery, api } from "@/lib/api";
import { attentionKindLabel, relativeTime, storyHref } from "@/lib/overview-presentation";
import { storyReviewHref } from "@/lib/story-review-navigation";

/** Shared snapshot with independent pages for whole stories and other open PRs.
 * Project entry and saved pilot links use the same data and canonical navigation. */
export default async function ProjectAttentionPage({
  params,
  searchParams = Promise.resolve({}),
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, raw] = await Promise.all([params, searchParams]);
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const q = first(raw.q)?.trim().slice(0, 200) ?? "";
  const category = first(raw.category);
  const query: AttentionStoriesQuery = {
    category:
      category === "plans" ||
      category === "notices" ||
      category === "deliveries" ||
      category === "pulls"
        ? category
        : "all",
    q: q || undefined,
    limit: 10,
    offset: 0,
  };
  const readPage = (value: string | string[] | undefined) => {
    const page = Number(first(value));
    return Number.isSafeInteger(page) && page > 0 && page <= 1000000 ? page : 1;
  };
  const pageNumber = readPage(raw.page);
  const pullPage = readPage(raw.pullPage);
  const offset = (pageNumber - 1) * 10;
  query.offset = offset;
  query.pullOffset = (pullPage - 1) * 10;
  const result = await api.projectAttentionStories(projectId, query);
  if (!result.ok && result.offline) return <Offline />;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const href = (page: number, pulls = pullPage) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (query.category !== "all") search.set("category", query.category ?? "all");
    if (page > 1) search.set("page", String(page));
    if (pulls > 1) search.set("pullPage", String(pulls));
    return `${base}${search.size ? `?${search}` : ""}`;
  };
  const now = new Date();
  const projectNeedsAttention =
    result.ok &&
    (result.data.workflowPolicy?.available === false ||
      (result.data.budget?.available &&
        ["exceeded", "unconfirmed", "warning"].includes(result.data.budget.state)));
  const control =
    "inline-flex min-h-11 items-center border border-(--line) px-3 text-sm text-(--ink) hover:bg-(--card)";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Attention</h1>
        {result.ok ? (
          <p className="text-sm text-(--mut)" role="status">
            {result.data.counts.stories} pending{" "}
            {result.data.counts.stories === 1 ? "story" : "stories"}
          </p>
        ) : null}
      </header>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <details className="min-w-0 flex-1" open={!!q || query.category !== "all"}>
          <summary className="min-h-11 w-fit cursor-pointer py-3 text-sm text-(--mut)">
            Filters{q || query.category !== "all" ? " · active" : ""}
          </summary>
          <div className="pb-4 pt-2">
            <form
              method="get"
              action={`${base}`}
              aria-label="Find stories and pull requests"
              className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
            >
              <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm" htmlFor="review-search">
                Search
                <input
                  id="review-search"
                  type="search"
                  name="q"
                  defaultValue={q}
                  className="min-h-11 min-w-0 border border-(--line) bg-(--bg-subtle) px-3 text-(--ink)"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm" htmlFor="review-category">
                Type
                <select
                  id="review-category"
                  name="category"
                  defaultValue={query.category}
                  className="min-h-11 border border-(--line) bg-(--bg-subtle) px-3 text-(--ink)"
                >
                  <option value="all">All</option>
                  <option value="plans">Plans</option>
                  <option value="notices">Notices</option>
                  <option value="deliveries">Deliveries</option>
                  <option value="pulls">Other open PRs</option>
                </select>
              </label>
              <button type="submit" className={control}>
                Apply
              </button>
              {q || query.category !== "all" ? (
                <Link href={`${base}`} className={control}>
                  Clear filters
                </Link>
              ) : null}
            </form>
          </div>
        </details>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm text-(--mut)">
            More views
          </summary>
          <nav aria-label="Related project views" className="flex flex-wrap gap-3">
            <Link href={`${base}/activity`} className={control}>
              Activity
            </Link>
            <Link href={`${base}/attention`} className={control}>
              All notices
            </Link>
            <Link href={`${base}/attention?status=resolved`} className={control}>
              Resolved notices
            </Link>
            <Link href={`${base}/stories`} className={control}>
              All stories
            </Link>
          </nav>
        </details>
      </div>
      {result.ok && projectNeedsAttention ? (
        <ProjectConditions data={result.data} base={base} />
      ) : null}
      {!result.ok ? (
        <ErrorNotice message={`Couldn't load pending stories — ${result.message}`} />
      ) : (
        <>
          {query.category !== "pulls" ? (
            <>
              {result.data.items.length === 0 ? (
                <section className="border border-(--line) p-5">
                  <h2 className="font-semibold">
                    {result.data.total > 0
                      ? "No stories on this page"
                      : q || query.category !== "all"
                        ? "No matching pending stories"
                        : "No pending plans, notices or deliveries"}
                  </h2>
                  <Link
                    href={`${base}/stories`}
                    className="mt-2 inline-flex min-h-11 items-center text-sm text-(--info)"
                  >
                    Open Stories
                  </Link>
                </section>
              ) : (
                <ol aria-label="Pending stories" className="flex flex-col gap-4">
                  {result.data.items.map((item) => {
                    const target = storyHref(projectId, item.storyId);
                    const brief = item.plan?.decisionBrief;
                    const review = item.plan
                      ? storyReviewHref(projectId, item.storyId, {
                          revision: item.plan.revision,
                          digest: item.plan.digest,
                        })
                      : `${target}${item.delivery ? "#story-delivery" : "#story-attention"}`;
                    const kind = item.plan ? "Plan" : item.delivery ? "Delivery" : "Notice";
                    const tone = item.plan
                      ? "border-l-(--human)"
                      : item.delivery
                        ? "border-l-(--info)"
                        : "border-l-(--mut)";
                    return (
                      <li
                        key={item.storyId}
                        className={`min-w-0 border border-(--line) border-l-2 ${tone} bg-(--bg-subtle) p-4 sm:p-5`}
                      >
                        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <p className="mb-1 text-xs text-(--mut)">
                              {kind}
                              {item.plan ? ` · r${item.plan.revision}` : ""} ·{" "}
                              {relativeTime(item.waitingSince, now)}
                            </p>
                            <h2 className="break-words text-lg font-semibold">
                              <Link href={review}>{item.storyTitle}</Link>
                            </h2>
                            {brief?.status === "available" ? (
                              <p className="mt-2 line-clamp-2 break-words text-sm text-(--mut)">
                                {brief.brief.summary.text}
                              </p>
                            ) : null}
                            {!item.plan && item.delivery ? (
                              <p className="mt-2 text-sm text-(--mut)">
                                {item.delivery.blocked?.message ??
                                  `${item.delivery.candidate.requiredCount} required PRs · ${item.delivery.acceptance.status === "current" ? "Accepted" : "Awaiting review"}`}
                              </p>
                            ) : null}
                            {!item.plan && !item.delivery ? (
                              <p className="mt-2 text-sm text-(--mut)">
                                {item.noticeKinds
                                  .map(({ kind }) => attentionKindLabel(kind))
                                  .join(" · ")}
                              </p>
                            ) : null}
                          </div>
                          <Link href={review} className={`${control} w-fit shrink-0`}>
                            {item.plan
                              ? `Review plan r${item.plan.revision}`
                              : item.delivery
                                ? "Review delivery"
                                : "Open notices"}{" "}
                            <span aria-hidden="true" className="ml-2">
                              →
                            </span>
                          </Link>
                        </div>
                        {item.noticeCount > 0 && (item.plan || item.delivery) ? (
                          <Link
                            href={`${target}#story-attention`}
                            className="mt-2 inline-flex min-h-11 items-center text-xs text-(--mut) underline underline-offset-4"
                          >
                            {item.noticeCount} {item.noticeCount === 1 ? "notice" : "notices"}
                          </Link>
                        ) : null}
                        {item.delivery ? (
                          <details className="mt-2">
                            <summary className="min-h-11 cursor-pointer py-3 text-sm text-(--mut)">
                              Delivery details
                            </summary>
                            <DeliveryReview delivery={item.delivery} storyUrl={target} />
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
              <nav
                aria-label="Pending story pages"
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <p>
                  {result.data.items.length
                    ? `${offset + 1}–${offset + result.data.items.length}`
                    : "0"}{" "}
                  of {result.data.total} stories
                </p>
                <div className="flex gap-3">
                  {pageNumber > 1 ? (
                    <Link href={href(pageNumber - 1)} className={control}>
                      Previous
                    </Link>
                  ) : null}
                  {offset + result.data.items.length < result.data.total ? (
                    <Link href={href(pageNumber + 1)} className={control}>
                      Next
                    </Link>
                  ) : null}
                  {pageNumber > 1 && result.data.items.length === 0 ? (
                    <Link href={href(1)} className={control}>
                      First page
                    </Link>
                  ) : null}
                </div>
              </nav>
            </>
          ) : null}
          {query.category === "pulls" ||
          (query.category === "all" && result.data.otherPullRequests?.total !== 0) ? (
            <OtherPullReviews
              data={result.data.otherPullRequests}
              projectId={projectId}
              page={pullPage}
              href={(page) => `${href(pageNumber, page)}#other-pull-requests`}
            />
          ) : null}
          <details className="text-xs text-(--mut)">
            <summary className="min-h-11 cursor-pointer py-3">Queue details</summary>
            {!projectNeedsAttention ? <ProjectConditions data={result.data} base={base} /> : null}
            {query.category !== "pulls" ? (
              <p className="text-sm text-(--mut)" role="status">
                {result.data.counts.stories}{" "}
                {result.data.counts.stories === 1 ? "story" : "stories"} ·{" "}
                {result.data.counts.plans} pending{" "}
                {result.data.counts.plans === 1 ? "plan" : "plans"} · {result.data.counts.notices}{" "}
                open {result.data.counts.notices === 1 ? "notice" : "notices"} ·{" "}
                {result.data.counts.deliveries}{" "}
                {result.data.counts.deliveries === 1 ? "delivery" : "deliveries"}
                {q || query.category !== "all" ? " in matching stories" : ""}.
              </p>
            ) : null}
            <p className="text-xs text-(--mut)">
              Updated {relativeTime(result.data.generatedAt, now)}.{" "}
              <a
                href={href(pageNumber)}
                className="inline-flex min-h-11 items-center underline underline-offset-4"
              >
                Refresh this view
              </a>
            </p>
          </details>
        </>
      )}
    </div>
  );
}
