import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { AiIdentity } from "@/components/ai-identity";
import { engineIdentity, modelProductLabel } from "@/lib/ai-identity";
import type { DeliveryIntelligence as DeliveryData } from "@/lib/delivery-intelligence";
import { fmtAgo, fmtCost } from "@/lib/runs";

function Configuration({ engine, model }: { engine: string; model: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[10.5px] text-(--dim)">
      <AiIdentity identity={engineIdentity(engine)} iconClassName="size-3" />
      <span aria-hidden>–</span>
      <span className="truncate">{modelProductLabel(model)}</span>
    </span>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-(--line) pl-3 first:border-l-0 first:pl-0 sm:pl-4">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[18px] font-semibold tabular-nums text-(--ink) sm:text-[21px]">
        {value}
      </span>
    </div>
  );
}

export function DeliveryIntelligence({
  projectId,
  data,
}: {
  projectId: string;
  data: DeliveryData;
}) {
  const maxSpend = Math.max(...data.spendRows.map((row) => row.spendCents), 0);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Eyebrow>delivery · month to date</Eyebrow>
          <span className="text-[11.5px] text-(--dim)">
            compare agent configurations by cost and shipped work
          </span>
        </div>
        <Link href="/analytics" className="text-[12px] font-medium text-(--mut) hover:text-(--ink)">
          cost analytics →
        </Link>
      </div>

      <div className="grid border border-(--line) lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-5 border-b border-(--line) p-4 sm:p-5 lg:border-r lg:border-b-0">
          <div>
            <h2 className="text-[13px] font-semibold text-(--ink)">Spend by configuration</h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-(--dim)">
              Gateway cost attributed to the agent and model that did the work.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <SummaryMetric label="spend" value={fmtCost(data.totalSpendCents)} />
            <SummaryMetric label="shipped" value={String(data.shippedCount)} />
            <SummaryMetric label="per ship" value={fmtCost(data.costPerShippedCents)} />
          </div>

          {data.spendRows.length === 0 ? (
            <p className="border-t border-(--line) pt-4 text-[12px] text-(--dim)">
              No metered model spend this month.
            </p>
          ) : (
            <div
              className="flex flex-col gap-4 border-t border-(--line) pt-4"
              role="img"
              aria-label="Month-to-date spend by agent configuration"
            >
              {data.spendRows.slice(0, 6).map((row) => (
                <div key={row.key} className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        {row.agentId ? (
                          <Link
                            href={`/projects/${projectId}/agents/${row.agentId}`}
                            className="font-mono text-[11.5px] font-semibold text-(--ink) hover:text-(--accent)"
                          >
                            {row.agentName}
                          </Link>
                        ) : (
                          <span className="font-mono text-[11.5px] font-semibold text-(--ink)">
                            {row.agentName}
                          </span>
                        )}
                        <span className="text-[10.5px] text-(--mut)">
                          {row.shippedCount} shipped
                          {row.costPerShippedCents !== null
                            ? ` · ${fmtCost(row.costPerShippedCents)}/ship`
                            : ""}
                        </span>
                      </div>
                      <div className="mt-1">
                        <Configuration {...row} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-[12px] font-semibold tabular-nums text-(--code)">
                        {fmtCost(row.spendCents)}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-(--dim)">
                        {row.sharePercent}%
                      </div>
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden bg-(--line)" aria-hidden="true">
                    <div
                      className="h-full bg-(--accent)"
                      style={{
                        width: `${maxSpend > 0 ? Math.max(2, (100 * row.spendCents) / maxSpend) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="border-b border-(--line) p-4 sm:p-5">
            <h2 className="text-[13px] font-semibold text-(--ink)">Recently shipped</h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-(--dim)">
              The story, accountable person, producing agent and model, and run cost.
            </p>
          </div>
          {data.shippedRows.length === 0 ? (
            <p className="p-5 text-[12px] text-(--dim)">
              No merged agent pull requests this month.
            </p>
          ) : (
            <div className="flex flex-col">
              {data.shippedRows.map((row) => (
                <article
                  key={row.outcomeId}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-(--line) px-4 py-3.5 last:border-b-0 hover:bg-(--card) sm:px-5"
                >
                  <StatusDot tone="ok" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="shrink-0 font-mono text-[10.5px] text-(--dim)">
                        {row.storyLabel}
                      </span>
                      {row.storyHref ? (
                        <Link
                          href={row.storyHref}
                          className="break-words text-[12.5px] font-medium leading-snug text-(--ink) hover:text-(--accent)"
                        >
                          {row.storyTitle}
                        </Link>
                      ) : (
                        <span className="break-words text-[12.5px] font-medium leading-snug text-(--ink)">
                          {row.storyTitle}
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-(--mut)">
                      <span>
                        {row.assignees.length > 0
                          ? `assigned ${row.assignees.map((assignee) => `@${assignee}`).join(", ")}`
                          : "unassigned"}
                      </span>
                      <span aria-hidden className="text-(--line-strong)">
                        ·
                      </span>
                      <span className="font-mono text-(--ink)">{row.agentName}</span>
                      {row.oneShot ? (
                        <span className="border border-(--line) px-1.5 py-0.5 text-[9.5px] font-medium text-(--ok)">
                          one-shot
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1.5">
                      <Configuration {...row} />
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px]">
                      <span className="font-semibold text-(--code)">
                        cost {fmtCost(row.costCents)}
                      </span>
                      <span className="text-(--dim)">{fmtAgo(row.terminalAt)}</span>
                      {row.runId ? (
                        <Link
                          href={`/projects/${projectId}/sessions/${row.runId}`}
                          className="text-(--mut) hover:text-(--ink)"
                        >
                          inspect run →
                        </Link>
                      ) : null}
                      <a
                        href={row.pullHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-(--info) hover:underline"
                      >
                        PR #{row.pullNumber} ↗
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
