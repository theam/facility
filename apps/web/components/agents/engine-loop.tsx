import { StatusDot } from "@facility/ui";
import Link from "next/link";
import { agentHealth } from "@/lib/agent-view";
import type { AgentStatus } from "@/lib/api";
import { cronToWords, fmtIn } from "@/lib/schedule";

/**
 * The execution loop, rendered from live state — one row per agent:
 * what wakes it (left), the agent (center), what it produced (right).
 * Every chip is backed by real data; no fabricated edges (L6 + L9).
 */
export function EngineLoop({
  projectId,
  rows,
  compact = false,
}: {
  projectId: string;
  rows: AgentStatus[];
  compact?: boolean;
}) {
  const shown = compact ? rows.filter((r) => r.enabled) : rows;
  if (shown.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="hidden grid-cols-[minmax(0,1.4fr)_24px_minmax(0,1.2fr)_24px_minmax(0,1fr)] gap-x-2 px-4 font-mono text-[9.5px] uppercase tracking-[0.22em] text-(--dim) sm:grid">
        <span>wakes on</span>
        <span />
        <span>agent</span>
        <span />
        <span>produced · 14d</span>
      </div>
      <div className="flex flex-col border border-(--line)">
        {shown.map((row) => {
          const health = agentHealth(row);
          const liveBindings = row.eventBindings.filter((b) => b.enabled);
          return (
            <div
              key={row.agentId}
              className="grid grid-cols-1 items-center gap-x-2 gap-y-2 border-b border-(--line) px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_24px_minmax(0,1.2fr)_24px_minmax(0,1fr)]"
            >
              <span className="flex flex-wrap items-center gap-1.5">
                {row.schedule ? (
                  <Chip title={row.liveRun ? undefined : (fmtIn(row.nextRunAt) ?? undefined)}>
                    ⏱ {cronToWords(row.schedule.cron, row.schedule.timezone)}
                  </Chip>
                ) : null}
                {liveBindings.map((b) => (
                  <Chip
                    key={b.integrationId}
                    title={b.dispatchesRuns ? "dispatches sessions" : "raises alerts only"}
                  >
                    ⚡ {b.name}
                  </Chip>
                ))}
                {row.enabled ? <Chip>issues · /{row.name}</Chip> : <Chip>disabled</Chip>}
              </span>
              <Wire />
              <Link
                href={`/projects/${projectId}/agents/${row.agentId}`}
                className="flex min-w-0 items-center gap-2.5 border border-(--line) bg-(--bg-subtle) px-3 py-2 transition-colors hover:border-(--line-strong)"
              >
                <StatusDot tone={health.tone} pulse={health.pulse} />
                <span className="truncate font-mono text-[12.5px] text-(--ink)">{row.name}</span>
                <span className="ml-auto hidden whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.12em] text-(--dim) lg:inline">
                  {row.engine}
                </span>
              </Link>
              <Wire />
              <span className="flex flex-wrap items-center gap-1.5">
                {row.liveRun ? (
                  <Link href={`/projects/${projectId}/sessions/${row.liveRun.id}`}>
                    <Chip live>session live</Chip>
                  </Link>
                ) : null}
                {row.prCount14d > 0 ? (
                  <Chip>
                    {row.prCount14d} PR{row.prCount14d === 1 ? "" : "s"}
                  </Chip>
                ) : null}
                {row.counts14d.total > 0 ? (
                  <Chip>
                    {row.counts14d.succeeded}/{row.counts14d.total} ok
                  </Chip>
                ) : (
                  <Chip>quiet</Chip>
                )}
                {row.lastRun?.prUrl ? (
                  <a
                    href={row.lastRun.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10.5px] text-(--info) underline-offset-4 hover:underline"
                  >
                    last PR ↗
                  </a>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {!compact ? (
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-(--dim)">
          issues carry the loop: the owner and event agents file them through gates · architect
          plans them · builder ships the PR · reviewers close it
        </p>
      ) : null}
    </div>
  );
}

function Chip({
  children,
  title,
  live = false,
}: {
  children: React.ReactNode;
  title?: string;
  live?: boolean;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap border px-2 py-0.5 font-mono text-[10.5px] ${
        live ? "border-(--accent) text-(--accent)" : "border-(--line) text-(--mut)"
      }`}
    >
      {children}
    </span>
  );
}

function Wire() {
  return <span className="hidden h-px w-full bg-(--line) sm:block" aria-hidden />;
}
