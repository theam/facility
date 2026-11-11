import { buttonClassName } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { BacklogFilters } from "@/components/story/backlog-filters";
import { BacklogList, PhaseChips, WorkGroups } from "@/components/story/backlog-list";
import { NewStory } from "@/components/story/new-story";
import { SyncGithub } from "@/components/story/sync-github";
import { api } from "@/lib/api";
import {
  activeFilterCount,
  agentChoices,
  PAGE_SIZE,
  parseStoriesSearch,
  startTarget,
  storiesHref,
  toBacklogQuery,
} from "@/lib/backlog-presentation";
import { can } from "@/lib/permissions";

export const metadata = { title: "stories" };

/**
 * Stories is the project's backlog: GitHub issues nobody has started, work
 * started from a request, and everything in between. Reading it never wakes a
 * machine or starts an agent; starting work is always an explicit action.
 */
export default async function ProjectStoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, rawSearch] = await Promise.all([params, searchParams]);
  const search = parseStoriesSearch(rawSearch);
  const [initialBacklog, agentsResult, me] = await Promise.all([
    api.projectBacklog(projectId, toBacklogQuery(search)),
    api.storyAgents(projectId),
    api.me(),
  ]);
  const legacyFallback =
    !initialBacklog.ok &&
    initialBacklog.status === 400 &&
    (search.sort === "activity" || !!search.group);
  const backlog = legacyFallback
    ? await api.projectBacklog(projectId, {
        ...toBacklogQuery(search),
        group: undefined,
        sort: search.sort === "activity" ? "priority" : search.sort,
      })
    : initialBacklog;
  if (!backlog.ok && backlog.offline) return <Offline />;

  const now = new Date();
  const permissions = me.ok ? me.data.permissions : [];
  const canStart = can(permissions, "workspaces:execute");
  const canSync = can(permissions, "github:write");
  const viewer = {
    userId: me.ok ? (me.data.principal.userId ?? me.data.principal.id) : null,
    githubLogin: me.ok ? (me.data.principal.githubLogin ?? null) : null,
  };
  const agents = agentsResult.ok ? agentsResult.data : null;
  const choices = agents ? agentChoices(agents.agents, agents.defaults.ui) : [];
  const items = backlog.ok ? backlog.data.items : [];
  const counts = backlog.ok
    ? backlog.data.counts
    : { not_started: 0, in_progress: 0, attention: 0, review: 0, done: 0, archived: 0 };
  const total = backlog.ok ? backlog.data.total : 0;
  const first = total === 0 || items.length === 0 ? 0 : (search.page - 1) * PAGE_SIZE + 1;
  const last = first === 0 ? 0 : first + items.length - 1;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const linked = startTarget(search.start, items);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6">
      <LiveRefresh seconds={15} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Stories</h1>
          <p className="text-[12.5px] text-(--mut)">
            {backlog.ok
              ? `${total} matching record${total === 1 ? "" : "s"}`
              : "Backlog unavailable"}
            {backlog.ok && !backlog.data.groupCounts && counts.attention > 0
              ? ` · ${counts.attention} need attention`
              : null}
          </p>
        </div>
        {canSync ? <SyncGithub projectId={projectId} /> : null}
      </header>

      {canStart ? (
        agents ? (
          <NewStory
            projectId={projectId}
            agents={choices}
            defaultAgent={agents.defaults.ui}
            titleGeneration={agents.title_generation}
            linked={
              linked?.issue
                ? {
                    key: linked.key,
                    title: linked.title,
                    number: linked.issue.number,
                    repository: linked.issue.repository,
                    repositoryId: linked.issue.repositoryId,
                    url: linked.issue.url,
                  }
                : null
            }
            clearHref={`${storiesHref(projectId, search)}#new-story`}
          />
        ) : (
          <ErrorNotice
            message={`Couldn't load the project's agents — ${agentsResult.ok ? "" : agentsResult.message}`}
          />
        )
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Backlog">
        {backlog.ok ? (
          <>
            {legacyFallback ? (
              <p role="status" className="text-sm text-(--mut)">
                This server could not apply work groups. Showing the recorded backlog with the other
                filters.
              </p>
            ) : null}
            <WorkGroups projectId={projectId} search={search} counts={backlog.data.groupCounts} />
            <p className="text-xs text-(--mut)">
              Counts include every matching record, across pages. Last checked{" "}
              <time dateTime={backlog.data.generatedAt}>
                {new Date(backlog.data.generatedAt).toLocaleString("en-GB", { timeZone: "UTC" })}{" "}
                UTC
              </time>
              .
            </p>
            <details>
              <summary className="min-h-11 cursor-pointer py-3 text-sm text-(--mut)">
                Browse phases, completed work and archives
              </summary>
              <PhaseChips projectId={projectId} search={search} counts={counts} />
            </details>
          </>
        ) : null}
        {backlog.ok ? (
          <BacklogFilters
            projectId={projectId}
            search={search}
            facets={backlog.data.facets}
            viewer={viewer}
          />
        ) : null}

        {!backlog.ok ? (
          <ErrorNotice message={`Couldn't load the backlog — ${backlog.message}`} />
        ) : items.length === 0 ? (
          <EmptyState
            projectId={projectId}
            filtered={activeFilterCount(search) > 0 || search.phase.length > 0 || !!search.group}
            hasAnything={Object.values(counts).some((count) => count > 0)}
            search={search}
          />
        ) : (
          <>
            <BacklogList
              projectId={projectId}
              items={items}
              search={search}
              counts={counts}
              groupCounts={backlog.ok ? backlog.data.groupCounts : undefined}
              canStart={canStart}
              now={now}
            />
            <nav
              aria-label="Backlog pages"
              className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-(--mut)"
            >
              <span>
                Showing {first}–{last} of {total}
              </span>
              <span className="flex items-center gap-3">
                {search.page > 1 ? (
                  <Link
                    href={storiesHref(projectId, search, { page: search.page - 1 })}
                    className={buttonClassName()}
                  >
                    ← Newer
                  </Link>
                ) : null}
                <span className="font-mono text-(--dim)">
                  page {search.page} / {lastPage}
                </span>
                {search.page < lastPage ? (
                  <Link
                    href={storiesHref(projectId, search, { page: search.page + 1 })}
                    className={buttonClassName()}
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

function EmptyState({
  projectId,
  filtered,
  hasAnything,
  search,
}: {
  projectId: string;
  filtered: boolean;
  hasAnything: boolean;
  search: ReturnType<typeof parseStoriesSearch>;
}) {
  if (filtered && hasAnything) {
    return (
      <div className="flex flex-col items-start gap-3 py-6 text-sm text-(--dim)">
        <p>Nothing matches these filters.</p>
        <Link
          href={storiesHref(projectId, search, {
            q: "",
            phase: [],
            label: [],
            assignee: [],
            repository: [],
            page: 1,
          })}
          className="text-(--info) underline-offset-4 hover:underline"
        >
          Show all open work
        </Link>
      </div>
    );
  }
  return (
    <div className="py-6 text-sm leading-relaxed text-(--dim)">
      <p>No work here yet.</p>
      <p className="mt-2">
        Describe what you need above to start a story, or connect a GitHub repository in{" "}
        <Link
          href={`/projects/${encodeURIComponent(projectId)}/settings`}
          className="text-(--info) underline-offset-4 hover:underline"
        >
          settings
        </Link>{" "}
        so its open issues appear as work to pick up.
      </p>
    </div>
  );
}
