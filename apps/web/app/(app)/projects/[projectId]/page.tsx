import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { AttentionActions } from "@/components/story/attention-actions";
import { CancelTurnButton } from "@/components/story/workspace-story-controls";
import {
  api,
  type OverviewActiveTurn,
  type OverviewBacklogStory,
  type OverviewRecentTurn,
  type OverviewReviewItem,
  type ProjectOverview,
} from "@/lib/api";
import {
  type AttentionEntry,
  activitySummary,
  attentionQueue,
  budgetReading,
  duration,
  environmentsLine,
  money,
  monthLabel,
  relativeTime,
  reviewState,
  spendReading,
  storyHref,
  storySource,
  triggerLabel,
  turnResult,
} from "@/lib/overview-presentation";
import { can } from "@/lib/permissions";
import { errorSummary, safeExternalUrl } from "@/lib/story-presentation";

export const metadata = { title: "overview" };

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, overviewResult, repos, me] = await Promise.all([
    api.project(projectId),
    api.projectOverview(projectId),
    api.projectRepos(projectId),
    api.me(),
  ]);
  if (!project.ok) {
    return project.offline ? <Offline /> : <ErrorNotice message={project.message} />;
  }
  const now = new Date();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const canExecute = me.ok && can(me.data.permissions, "workspaces:execute");
  const overview = overviewResult.ok ? overviewResult.data : null;
  const activity = overview ? activitySummary(overview.activity) : null;
  const attention = overview ? attentionQueue(overview, projectId) : [];

  return (
    <div className="flex flex-col gap-10">
      <LiveRefresh seconds={10} />
      <header className="flex flex-col gap-3">
        <Eyebrow>overview</Eyebrow>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[clamp(24px,3.2vw,36px)] font-semibold tracking-tight">
            {project.data.name}
          </h1>
          {activity ? (
            <span className="inline-flex items-center gap-2 text-[12px] text-(--mut)">
              <StatusDot tone={activity.active ? "agent" : "machine"} pulse={activity.active} />
              {activity.label}
            </span>
          ) : null}
        </div>
        {project.data.description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-(--mut)">
            {project.data.description}
          </p>
        ) : null}
        {repos.ok && repos.data.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {repos.data.map((repo) => (
              <a
                key={repo.id}
                href={`https://github.com/${repo.owner}/${repo.name}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11.5px] text-(--info) underline-offset-4 hover:underline"
              >
                {repo.owner}/{repo.name} ↗
              </a>
            ))}
          </div>
        ) : null}
        {overview ? <SummaryLine overview={overview} attention={attention.length} /> : null}
      </header>

      {!overview ? (
        overviewResult.ok ? null : overviewResult.offline ? (
          <Offline />
        ) : (
          <ErrorNotice message={`Couldn't load the overview — ${overviewResult.message}`} />
        )
      ) : (
        <>
          <section
            aria-label="Needs your attention"
            className={
              attention.length > 0
                ? "border border-(--bad)/50 bg-(--bg-subtle) p-5 sm:p-6"
                : "border border-(--line) p-5 sm:p-6"
            }
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-semibold">
                Needs your attention{attention.length > 0 ? ` · ${attention.length}` : ""}
              </h2>
              {overview.attention.openCount > overview.attention.items.length ? (
                <Link href={`${base}/stories?status=attention`} className={linkClass}>
                  All {overview.attention.openCount} open notices →
                </Link>
              ) : null}
            </div>
            {attention.length === 0 ? (
              <p className="mt-2 text-sm text-(--dim)">
                Nothing is waiting on you. Resolved and dismissed notices stay in each story's
                history.
              </p>
            ) : (
              <div className="mt-4 flex flex-col">
                {attention.map((entry) => (
                  <AttentionRow
                    key={entry.key}
                    entry={entry}
                    projectId={projectId}
                    now={now}
                    canExecute={canExecute}
                  />
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Running now"
              count={overview.activity.running.length + overview.activity.queued.length}
              aside={
                <Link href={`${base}/stories?status=working`} className={linkClass}>
                  Working stories →
                </Link>
              }
            >
              {overview.activity.running.length === 0 && overview.activity.queued.length === 0 ? (
                <Empty>
                  No agent is running.
                  {overview.backlog.counts.working +
                    overview.backlog.counts.attention +
                    overview.backlog.counts.review >
                  0
                    ? " Open stories are waiting for a person, not for an agent."
                    : ""}
                </Empty>
              ) : (
                <>
                  {overview.activity.running.map((turn) => (
                    <ActiveTurnRow
                      key={turn.turnId}
                      turn={turn}
                      projectId={projectId}
                      now={now}
                      canExecute={canExecute}
                    />
                  ))}
                  {overview.activity.queued.map((turn) => (
                    <ActiveTurnRow
                      key={turn.turnId}
                      turn={turn}
                      projectId={projectId}
                      now={now}
                      canExecute={canExecute}
                    />
                  ))}
                </>
              )}
            </Panel>

            <Panel
              title="Waiting for review"
              count={overview.review.total}
              aside={
                <Link href={`${base}/pipeline`} className={linkClass}>
                  Pipeline →
                </Link>
              }
            >
              {overview.review.items.length === 0 ? (
                <Empty>No open pull requests are linked to this project.</Empty>
              ) : (
                overview.review.items.map((item) => (
                  <ReviewRow
                    key={`${item.pullRequest.repository}#${item.pullRequest.number}`}
                    item={item}
                    projectId={projectId}
                    now={now}
                  />
                ))
              )}
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Recent results" count={overview.recent.items.length}>
              {overview.recent.items.length === 0 ? (
                <Empty>No agent run has finished yet.</Empty>
              ) : (
                overview.recent.items.map((turn) => (
                  <RecentRow key={turn.turnId} turn={turn} projectId={projectId} now={now} />
                ))
              )}
            </Panel>

            <Panel
              title="Backlog"
              count={overview.backlog.counts.ready}
              aside={
                <span className="flex flex-wrap gap-4">
                  <Link href={`${base}/stories`} className={linkClass}>
                    All stories →
                  </Link>
                  <Link href={`${base}/pipeline`} className={linkClass}>
                    Issues →
                  </Link>
                </span>
              }
            >
              <p className="border-b border-(--line) px-4 py-3 text-[12px] text-(--mut)">
                {backlogLine(overview.backlog)}
              </p>
              {overview.backlog.ready.length === 0 ? (
                <Empty>
                  No story is waiting to start.{" "}
                  <Link href={`${base}/stories`} className="text-(--info) hover:underline">
                    Start one from the Stories page
                  </Link>
                  .
                </Empty>
              ) : (
                overview.backlog.ready.map((story) => (
                  <BacklogRow key={story.storyId} story={story} projectId={projectId} now={now} />
                ))
              )}
            </Panel>
          </div>

          <SpendSection overview={overview} base={base} now={now} />
        </>
      )}
    </div>
  );
}

const linkClass = "text-[12px] text-(--mut) hover:text-(--ink)";

function SummaryLine({ overview, attention }: { overview: ProjectOverview; attention: number }) {
  const parts = [
    attention > 0
      ? `${attention} ${attention === 1 ? "item needs" : "items need"} your attention`
      : null,
    overview.review.total > 0
      ? `${overview.review.total} pull ${overview.review.total === 1 ? "request" : "requests"} waiting for review`
      : null,
    overview.backlog.counts.ready > 0
      ? `${overview.backlog.counts.ready} ${overview.backlog.counts.ready === 1 ? "story" : "stories"} ready to start`
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <p className="text-[13px] text-(--mut)">
      {parts.length === 0 ? "Nothing is waiting on you right now." : parts.join(" · ")}
    </p>
  );
}

function Panel({
  title,
  count,
  aside,
  children,
}: {
  title: string;
  count?: number;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-semibold">
          {title}
          {count !== undefined ? (
            <>
              {" "}
              <span className="ml-1 font-mono text-[12px] text-(--dim)">{count}</span>
            </>
          ) : null}
        </h2>
        {aside}
      </div>
      <div className="flex flex-col border border-(--line)">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-5 text-sm text-(--dim)">{children}</p>;
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-(--line) px-4 py-3.5 last:border-b-0 sm:px-5">
      {children}
    </div>
  );
}

function AttentionRow({
  entry,
  projectId,
  now,
  canExecute,
}: {
  entry: AttentionEntry;
  projectId: string;
  now: Date;
  canExecute: boolean;
}) {
  return (
    <article className="flex flex-col gap-2 border-t border-(--line) py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={entry.tone} />
        <p className="font-medium">{entry.title}</p>
        {entry.at ? (
          <time dateTime={entry.at} className="text-[11.5px] text-(--dim)">
            {relativeTime(entry.at, now)}
          </time>
        ) : null}
      </div>
      {entry.storyId ? (
        <Link
          href={storyHref(projectId, entry.storyId)}
          className="w-fit text-sm text-(--ink) hover:underline"
        >
          {entry.storyTitle} →
        </Link>
      ) : entry.storyTitle ? (
        <p className="text-sm text-(--ink)">{entry.storyTitle}</p>
      ) : null}
      <p className="max-w-prose text-sm leading-relaxed text-(--mut)">{entry.summary}</p>
      {entry.detail ? (
        <details className="text-xs text-(--dim)">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {entry.detail}
          </pre>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] [&>div]:mt-0">
        {entry.action ? (
          entry.action.external ? (
            <a
              href={entry.action.href}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) hover:underline"
            >
              {entry.action.label} ↗
            </a>
          ) : (
            <Link href={entry.action.href} className="text-(--info) hover:underline">
              {entry.action.label} →
            </Link>
          )
        ) : null}
        {entry.item && entry.storyId && canExecute ? (
          <AttentionActions
            projectId={projectId}
            storyId={entry.storyId}
            replyAnchor={false}
            item={{
              ...entry.item,
              status: "open",
              resolution: null,
              resolvedBy: null,
              resolvedAt: null,
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

function ActiveTurnRow({
  turn,
  projectId,
  now,
  canExecute,
}: {
  turn: OverviewActiveTurn;
  projectId: string;
  now: Date;
  canExecute: boolean;
}) {
  const running = turn.state === "running";
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={running ? "agent" : "info"} pulse={running} />
        <span className="font-mono text-[12px] text-(--accent)">{turn.agentName}</span>
        <span className="text-[12px] text-(--mut)">
          {running
            ? `running for ${duration(now.getTime() - new Date(turn.startedAt ?? turn.createdAt).getTime()) ?? "a moment"}`
            : turn.scheduledFor && new Date(turn.scheduledFor).getTime() > now.getTime()
              ? `scheduled ${relativeTime(turn.scheduledFor, now)}`
              : `queued ${relativeTime(turn.createdAt, now)}`}
        </span>
        <span className="text-[12px] text-(--dim)">{triggerLabel(turn.triggerType)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={storyHref(projectId, turn.storyId)}
          className="min-w-0 truncate text-sm text-(--ink) hover:underline"
        >
          {turn.storyTitle} →
        </Link>
        {canExecute ? (
          <CancelTurnButton projectId={projectId} storyId={turn.storyId} turnId={turn.turnId} />
        ) : null}
      </div>
      {!running ? (
        <p className="text-[11.5px] text-(--dim)">
          Queued work is not executing yet; it starts when the dispatcher picks it up.
        </p>
      ) : null}
    </Row>
  );
}

function ReviewRow({
  item,
  projectId,
  now,
}: {
  item: OverviewReviewItem;
  projectId: string;
  now: Date;
}) {
  const state = reviewState(item);
  const url = safeExternalUrl(item.pullRequest.url);
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={state.tone} />
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-sm text-(--ink) hover:underline"
          >
            #{item.pullRequest.number} {item.pullRequest.title} ↗
          </a>
        ) : (
          <span className="min-w-0 truncate text-sm text-(--ink)">
            #{item.pullRequest.number} {item.pullRequest.title}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-(--mut)">
        <span
          className={
            state.tone === "bad" ? "text-(--bad)" : state.tone === "ok" ? "text-(--ok)" : undefined
          }
        >
          {state.label}
        </span>
        {item.pullRequest.repository ? (
          <span className="font-mono text-[11px] text-(--dim)">{item.pullRequest.repository}</span>
        ) : null}
        <span className="text-(--dim)">
          updated {relativeTime(item.pullRequest.updatedAt, now)}
        </span>
        {item.storyId ? (
          <Link href={storyHref(projectId, item.storyId)} className="text-(--info) hover:underline">
            Story →
          </Link>
        ) : (
          <span className="text-(--dim)">no Facility story</span>
        )}
        {item.activeAgentName ? (
          <span className="font-mono text-[11px] text-(--accent)">{item.activeAgentName}</span>
        ) : null}
      </div>
    </Row>
  );
}

function RecentRow({
  turn,
  projectId,
  now,
}: {
  turn: OverviewRecentTurn;
  projectId: string;
  now: Date;
}) {
  const result = turnResult(turn);
  const pullUrl = turn.pullRequest ? safeExternalUrl(turn.pullRequest.url) : null;
  const took = duration(turn.durationMs);
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={result.tone} />
        <span className={`text-sm ${result.tone === "bad" ? "text-(--bad)" : "text-(--ink)"}`}>
          {result.label}
        </span>
        <time dateTime={turn.endedAt} className="text-[12px] text-(--dim)">
          {relativeTime(turn.endedAt, now)}
        </time>
        {took ? <span className="text-[12px] text-(--dim)">took {took}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <Link
          href={storyHref(projectId, turn.storyId)}
          className="min-w-0 truncate text-(--ink) hover:underline"
        >
          {turn.storyTitle} →
        </Link>
        <Link
          href={`${storyHref(projectId, turn.storyId)}#run-${encodeURIComponent(turn.turnId)}`}
          className="text-(--info) hover:underline"
        >
          Run details
        </Link>
        {turn.pullRequest && pullUrl ? (
          <a
            href={pullUrl}
            target="_blank"
            rel="noreferrer"
            className="text-(--info) hover:underline"
          >
            Pull request #{turn.pullRequest.number} ↗
          </a>
        ) : null}
      </div>
      {turn.state === "failed" ? (
        <p className="text-[12px] text-(--mut)">{errorSummary(turn.error)}</p>
      ) : null}
    </Row>
  );
}

function BacklogRow({
  story,
  projectId,
  now,
}: {
  story: OverviewBacklogStory;
  projectId: string;
  now: Date;
}) {
  return (
    <Row>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Link
          href={storyHref(projectId, story.storyId)}
          className="min-w-0 truncate text-sm text-(--ink) hover:underline"
        >
          {story.title} →
        </Link>
        <span className="text-[12px] text-(--dim)">
          updated {relativeTime(story.updatedAt, now)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11.5px] text-(--dim)">
        <span>{storySource(story)}</span>
        {story.branch ? <span className="font-mono text-[10.5px]">{story.branch}</span> : null}
      </p>
    </Row>
  );
}

function backlogLine(backlog: ProjectOverview["backlog"]) {
  const counts = backlog.counts;
  const parts = [
    `${counts.ready} ready`,
    `${counts.working} working`,
    `${counts.attention} attention`,
    `${counts.review} review`,
    `${counts.done} done`,
  ];
  const issues =
    backlog.openIssues === 0
      ? "No open GitHub issues mirrored."
      : `${backlog.openIssuesWithoutStory} of ${backlog.openIssues} open GitHub ${backlog.openIssues === 1 ? "issue has" : "issues have"} no story yet.`;
  return `Stories: ${parts.join(" · ")}. ${issues}`;
}

function SpendSection({
  overview,
  base,
  now,
}: {
  overview: ProjectOverview;
  base: string;
  now: Date;
}) {
  const agents = overview.spend.agents;
  const budget = overview.spend.budget;
  const budgetState = budgetReading(budget);
  return (
    <section aria-label="Spend and environments" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-semibold">Spend and environments</h2>
        <Link href={`${base}/insights`} className={linkClass}>
          Insights →
        </Link>
      </div>
      <div className="grid gap-px border border-(--line) bg-(--line) md:grid-cols-3">
        <div className="flex flex-col gap-2 bg-(--bg) p-5">
          <Eyebrow>
            agent cost · {agents.available ? monthLabel(agents.month.from) : "this month"} (UTC)
          </Eyebrow>
          {agents.available ? (
            <>
              <SpendFigure reading={spendReading(agents.month)} />
              <p className="text-[12px] text-(--dim)">
                Last 7 days: {spendReading(agents.lastSevenDays).amount}
                {agents.lastSevenDays.turns > 0
                  ? ` · ${spendReading(agents.lastSevenDays).note}`
                  : ""}
              </p>
              {agents.byAgent.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1 text-[12px]">
                  {agents.byAgent.slice(0, 3).map((row) => (
                    <li key={row.agentName} className="flex justify-between gap-3">
                      <span className="font-mono text-(--mut)">{row.agentName}</span>
                      <span className="font-mono text-(--dim)">
                        {row.unpricedTurns > 0 && row.unpricedTurns === row.turns
                          ? "unknown"
                          : `${row.unpricedTurns > 0 ? "≥ " : ""}${money(row.costCents)}`}{" "}
                        · {row.turns} {row.turns === 1 ? "turn" : "turns"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[11px] leading-relaxed text-(--dim)">
                Model usage priced from provider reports or the price book. An estimate, not an
                invoice.
              </p>
            </>
          ) : (
            <p className="text-sm text-(--dim)">Not visible for your role.</p>
          )}
        </div>
        <div className="flex flex-col gap-2 bg-(--bg) p-5">
          <Eyebrow>monthly budget</Eyebrow>
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={budgetState.tone} />
            <span className="text-sm">{budgetState.label}</span>
          </div>
          {budget.available && budget.monthlyLimitCents !== null ? (
            <p className="font-mono text-[12px] text-(--mut)">
              {money(budget.spentCents)} of {money(budget.monthlyLimitCents)}
              {budget.percentUsed !== null ? ` · ${Math.round(budget.percentUsed)}%` : ""}
            </p>
          ) : budget.available ? (
            <p className="text-[12px] text-(--dim)">
              New turns are never blocked by cost until a limit is set.
            </p>
          ) : null}
          <Link href={`${base}/insights`} className="text-[12px] text-(--info) hover:underline">
            {budget.available && budget.monthlyLimitCents !== null
              ? "Adjust the budget"
              : "Set a budget"}{" "}
            →
          </Link>
        </div>
        <div className="flex flex-col gap-2 bg-(--bg) p-5">
          <Eyebrow>workspaces</Eyebrow>
          <p className="text-sm">{environmentsLine(overview.environments)}</p>
          <p className="text-[11px] leading-relaxed text-(--dim)">
            Last recorded state, not inspected now
            {overview.environments.lastActivityAt
              ? ` · last activity ${relativeTime(overview.environments.lastActivityAt, now)}`
              : ""}
            . Opening this page never wakes a machine. Provider compute and storage charges are not
            reported here; check each story's environment.
          </p>
          <Link href={`${base}/stories`} className="text-[12px] text-(--info) hover:underline">
            Stories and environments →
          </Link>
        </div>
      </div>
    </section>
  );
}

function SpendFigure({ reading }: { reading: ReturnType<typeof spendReading> }) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`tabular font-mono text-[clamp(22px,2.6vw,30px)] font-semibold leading-none ${
          reading.kind === "unknown" ? "text-(--mut)" : "text-(--ink)"
        }`}
      >
        {reading.amount}
      </span>
      <span className="text-[12px] text-(--dim)">{reading.note}</span>
    </div>
  );
}
