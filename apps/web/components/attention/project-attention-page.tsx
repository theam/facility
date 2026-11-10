import { buttonClassName } from "@facility/ui";
import Link from "next/link";
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
  const control = buttonClassName();
  const filtered = !!q || query.category !== "all";
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Attention</h1>
        {result.ok && query.category !== "pulls" ? (
          <p className="text-sm text-(--mut)" role="status">
            {result.data.counts.stories === 0
              ? filtered
                ? "Nothing matches these filters."
                : "Nothing needs you right now."
              : [
                  plural(result.data.counts.stories, "story", "stories"),
                  plural(result.data.counts.plans, "pending plan", "pending plans"),
                  plural(result.data.counts.notices, "open notice", "open notices"),
                  ...(result.data.counts.deliveries
                    ? [plural(result.data.counts.deliveries, "delivery", "deliveries")]
                    : []),
                ].join(" · ")}
            {filtered && result.data.counts.stories > 0 ? " in matching stories" : ""}
            {filtered ? (
              <>
                {" · "}
                <Link href={base} className="text-(--info) underline underline-offset-4">
                  Clear filters
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </header>
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
                <section className="flex flex-col gap-1 py-2">
                  <h2 className="font-medium">
                    {result.data.total > 0
                      ? "No stories on this page"
                      : filtered
                        ? "No matching pending stories"
                        : "No pending plans, notices or deliveries"}
                  </h2>
                  <Link
                    href={`${base}/stories`}
                    className="inline-flex min-h-11 w-fit items-center text-sm text-(--info) underline underline-offset-4"
                  >
                    Open Stories
                  </Link>
                </section>
              ) : (
                <ol aria-label="Pending stories" className="flex flex-col border-t border-(--line)">
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
                      ? "bg-(--human)"
                      : item.delivery
                        ? "bg-(--info)"
                        : "bg-(--mut)";
                    const summary =
                      brief?.status === "available"
                        ? brief.brief.summary.text
                        : !item.plan && item.delivery
                          ? (item.delivery.blocked?.message ??
                            `${item.delivery.candidate.requiredCount} required PRs · ${item.delivery.acceptance.status === "current" ? "Accepted" : "Awaiting review"}`)
                          : !item.plan && !item.delivery
                            ? item.noticeKinds
                                .map(({ kind }) => attentionKindLabel(kind))
                                .join(" · ")
                            : null;
                    const action = item.plan
                      ? `Review plan r${item.plan.revision}`
                      : item.delivery
                        ? "Review delivery"
                        : "Open notices";
                    return (
                      <li
                        key={item.storyId}
                        className="flex min-w-0 gap-3 border-b border-(--line) py-4"
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-[7px] size-2 shrink-0 rounded-full ${tone}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-(--mut)">
                            {kind}
                            {item.plan ? ` · r${item.plan.revision}` : ""} ·{" "}
                            {relativeTime(item.waitingSince, now)}
                            {item.noticeCount > 0 && (item.plan || item.delivery) ? (
                              <>
                                {" · "}
                                <Link
                                  href={`${target}#story-attention`}
                                  className="underline underline-offset-4 hover:text-(--ink)"
                                >
                                  {plural(item.noticeCount, "notice", "notices")}
                                </Link>
                              </>
                            ) : null}
                          </p>
                          <h2 className="mt-0.5 break-words font-medium">
                            <Link href={review} className="hover:underline">
                              {item.storyTitle}
                            </Link>
                          </h2>
                          {summary ? (
                            <p className="mt-1 line-clamp-2 break-words text-sm text-(--mut)">
                              {summary}
                            </p>
                          ) : null}
                          <Link
                            href={review}
                            className="mt-1 inline-flex min-h-11 items-center text-sm text-(--info) hover:underline sm:hidden"
                          >
                            {action}
                            <span aria-hidden="true" className="ml-1.5">
                              →
                            </span>
                          </Link>
                        </div>
                        <Link
                          href={review}
                          className="hidden min-h-11 shrink-0 items-center self-center text-sm text-(--info) hover:underline sm:inline-flex"
                        >
                          {action}
                          <span aria-hidden="true" className="ml-1.5">
                            →
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              )}
              {pageNumber > 1 || offset + result.data.items.length < result.data.total ? (
                <nav
                  aria-label="Pending story pages"
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <p className="text-(--mut)">
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
              ) : null}
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
        </>
      )}
      <footer className="flex flex-col gap-1 text-[12px] text-(--mut)">
        <details open={filtered}>
          <summary className="min-h-11 w-fit cursor-pointer py-3">Search and filter</summary>
          <form
            method="get"
            action={`${base}`}
            aria-label="Find stories and pull requests"
            className="flex flex-col gap-3 pb-3 sm:flex-row sm:flex-wrap sm:items-end"
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
          </form>
        </details>
        <nav aria-label="Related project views" className="flex flex-wrap gap-x-4">
          <Link
            href={`${base}/stories`}
            className="inline-flex min-h-11 items-center hover:text-(--ink)"
          >
            All stories
          </Link>
          <Link
            href={`${base}/attention`}
            className="inline-flex min-h-11 items-center hover:text-(--ink)"
          >
            All notices
          </Link>
          <Link
            href={`${base}/attention?status=resolved`}
            className="inline-flex min-h-11 items-center hover:text-(--ink)"
          >
            Resolved notices
          </Link>
          <Link
            href={`${base}/activity`}
            className="inline-flex min-h-11 items-center hover:text-(--ink)"
          >
            Activity
          </Link>
        </nav>
        {result.ok ? (
          <p>
            Updated {relativeTime(result.data.generatedAt, now)} ·{" "}
            <a
              href={href(pageNumber)}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Refresh this view
            </a>
          </p>
        ) : null}
      </footer>
    </div>
  );
}
