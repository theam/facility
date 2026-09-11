import { Eyebrow, Metric, PillTag, StatusDot } from "@facility/ui";
import { BudgetForm } from "@/components/insights/budget-form";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";

export const metadata = { title: "insights" };

export default async function InsightsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [overview, budget] = await Promise.all([
    api.projectObservability(projectId),
    api.projectBudget(projectId),
  ]);
  if (!overview.ok)
    return overview.offline ? <Offline /> : <ErrorNotice message={overview.message} />;
  if (!budget.ok) return budget.offline ? <Offline /> : <ErrorNotice message={budget.message} />;
  const data = overview.data;
  const totalTokens =
    data.usage.inputTokens +
    data.usage.outputTokens +
    data.usage.cacheReadTokens +
    data.usage.cacheWriteTokens;

  return (
    <div className="flex flex-col gap-9">
      <LiveRefresh seconds={15} />
      <header className="flex flex-col gap-2">
        <Eyebrow>operations and spend</Eyebrow>
        <div className="flex items-center gap-3">
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Insights</h1>
          <span className="inline-flex items-center gap-2 text-[12px] text-(--mut)">
            <StatusDot
              tone={data.health === "healthy" ? "ok" : data.health === "degraded" ? "bad" : "human"}
            />
            {data.health}
          </span>
        </div>
        <p className="max-w-2xl text-[13px] leading-relaxed text-(--dim)">
          Turn outcomes, model usage, budget state, workspace health, GitHub delivery signals, and
          audit activity.
        </p>
      </header>

      <section className="grid gap-px border border-(--line) bg-(--line) sm:grid-cols-2 xl:grid-cols-5">
        <MetricCell
          label="cost · 30d"
          value={money(data.usage.costCents)}
          hint={`${data.usage.unpricedTurns} unpriced turns`}
        />
        <MetricCell
          label="tokens · 30d"
          value={compact(totalTokens)}
          hint={`${data.usage.turns} measured turns`}
        />
        <MetricCell
          label="success"
          value={
            data.turns.successRate === null ? "—" : `${Math.round(data.turns.successRate * 100)}%`
          }
          hint={`${data.turns.failed} failed`}
        />
        <MetricCell
          label="workspaces"
          value={String(data.workspaces.retained)}
          hint={`${data.workspaces.states.running ?? 0} running`}
        />
        <MetricCell
          label="GitHub"
          value={String(data.github.openPullRequests)}
          hint={`${data.github.failedChecks} failed checks`}
        />
      </section>

      <section className="flex flex-col gap-4">
        <Eyebrow>delivery analytics · 30d</Eyebrow>
        <div className="grid gap-px border border-(--line) bg-(--line) sm:grid-cols-2 xl:grid-cols-4">
          <MetricCell
            label="merged pull requests"
            value={String(data.analytics.mergedPullRequests)}
            hint="mirrored repositories"
          />
          <MetricCell
            label="observed first pass"
            value={
              data.analytics.observedFirstPassRate === null
                ? "—"
                : `${Math.round(data.analytics.observedFirstPassRate * 100)}%`
            }
            hint={`${data.analytics.observedFirstPassMerges}/${data.analytics.ciEvidenceMerges} merges with CI evidence`}
          />
          <MetricCell
            label="PR lead time"
            value={
              data.analytics.averagePullRequestLeadTimeHours === null
                ? "—"
                : `${data.analytics.averagePullRequestLeadTimeHours.toFixed(1)}h`
            }
            hint="creation to merge"
          />
          <MetricCell
            label="CI evidence"
            value={
              data.analytics.ciEvidenceRate === null
                ? "—"
                : `${Math.round(data.analytics.ciEvidenceRate * 100)}%`
            }
            hint={`${data.analytics.activeAgents} active agents · ${data.attention.open} need attention`}
          />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Eyebrow>monthly budget</Eyebrow>
          <PillTag>{budget.data.state.replaceAll("_", " ")}</PillTag>
        </div>
        <p className="text-[12px] text-(--dim)">
          {money(budget.data.spent_cents)} spent this month. New turns are blocked once the limit is
          reached; a provider call already in progress is allowed to finish and is accounted
          afterwards.
        </p>
        <BudgetForm projectId={projectId} budget={budget.data} />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <UsageTable title="By agent" rows={data.byAgent} />
        <UsageTable title="By model" rows={data.byModel} />
      </section>

      <section className="flex flex-col gap-4">
        <Eyebrow>recent control activity</Eyebrow>
        <div className="border border-(--line)">
          {data.recentAudit.length === 0 ? (
            <p className="p-5 text-[12px] text-(--dim)">No recorded project changes.</p>
          ) : (
            data.recentAudit.map((event) => (
              <div
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-(--line) px-4 py-3 last:border-b-0"
              >
                <span className="font-mono text-[11.5px] text-(--ink)">{event.action}</span>
                <time className="text-[11px] text-(--dim)">
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function MetricCell({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-(--bg) p-5">
      <Metric label={label} value={value} hint={hint} />
    </div>
  );
}

function UsageTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    name: string;
    turns: number;
    costCents: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
}) {
  return (
    <section className="flex flex-col gap-3">
      <Eyebrow>{title}</Eyebrow>
      <div className="border border-(--line)">
        {rows.length === 0 ? (
          <p className="p-5 text-[12px] text-(--dim)">No measured usage.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.name}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 border-b border-(--line) px-4 py-3 text-[12px] last:border-b-0"
            >
              <span className="truncate font-mono text-(--ink)">{row.name}</span>
              <span className="text-(--dim)">{row.turns} turns</span>
              <span className="font-mono text-(--mut)">{money(row.costCents)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
