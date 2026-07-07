"use client";

import { PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { agentHealth, triggerSummary } from "@/lib/agent-view";
import type { AgentStatus } from "@/lib/api";
import { fmtAgo } from "@/lib/run-format";
import { fmtIn } from "@/lib/schedule";

function modelOf(status: AgentStatus): string {
  const model = (status.model as { model?: unknown }).model;
  return typeof model === "string" ? model : "engine default";
}

type Facet = "all" | "scheduled" | "events" | "manual";

/** The engine, scannable: health, purpose, trigger in words, next fire, recent record. */
export function EngineTable({ projectId, rows }: { projectId: string; rows: AgentStatus[] }) {
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((row) => {
      if (enabledOnly && !row.enabled) return false;
      if (facet === "scheduled" && !row.schedule) return false;
      if (facet === "events" && row.eventBindings.filter((b) => b.enabled).length === 0)
        return false;
      if (facet === "manual" && (row.schedule || row.eventBindings.some((b) => b.enabled)))
        return false;
      if (!needle) return true;
      const haystack = [row.name, row.description ?? "", row.engine, modelOf(row)]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, q, facet, enabledOnly]);

  const facets: Array<{ key: Facet; label: string }> = [
    { key: "all", label: "all" },
    { key: "scheduled", label: "scheduled" },
    { key: "events", label: "event-driven" },
    { key: "manual", label: "on demand" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search agents…"
          className="h-8 w-56 border border-(--line) bg-transparent px-3 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
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

      {filtered.length === 0 ? (
        <p className="border border-(--line) px-5 py-6 text-sm text-(--dim)">
          {rows.length === 0
            ? "No agents yet — create one to put the engine to work."
            : "Nothing matches this filter."}
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {filtered.map((row) => {
            const health = agentHealth(row);
            const next = fmtIn(row.nextRunAt);
            const ratio =
              row.counts14d.total > 0 ? row.counts14d.succeeded / row.counts14d.total : null;
            return (
              <Link
                key={row.agentId}
                href={`/projects/${projectId}/agents/${row.agentId}`}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-(--line) px-5 py-4 transition-colors last:border-b-0 hover:bg-(--card) sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,1.6fr)_110px_150px_110px]"
              >
                <StatusDot tone={health.tone} pulse={health.pulse} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-baseline gap-3">
                    <span className="truncate font-mono text-[13.5px] text-(--ink)">
                      {row.name}
                    </span>
                    <span className="hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-(--dim) lg:inline">
                      {row.engine} · {modelOf(row)}
                    </span>
                  </span>
                  {row.description ? (
                    <span className="truncate text-[12px] text-(--mut)">{row.description}</span>
                  ) : null}
                </span>
                <span className="hidden truncate font-mono text-[11.5px] text-(--mut) sm:inline">
                  {triggerSummary(row)}
                </span>
                <span className="hidden font-mono text-[11.5px] text-(--code) sm:inline">
                  {row.liveRun ? "running now" : (next ?? "—")}
                </span>
                <span className="hidden font-mono text-[11px] text-(--mut) sm:inline">
                  {row.lastRun
                    ? `${row.lastRun.status} · ${fmtAgo(row.lastRun.queuedAt)}`
                    : "never ran"}
                </span>
                <span className="flex items-center justify-end gap-2 sm:justify-start">
                  {ratio !== null ? (
                    <>
                      <span className="inline-flex h-1.5 w-12 overflow-hidden bg-(--line)">
                        <span
                          className="h-full"
                          style={{ width: `${ratio * 100}%`, background: "var(--ok)" }}
                        />
                      </span>
                      <span className="font-mono text-[10.5px] text-(--dim)">
                        {row.counts14d.succeeded}/{row.counts14d.total}
                      </span>
                    </>
                  ) : (
                    <span className="font-mono text-[10.5px] text-(--dim)">—</span>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
