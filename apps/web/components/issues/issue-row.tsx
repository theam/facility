"use client";

import { Button, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type GhIssue = {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  author: string | null;
  htmlUrl: string;
  commentsCount: number;
  ghUpdatedAt: string | null;
  linkedRuns: Array<{
    id: string;
    mode: string;
    status: string;
    engine: string;
    pr?: { number?: number; url?: string } | null;
  }>;
};

function fmtAgo(iso: string | null) {
  if (!iso) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * One mirrored GitHub issue with its Facility verbs. The issue itself is
 * GitHub's (read-mirror by decision #2) — authoring stays there; dispatching
 * agents happens here.
 */
export function IssueRow({
  projectId,
  issue,
  canTrigger,
}: {
  projectId: string;
  issue: GhIssue;
  canTrigger: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(agent: string) {
    setBusy(agent);
    setError(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/issues/${issue.number}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `trigger failed (${res.status})`);
      if (body?.id) {
        router.push(`/projects/${projectId}/sessions/${body.id}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "trigger failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-(--line) px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] text-(--dim)">#{issue.number}</span>
        <a
          href={issue.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-[13.5px] text-(--ink) underline-offset-4 hover:underline"
        >
          {issue.title}
        </a>
        {issue.labels.slice(0, 3).map((label) => (
          <span
            key={label}
            className="border border-(--line) px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-(--dim)"
          >
            {label}
          </span>
        ))}
        <span className="font-mono text-[10.5px] text-(--dim)">{fmtAgo(issue.ghUpdatedAt)}</span>
        {canTrigger && issue.state === "open" ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void trigger("architect")}
            >
              {busy === "architect" ? "queuing…" : "architect"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void trigger("builder")}
            >
              {busy === "builder" ? "queuing…" : "builder"}
            </Button>
          </div>
        ) : null}
      </div>
      {issue.linkedRuns.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-0 sm:pl-10">
          {issue.linkedRuns.map((run) => (
            <span key={run.id} className="flex items-center gap-2">
              <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
              <Link
                href={`/projects/${projectId}/sessions/${run.id}`}
                className="font-mono text-[11px] text-(--mut) hover:text-(--ink)"
              >
                {run.mode} · {run.status}
              </Link>
              {run.pr?.url ? (
                <a
                  href={run.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
                >
                  PR #{run.pr.number ?? ""} ↗
                </a>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {error ? <p className="font-mono text-[11px] text-(--bad)">{error}</p> : null}
    </div>
  );
}
