"use client";

import { PillTag, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { engineIdentity } from "@/lib/ai-identity";
import { fmtAgo, fmtCost, fmtDuration, fmtStatus } from "@/lib/run-format";

export type SessionRow = {
  id: string;
  projectId: string;
  projectSlug?: string;
  mode: string;
  agentName?: string | null;
  engine: string;
  status: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  costCents: number | null;
  prUrl: string | null;
  issueNumber?: number | null;
};

const LIVE = new Set(["queued", "provisioning", "running"]);
const DAY = 24 * 60 * 60 * 1000;

type Facet = "all" | "live" | "waiting" | "succeeded" | "failed";

function facetOf(status: string): Exclude<Facet, "all"> | "other" {
  if (LIVE.has(status)) return "live";
  if (status === "awaiting_human") return "waiting";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "other";
}

/**
 * Sessions as a workspace (L2+L3): a decision-grade 24h summary on top,
 * search + status/agent facets on the list, drill-down per row.
 */
export function SessionTable({
  rows,
  agents = [],
  initialAgent = "",
  showProject = false,
}: {
  rows: SessionRow[];
  agents?: Array<{ id: string; name: string }>;
  /** agentDefId preselected via ?agent= deep links. */
  initialAgent?: string;
  showProject?: boolean;
}) {
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [agentName, setAgentName] = useState(
    () => agents.find((a) => a.id === initialAgent)?.name ?? "",
  );

  const dayAgo = Date.now() - DAY;
  const last24 = rows.filter((r) => new Date(r.queuedAt).getTime() >= dayAgo);
  const day = {
    total: last24.length,
    ok: last24.filter((r) => r.status === "succeeded").length,
    failed: last24.filter((r) => r.status === "failed").length,
    live: rows.filter((r) => LIVE.has(r.status) || r.status === "awaiting_human").length,
    cents: last24.reduce((sum, r) => sum + (r.costCents ?? 0), 0),
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((row) => {
      if (facet !== "all" && facetOf(row.status) !== facet) return false;
      if (agentName && row.agentName !== agentName && row.mode !== agentName) return false;
      if (!needle) return true;
      return [row.mode, row.agentName ?? "", row.engine, row.status, row.id, row.projectSlug ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, q, facet, agentName]);

  const facets: Array<{ key: Facet; label: string }> = [
    { key: "all", label: "all" },
    { key: "live", label: "live" },
    { key: "waiting", label: "waiting on you" },
    { key: "succeeded", label: "succeeded" },
    { key: "failed", label: "failed" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-[11.5px] text-(--mut)">
        last 24h: <span className="text-(--ink)">{day.total}</span> sessions ·{" "}
        <span className="text-(--ok)">{day.ok} ok</span> ·{" "}
        <span className={day.failed > 0 ? "text-(--bad)" : ""}>{day.failed} failed</span> ·{" "}
        {day.live} live now · {fmtCost(day.cents)}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search sessions…"
          className="h-8 w-56 border border-(--line) bg-transparent px-3 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
          aria-label="search sessions"
        />
        {facets.map((f) => (
          <button key={f.key} type="button" onClick={() => setFacet(f.key)}>
            <PillTag active={facet === f.key}>{f.label}</PillTag>
          </button>
        ))}
        {agents.length > 0 ? (
          <select
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="ml-auto h-8 border border-(--line) bg-(--bg) px-2 font-mono text-[11px] text-(--mut)"
            aria-label="filter by agent"
          >
            <option value="">every agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <p className="border border-(--line) px-5 py-6 text-sm text-(--dim)">
          {rows.length === 0 ? "No sessions recorded yet." : "Nothing matches this filter."}
        </p>
      ) : (
        <div className="overflow-x-auto border border-(--line)">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-(--line)">
                {[
                  showProject ? "project / session" : "session",
                  "engine",
                  "status",
                  "artifact",
                  "duration",
                  "cost",
                  "when",
                ].map((h) => (
                  <th key={h} className="px-5 py-3 text-[11px] font-medium text-(--dim)">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-b border-(--line) last:border-b-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/projects/${row.projectId}/sessions/${row.id}`}
                      className="flex items-center gap-3 font-mono text-[12.5px] text-(--ink) hover:text-(--accent)"
                    >
                      <StatusDot tone={toneFor(row.status)} pulse={row.status === "running"} />
                      {showProject && row.projectSlug ? `${row.projectSlug}/` : ""}
                      {row.mode}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">
                    <AiIdentity identity={engineIdentity(row.engine)} />
                  </td>
                  <td className="px-5 py-3 text-[12px] text-(--mut)">{fmtStatus(row.status)}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-3">
                      {row.issueNumber != null ? (
                        <Link
                          href={`/projects/${row.projectId}/stories`}
                          className="font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
                          title="the issue this run works on"
                        >
                          #{row.issueNumber}
                        </Link>
                      ) : null}
                      {row.prUrl ? (
                        <a
                          href={row.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
                        >
                          PR ↗
                        </a>
                      ) : null}
                      {row.issueNumber == null && !row.prUrl ? (
                        <span className="font-mono text-[11px] text-(--dim)">—</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--mut)">
                    {fmtDuration(row.startedAt, row.endedAt)}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--mut)">
                    {fmtCost(row.costCents ?? undefined)}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">
                    {fmtAgo(row.queuedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
