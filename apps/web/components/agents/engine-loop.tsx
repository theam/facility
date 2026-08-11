"use client";

import { PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { agentHealth } from "@/lib/agent-view";
import { engineIdentity, modelIdentity } from "@/lib/ai-identity";
import type { AgentStatus } from "@/lib/api";
import { fmtAgo, fmtStatus } from "@/lib/run-format";
import { cronToWords, fmtIn } from "@/lib/schedule";

type Facet = "all" | "scheduled" | "events" | "manual";

function modelOf(status: AgentStatus): string | null {
  const model = (status.model as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

/**
 * The engine as one surface: per agent — what wakes it, the agent itself,
 * what it produced. Searchable and facetable; every chip is backed by real
 * data, and a queued session never pretends to be working.
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
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const shown = useMemo(() => {
    const source = compact ? rows.filter((r) => r.enabled) : rows;
    const needle = q.trim().toLowerCase();
    return source.filter((row) => {
      if (enabledOnly && !row.enabled) return false;
      if (facet === "scheduled" && !row.schedule) return false;
      if (facet === "events" && !row.eventBindings.some((b) => b.enabled)) return false;
      if (facet === "manual" && (row.schedule || row.eventBindings.some((b) => b.enabled)))
        return false;
      if (!needle) return true;
      return [row.name, row.description ?? "", row.engine, modelOf(row) ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, compact, q, facet, enabledOnly]);

  const facets: Array<{ key: Facet; label: string }> = [
    { key: "all", label: "all" },
    { key: "scheduled", label: "scheduled" },
    { key: "events", label: "event-driven" },
    { key: "manual", label: "on demand" },
  ];

  return (
    <div className="flex flex-col gap-3">
      {!compact ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search agents…"
            className="h-8 w-56 border border-(--line) bg-transparent px-3 text-[13px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
            aria-label="search agents"
          />
          {facets.map((f) => (
            <button key={f.key} type="button" onClick={() => setFacet(f.key)}>
              <PillTag active={facet === f.key}>{f.label}</PillTag>
            </button>
          ))}
          <button type="button" onClick={() => setEnabledOnly((v) => !v)} className="ml-auto">
            <PillTag active={enabledOnly}>enabled only</PillTag>
          </button>
        </div>
      ) : null}

      <div className="hidden grid-cols-[minmax(0,1.3fr)_20px_minmax(0,1.3fr)_20px_minmax(0,1fr)] gap-x-2 px-4 text-[10.5px] font-medium text-(--dim) sm:grid">
        <span>wakes on</span>
        <span />
        <span>agent</span>
        <span />
        <span>produced · 14d</span>
      </div>

      {shown.length === 0 ? (
        <p className="border border-(--line) px-5 py-6 text-sm text-(--dim)">
          {rows.length === 0
            ? "No agents yet — create one to put the engine to work."
            : "Nothing matches this filter."}
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {shown.map((row) => {
            const health = agentHealth(row);
            const liveBindings = row.eventBindings.filter((b) => b.enabled);
            const next = fmtIn(row.nextRunAt);
            const working =
              row.liveRun?.status === "running" || row.liveRun?.status === "provisioning";
            return (
              <div
                key={row.agentId}
                className="grid grid-cols-1 items-center gap-x-2 gap-y-2 border-b border-(--line) px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.3fr)_20px_minmax(0,1.3fr)_20px_minmax(0,1fr)]"
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.schedule ? (
                    <Chip title={next ? `next ${next}` : undefined}>
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
                  className="flex min-w-0 flex-col gap-0.5 border border-(--line) bg-(--bg-subtle) px-3 py-2 transition-colors hover:border-(--line-strong)"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <StatusDot tone={health.tone} pulse={health.pulse} />
                    <span className="truncate font-mono text-[13px] text-(--ink)">{row.name}</span>
                    <span className="ml-auto hidden items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-(--dim) lg:flex">
                      <AiIdentity identity={engineIdentity(row.engine)} iconClassName="size-3" />
                      {modelOf(row) ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <AiIdentity
                            identity={modelIdentity(modelOf(row) ?? "")}
                            iconClassName="size-3"
                          />
                        </>
                      ) : null}
                    </span>
                  </span>
                  {!compact && row.description ? (
                    <span className="truncate pl-[18px] text-[12px] text-(--mut)">
                      {row.description}
                    </span>
                  ) : null}
                </Link>
                <Wire />
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.liveRun ? (
                    <Link href={`/projects/${projectId}/sessions/${row.liveRun.id}`}>
                      <Chip live={working}>
                        {row.liveRun.status === "queued"
                          ? "session queued"
                          : row.liveRun.status === "awaiting_human"
                            ? "waiting on you"
                            : "session working"}
                      </Chip>
                    </Link>
                  ) : row.lastRun ? (
                    <Link href={`/projects/${projectId}/sessions/${row.lastRun.id}`}>
                      <Chip title={fmtAgo(row.lastRun.queuedAt)}>
                        {fmtStatus(row.lastRun.status)} {fmtAgo(row.lastRun.queuedAt)}
                      </Chip>
                    </Link>
                  ) : (
                    <Chip>never ran</Chip>
                  )}
                  {row.prCount14d > 0 ? (
                    <Chip>
                      {row.prCount14d} PR{row.prCount14d === 1 ? "" : "s"}
                    </Chip>
                  ) : null}
                  {row.counts14d.total > 0 ? (
                    <Chip>
                      {row.counts14d.succeeded}/{row.counts14d.total} ok
                    </Chip>
                  ) : null}
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
      )}

      {!compact ? (
        <p className="text-[11.5px] text-(--dim)">
          Issues carry the loop: the owner and event agents file them through gates · architect
          plans them · builder ships the PR · reviewers close it.
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
