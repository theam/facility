import { cx, Eyebrow } from "@facility/ui";
import Link from "next/link";
import { AttentionRow } from "@/components/attention/attention-row";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, type ProjectAttention } from "@/lib/api";
import {
  ATTENTION_PAGE_SIZE,
  type AttentionSearch,
  attentionHref,
  isFiltered,
  parseAttentionSearch,
  toAttentionQuery,
  toggleKind,
} from "@/lib/attention-presentation";
import { attentionKindLabel, attentionNotice, attentionSignals } from "@/lib/overview-presentation";
import { can } from "@/lib/permissions";

export const metadata = { title: "attention" };

/**
 * Everything the project raised for a person, newest first. The overview shows
 * the latest few; this page is where all of them can be read, searched and
 * handled. Reading it never wakes a machine or starts an agent.
 */
export default async function ProjectAttentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, rawSearch] = await Promise.all([params, searchParams]);
  const search = parseAttentionSearch(rawSearch);
  // Failing checks and budget alerts are live state, not stored notices. They
  // lead the unfiltered open view so it holds everything the overview counts.
  const withSignals = search.status === "open" && !isFiltered(search) && search.page === 1;
  const [result, me, overview] = await Promise.all([
    api.projectAttention(projectId, toAttentionQuery(search)),
    api.me(),
    withSignals ? api.projectOverview(projectId) : null,
  ]);
  if (!result.ok && result.offline) return <Offline />;

  const now = new Date();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const canExecute = me.ok && can(me.data.permissions, "workspaces:execute");
  const signals = overview?.ok ? attentionSignals(overview.data, projectId) : [];
  const page = result.ok ? result.data : null;
  const entries = page ? page.items.map((item) => attentionNotice(item, projectId)) : [];
  const total = page?.total ?? 0;
  const first = entries.length === 0 ? 0 : (search.page - 1) * ATTENTION_PAGE_SIZE + 1;
  const last = first === 0 ? 0 : first + entries.length - 1;
  const lastPage = Math.max(1, Math.ceil(total / ATTENTION_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh seconds={15} />
      <header className="flex flex-col gap-1.5">
        <Link href={base} className="w-fit text-[12px] text-(--mut) hover:text-(--ink)">
          ← Overview
        </Link>
        <Eyebrow>attention</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
          Needs your attention
        </h1>
        {page ? (
          <p className="text-[12.5px] text-(--mut)">{headerLine(page, signals.length, search)}</p>
        ) : null}
      </header>

      {page ? (
        <div className="flex flex-col gap-3">
          <StatusTabs projectId={projectId} search={search} counts={page.counts} />
          <form
            method="get"
            action={`${base}/attention`}
            aria-label="Search notices"
            className="flex flex-wrap items-center gap-2"
          >
            {search.status !== "open" ? (
              <input type="hidden" name="status" value={search.status} />
            ) : null}
            {search.kind.map((kind) => (
              <input key={kind} type="hidden" name="kind" value={kind} />
            ))}
            <label htmlFor="attention-search" className="sr-only">
              Search notices and stories
            </label>
            <input
              id="attention-search"
              type="search"
              name="q"
              defaultValue={search.q}
              placeholder="Search notices and stories"
              className="h-9 w-full min-w-0 border border-(--line) bg-(--bg-subtle) px-3 text-[13px] text-(--ink) placeholder:text-(--dim) hover:border-(--line-strong) sm:w-72"
            />
            <button
              type="submit"
              className="h-9 border border-(--line) px-3 text-[12px] text-(--mut) hover:text-(--ink)"
            >
              Search
            </button>
            {isFiltered(search) ? (
              <Link
                href={attentionHref(projectId, search, { q: "", kind: [], page: 1 })}
                className="text-[12px] text-(--info) underline-offset-4 hover:underline"
              >
                Clear filters
              </Link>
            ) : null}
          </form>
          <KindChips projectId={projectId} search={search} kinds={page.facets.kinds} />
        </div>
      ) : null}

      {withSignals && signals.length > 0 ? (
        <section
          aria-label="Also waiting on you"
          className="border border-(--bad)/50 bg-(--bg-subtle) px-5 pt-4 sm:px-6"
        >
          <h2 className="font-semibold">Also waiting on you · {signals.length}</h2>
          <p className="mt-1 text-[12px] text-(--dim)">
            Live state from pull requests and the budget. These clear on their own once the checks
            pass or the budget allows new turns.
          </p>
          <div className="mt-3 flex flex-col">
            {signals.map((entry) => (
              <AttentionRow
                key={entry.key}
                entry={entry}
                projectId={projectId}
                now={now}
                canExecute={canExecute}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Notices" className="flex flex-col gap-3">
        {!result.ok ? (
          <ErrorNotice message={`Couldn't load the notices — ${result.message}`} />
        ) : entries.length === 0 ? (
          <EmptyState projectId={projectId} search={search} total={total} />
        ) : (
          <>
            <div className="flex flex-col border-b border-(--line)">
              {entries.map((entry) => (
                <AttentionRow
                  key={entry.key}
                  entry={entry}
                  projectId={projectId}
                  now={now}
                  canExecute={canExecute}
                />
              ))}
            </div>
            <nav
              aria-label="Notice pages"
              className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-(--mut)"
            >
              <span>
                Showing {first}–{last} of {total}
              </span>
              <span className="flex items-center gap-3">
                {search.page > 1 ? (
                  <Link
                    href={attentionHref(projectId, search, { page: search.page - 1 })}
                    className="border border-(--line) px-3 py-1.5 hover:text-(--ink)"
                  >
                    ← Newer
                  </Link>
                ) : null}
                <span className="font-mono text-(--dim)">
                  page {search.page} / {lastPage}
                </span>
                {search.page < lastPage ? (
                  <Link
                    href={attentionHref(projectId, search, { page: search.page + 1 })}
                    className="border border-(--line) px-3 py-1.5 hover:text-(--ink)"
                  >
                    Older →
                  </Link>
                ) : null}
              </span>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}

function headerLine(page: ProjectAttention, signals: number, search: AttentionSearch) {
  if (isFiltered(search)) {
    return `${page.total} ${search.status} ${page.total === 1 ? "notice matches" : "notices match"}`;
  }
  const parts = [
    page.counts.open === 0
      ? "No open notices"
      : `${page.counts.open} open ${page.counts.open === 1 ? "notice" : "notices"}`,
    signals > 0 ? `${signals} from pull requests and the budget` : null,
    `${page.counts.resolved} resolved`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function StatusTabs({
  projectId,
  search,
  counts,
}: {
  projectId: string;
  search: AttentionSearch;
  counts: ProjectAttention["counts"];
}) {
  const tabs = [
    { value: "open" as const, label: "Open", count: counts.open },
    { value: "resolved" as const, label: "Resolved", count: counts.resolved },
  ];
  return (
    <nav aria-label="Notice status" className="flex flex-wrap gap-1.5">
      {tabs.map((tab) => (
        <Link
          key={tab.value}
          href={attentionHref(projectId, search, { status: tab.value, page: 1 })}
          aria-current={search.status === tab.value ? "page" : undefined}
          className={chipClass(search.status === tab.value)}
        >
          {tab.label}
          <span className="font-mono text-[10.5px] text-(--dim)">{tab.count}</span>
        </Link>
      ))}
    </nav>
  );
}

function KindChips({
  projectId,
  search,
  kinds,
}: {
  projectId: string;
  search: AttentionSearch;
  kinds: ProjectAttention["facets"]["kinds"];
}) {
  // A selected kind with no matches left still needs a chip to unselect it.
  const shown = [
    ...kinds,
    ...search.kind
      .filter((kind) => !kinds.some((facet) => facet.kind === kind))
      .map((kind) => ({ kind, count: 0 })),
  ];
  if (shown.length <= 1 && search.kind.length === 0) return null;
  return (
    <nav aria-label="Notice kind" className="flex flex-wrap gap-1.5">
      <Link
        href={attentionHref(projectId, search, { kind: [], page: 1 })}
        aria-current={search.kind.length === 0 ? "page" : undefined}
        className={chipClass(search.kind.length === 0)}
      >
        All kinds
      </Link>
      {shown.map((facet) => {
        const selected = search.kind.includes(facet.kind);
        return (
          <Link
            key={facet.kind}
            href={attentionHref(projectId, search, {
              kind: toggleKind(search, facet.kind),
              page: 1,
            })}
            aria-pressed={selected}
            className={chipClass(selected)}
          >
            {attentionKindLabel(facet.kind)}
            <span className="font-mono text-[10.5px] text-(--dim)">{facet.count}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function chipClass(selected: boolean) {
  return cx(
    "inline-flex h-8 items-center gap-1.5 border px-2.5 text-[12px] transition-colors",
    selected
      ? "border-(--line-strong) text-(--ink)"
      : "border-(--line) text-(--mut) hover:text-(--ink)",
  );
}

function EmptyState({
  projectId,
  search,
  total,
}: {
  projectId: string;
  search: AttentionSearch;
  total: number;
}) {
  // Handling the last notices of the last page leaves it empty while earlier
  // pages still hold some.
  if (total > 0) {
    return (
      <div className="flex flex-col items-start gap-3 border border-(--line) p-8 text-sm text-(--dim)">
        <p>No notices left on this page.</p>
        <Link
          href={attentionHref(projectId, search, { page: 1 })}
          className="text-(--info) underline-offset-4 hover:underline"
        >
          Back to the newest
        </Link>
      </div>
    );
  }
  if (isFiltered(search)) {
    return (
      <div className="flex flex-col items-start gap-3 border border-(--line) p-8 text-sm text-(--dim)">
        <p>Nothing matches these filters.</p>
        <Link
          href={attentionHref(projectId, search, { q: "", kind: [], page: 1 })}
          className="text-(--info) underline-offset-4 hover:underline"
        >
          Show every {search.status} notice
        </Link>
      </div>
    );
  }
  return (
    <p className="border border-(--line) p-8 text-sm leading-relaxed text-(--dim)">
      {search.status === "open"
        ? "No open notices. When an agent asks a question or a run fails, it appears here with the action that handles it."
        : "No resolved notices yet. Answered, retried and dismissed notices are kept here."}
    </p>
  );
}
