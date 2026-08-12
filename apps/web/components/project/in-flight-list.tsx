import { StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { AiIdentity } from "@/components/ai-identity";
import { engineIdentity } from "@/lib/ai-identity";
import type { InFlightRow } from "@/lib/in-flight";
import { fmtDuration } from "@/lib/runs";

export function InFlightList({
  projectId,
  rows,
  total,
}: {
  projectId: string;
  rows: InFlightRow[];
  total: number;
}) {
  return (
    <div className="flex flex-col border border-(--line)">
      {rows.map((row) => (
        <article
          key={row.runId}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-(--line) px-4 py-3.5 last:border-b-0 hover:bg-(--card) sm:px-5 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-x-4"
        >
          <StatusDot tone={toneFor(row.runStatus)} pulse={row.runStatus === "running"} />

          <div className="min-w-0">
            {row.storyHref ? (
              <Link
                href={row.storyHref}
                className="group flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              >
                <span className="shrink-0 font-mono text-[11px] text-(--dim) group-hover:text-(--mut)">
                  {row.storyLabel}
                </span>
                <span className="break-words text-[13px] font-medium leading-snug text-(--ink) group-hover:text-(--accent)">
                  {row.storyTitle}
                </span>
              </Link>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[11px] text-(--dim)">{row.storyLabel}</span>
                <span className="text-[13px] font-medium text-(--ink)">{row.storyTitle}</span>
              </div>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
              <span className="font-mono text-(--mut)">
                {row.stageLabel} · {row.stateLabel.toLowerCase()}
              </span>
              <span aria-hidden className="text-(--line-strong)">
                —
              </span>
              <span className="text-(--ink)">{row.activity}</span>
            </div>
          </div>

          <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 lg:col-start-3 lg:row-start-1 lg:flex-nowrap lg:justify-end">
            <span className="hidden font-mono text-[10.5px] text-(--dim) xl:inline">
              {row.mode}
            </span>
            <AiIdentity
              identity={engineIdentity(row.engine)}
              className="hidden font-mono text-[10.5px] text-(--dim) sm:inline-flex"
              iconClassName="size-3"
            />
            <span className="font-mono text-[10.5px] text-(--mut)">
              {fmtDuration(row.startedAt, null)}
            </span>
            <Link
              href={`/projects/${projectId}/sessions/${row.runId}`}
              className="shrink-0 text-[11.5px] font-medium text-(--mut) hover:text-(--ink)"
              aria-label={`Inspect the active session for ${row.storyLabel}`}
            >
              Inspect →
            </Link>
          </div>
        </article>
      ))}
      {total > rows.length ? (
        <Link
          href={`/projects/${projectId}/sessions`}
          className="px-5 py-3 text-[11.5px] text-(--dim) hover:text-(--ink)"
        >
          +{total - rows.length} more active {total - rows.length === 1 ? "session" : "sessions"} →
        </Link>
      ) : null}
    </div>
  );
}
