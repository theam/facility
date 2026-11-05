import Link from "next/link";
import { DeliveryReview } from "@/components/attention/delivery-review";
import { OtherPullReviews } from "@/components/attention/other-pull-reviews";
import { ProjectConditions } from "@/components/attention/project-conditions";
import { ErrorNotice, Offline } from "@/components/offline";
import { DecisionBrief } from "@/components/story/decision-brief";
import { type AttentionStoriesQuery, api } from "@/lib/api";
import { attentionKindLabel, relativeTime, storyHref } from "@/lib/overview-presentation";

export const metadata = { title: "next review" };

/** Shared snapshot with independent pages for whole stories and other open PRs.
 * Keep this pilot until exact decision navigation and the project entry are ready. */
export default async function AttentionReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
    return `${base}/attention/review${search.size ? `?${search}` : ""}`;
  };
  const now = new Date();
  const control =
    "inline-flex min-h-11 items-center border border-(--line) px-3 text-sm text-(--ink) hover:bg-(--card)";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs text-(--mut)">Attention · preview</p>
        <h1 className="text-3xl font-semibold tracking-tight">Attention</h1>
        <p className="max-w-2xl text-sm text-(--mut)">
          Plans, notices and delivery sets, grouped by story, with other open PRs alongside them.
          Each decision keeps its own review and confirmation.
        </p>
        <nav aria-label="Related project views" className="flex flex-wrap gap-3">
          <Link href={base} className={control}>
            Project overview
          </Link>
          <Link href={`${base}/attention?status=resolved`} className={control}>
            Resolved notices
          </Link>
          <Link href={`${base}/stories`} className={control}>
            All stories
          </Link>
        </nav>
      </header>
      {result.ok ? <ProjectConditions data={result.data} base={base} /> : null}
      <h2 className="text-xl font-semibold">Next review</h2>
      <form
        method="get"
        action={`${base}/attention/review`}
        aria-label="Find stories and pull requests"
        className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm" htmlFor="review-search">
          Story, notice or PR text
          <input
            id="review-search"
            type="search"
            name="q"
            defaultValue={q}
            className="min-h-11 min-w-0 border border-(--line) bg-(--bg-subtle) px-3 text-(--ink)"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="review-category">
          Show
          <select
            id="review-category"
            name="category"
            defaultValue={query.category}
            className="min-h-11 border border-(--line) bg-(--bg-subtle) px-3 text-(--ink)"
          >
            <option value="all">Stories and other PRs</option>
            <option value="plans">Stories with pending plans</option>
            <option value="notices">Stories with open notices</option>
            <option value="deliveries">Stories with deliveries</option>
            <option value="pulls">Other open PRs</option>
          </select>
        </label>
        <button type="submit" className={control}>
          Apply
        </button>
        {q || query.category !== "all" ? (
          <Link href={`${base}/attention/review`} className={control}>
            Clear filters
          </Link>
        ) : null}
      </form>
      {!result.ok ? (
        <ErrorNotice message={`Couldn't load pending stories — ${result.message}`} />
      ) : (
        <>
          {query.category !== "pulls" ? (
            <p className="text-sm text-(--mut)" role="status">
              {result.data.counts.stories} stories · {result.data.counts.plans} pending plans ·{" "}
              {result.data.counts.notices} open notices · {result.data.counts.deliveries} deliveries
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
                  <p className="mt-2 text-sm text-(--mut)">
                    Other open PRs have their own list below when selected. Open Stories to follow
                    ongoing work.
                  </p>
                </section>
              ) : (
                <ol aria-label="Pending stories" className="flex flex-col gap-4">
                  {result.data.items.map((item) => {
                    const target = storyHref(projectId, item.storyId);
                    const brief = item.plan?.decisionBrief;
                    return (
                      <li
                        key={item.storyId}
                        className="min-w-0 border border-(--line) bg-(--bg-subtle) p-5 sm:p-6"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="break-words text-lg font-semibold">
                              <Link href={target}>{item.storyTitle}</Link>
                            </h2>
                            <p className="mt-1 text-xs text-(--mut)">
                              Story: {item.storyStatus} · Pending since{" "}
                              {relativeTime(item.waitingSince, now)}
                            </p>
                          </div>
                          {item.plan || !item.delivery ? (
                            <Link
                              href={`${target}${item.plan ? "#story-plan" : "#story-attention"}`}
                              className={control}
                            >
                              {item.plan
                                ? "Open current plan"
                                : item.delivery
                                  ? "Open delivery"
                                  : "Open notices"}
                            </Link>
                          ) : null}
                        </div>
                        {item.plan ? (
                          <div className="mt-4 flex flex-col gap-3">
                            <p className="text-sm font-medium">
                              Plan r{item.plan.revision} awaits review
                            </p>
                            {brief?.status === "available" ? (
                              <>
                                <p className="break-words text-sm">{brief.brief.summary.text}</p>
                                <details>
                                  <summary className="min-h-11 cursor-pointer py-3 text-sm text-(--info)">
                                    Author’s recommendation, alternatives and sources
                                  </summary>
                                  <div className="border-t border-(--line) pt-4">
                                    <DecisionBrief
                                      key={item.plan.digest}
                                      brief={brief.brief}
                                      revision={item.plan.revision}
                                    />
                                  </div>
                                </details>
                              </>
                            ) : (
                              <p className="text-sm text-(--mut)">
                                {brief?.status === "invalid"
                                  ? "The author’s brief could not be read."
                                  : "No structured brief was supplied."}{" "}
                                Open the plan to read the original.
                              </p>
                            )}
                            <p className="text-xs text-(--mut)">
                              Observed revision r{item.plan.revision}. Opening the story reads its
                              current plan; confirm the revision before deciding.
                            </p>
                          </div>
                        ) : null}
                        {item.delivery ? (
                          <DeliveryReview delivery={item.delivery} storyUrl={target} />
                        ) : null}
                        {item.noticeCount > 0 ? (
                          <div className="mt-4 border-t border-(--line) pt-3 text-sm">
                            <p>
                              {item.noticeCount} open{" "}
                              {item.noticeCount === 1 ? "notice" : "notices"}
                            </p>
                            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-(--mut)">
                              {item.noticeKinds.map(({ kind, count }) => (
                                <li key={kind}>
                                  {attentionKindLabel(kind)} · {count}
                                </li>
                              ))}
                            </ul>
                            {item.plan ? (
                              <Link
                                href={`${target}#story-attention`}
                                className="mt-2 inline-flex min-h-11 items-center text-(--info) underline underline-offset-4"
                              >
                                Open notices
                              </Link>
                            ) : null}
                          </div>
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
          {query.category === "all" || query.category === "pulls" ? (
            <OtherPullReviews
              data={result.data.otherPullRequests}
              projectId={projectId}
              page={pullPage}
              href={(page) => `${href(pageNumber, page)}#other-pull-requests`}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
