"use client";

import { Button, ButtonLink, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CiStatusLink } from "@/components/ci-status";
import type { PipelineStory } from "@/lib/pipeline";
import { storyHref } from "@/lib/pipeline";

function fmtAgo(iso: string | null) {
  if (!iso) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** One server-assembled story with its current run, PRs, and Facility verbs. */
export function IssueRow({
  projectId,
  story,
  canTrigger,
  builderPlanRequired,
}: {
  projectId: string;
  story: PipelineStory;
  canTrigger: boolean;
  builderPlanRequired: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(agent: string) {
    setBusy(agent);
    setError(null);
    try {
      const query = new URLSearchParams({ repoId: story.repoId });
      const res = await fetch(
        `/api/v1/projects/${projectId}/issues/${story.number}/trigger?${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent }),
        },
      );
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

  const current = story.currentRun;
  const openPull = story.prs.find((pull) => pull.state === "open") ?? null;
  const failedAgent = current?.mode.includes("architect")
    ? "architect"
    : current?.mode.includes("builder")
      ? "builder"
      : null;

  function action() {
    if (story.stageState === "needs_review") {
      return (
        <ButtonLink size="sm" href={storyHref(projectId, story)}>
          Review plan
        </ButtonLink>
      );
    }
    if (story.stageState === "ready_to_plan" && canTrigger && story.storyType === "issue") {
      return (
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy !== null}
          onClick={() => void trigger("architect")}
        >
          {busy === "architect" ? "queuing…" : "Plan"}
        </Button>
      );
    }
    if (story.stageState === "ready_to_build" && canTrigger && story.storyType === "issue") {
      if (builderPlanRequired) {
        return (
          <ButtonLink size="sm" href={storyHref(projectId, story)}>
            Review Gate 1
          </ButtonLink>
        );
      }
      return (
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy !== null}
          onClick={() => void trigger("builder")}
        >
          {busy === "builder" ? "queuing…" : "Build"}
        </Button>
      );
    }
    if (story.stageState === "failed" && failedAgent && canTrigger) {
      if (failedAgent === "builder" && builderPlanRequired) {
        return (
          <ButtonLink size="sm" variant="danger" href={storyHref(projectId, story)}>
            Review Gate 1
          </ButtonLink>
        );
      }
      return (
        <Button
          size="sm"
          variant="danger"
          disabled={busy !== null}
          onClick={() => void trigger(failedAgent)}
        >
          {busy === failedAgent
            ? "queuing…"
            : failedAgent === "architect"
              ? "Retry plan"
              : "Retry build"}
        </Button>
      );
    }
    if (story.stageState === "draft_pr" && openPull) {
      return (
        <ButtonLink size="sm" href={openPull.url} target="_blank" rel="noreferrer">
          Open draft ↗
        </ButtonLink>
      );
    }
    if (
      (story.stageState === "checks_running" || story.stageState === "checks_failed") &&
      story.ciUrl
    ) {
      return (
        <ButtonLink
          size="sm"
          variant={story.stageState === "checks_failed" ? "danger" : "outline"}
          href={story.ciUrl}
          target="_blank"
          rel="noreferrer"
        >
          {story.stageState === "checks_failed" ? "Inspect failure ↗" : "View checks ↗"}
        </ButtonLink>
      );
    }
    if (story.stageState === "awaiting_review" && openPull) {
      return (
        <ButtonLink size="sm" href={openPull.url} target="_blank" rel="noreferrer">
          Review PR ↗
        </ButtonLink>
      );
    }
    if ((story.stageState === "in_progress" || story.stageState === "failed") && current) {
      return (
        <ButtonLink size="sm" href={`/projects/${projectId}/sessions/${current.id}`}>
          View run
        </ButtonLink>
      );
    }
    if (story.stageState === "needs_attention") {
      return (
        <ButtonLink size="sm" variant="danger" href={storyHref(projectId, story)}>
          Inspect
        </ButtonLink>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-b border-(--line) px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] text-(--dim)">
          {story.repoOwner}/{story.repoName}#{story.number}
        </span>
        <Link
          href={storyHref(projectId, story)}
          className="min-w-0 flex-1 truncate text-[13.5px] text-(--ink) underline-offset-4 hover:underline"
        >
          {story.title}
        </Link>
        <a
          href={story.htmlUrl}
          target="_blank"
          rel="noreferrer"
          title="open on GitHub"
          className="font-mono text-[11px] text-(--dim) hover:text-(--ink)"
        >
          ↗
        </a>
        {story.labels.slice(0, 3).map((label) => (
          <span
            key={label}
            className="border border-(--line) px-1.5 py-0.5 font-mono text-[10px] text-(--dim)"
          >
            {label}
          </span>
        ))}
        <span className="font-mono text-[10.5px] text-(--dim)">{fmtAgo(story.ghUpdatedAt)}</span>
        {action()}
      </div>
      {current || story.prs.length > 0 || story.ciState ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-0 sm:pl-10">
          {current ? (
            <span className="flex items-center gap-2">
              <StatusDot tone={toneFor(current.status)} pulse={story.runState === "live"} />
              <Link
                href={`/projects/${projectId}/sessions/${current.id}`}
                className="font-mono text-[11px] text-(--mut) hover:text-(--ink)"
              >
                {current.mode} · {current.status}
              </Link>
              {story.attemptCount > 1 ? (
                <span className="font-mono text-[10px] text-(--dim)" title="previous attempts">
                  ({story.attemptCount - 1} earlier)
                </span>
              ) : null}
            </span>
          ) : null}
          {story.prs.map((pr) => (
            <a
              key={pr.number}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
            >
              PR #{pr.number} ↗
            </a>
          ))}
          {story.ciState && story.ciUrl ? (
            <CiStatusLink
              state={story.ciState}
              url={story.ciUrl}
              failureNames={story.ciFailureNames}
            />
          ) : null}
        </div>
      ) : null}
      {error ? <p className="font-mono text-[11px] text-(--bad)">{error}</p> : null}
    </div>
  );
}
