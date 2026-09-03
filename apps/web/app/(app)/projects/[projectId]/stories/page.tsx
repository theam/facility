import { Eyebrow, StatusDot } from "@facility/ui";
import type { ReactNode } from "react";
import { StoriesBoard } from "@/components/issues/stories-board";
import { SyncIssuesButton } from "@/components/issues/sync-button";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import type { PipelineStageKey, PipelineStageKind, PipelineStageState } from "@/lib/pipeline";
import { pipelineStories } from "@/lib/pipeline";

export const metadata = { title: "stories" };

const _FILTER_DOT: Record<PipelineStageKind, ReactNode> = {
  human: <StatusDot tone="human" />,
  agent: <StatusDot tone="agent" />,
  machine: <StatusDot tone="machine" />,
  done: <StatusDot tone="ok" />,
};
const _FILTER_COUNT_TONE: Record<PipelineStageKind, string> = {
  human: "text-(--human)",
  agent: "text-(--ink)",
  machine: "text-(--info)",
  done: "text-(--ink)",
};

function hasPermission(permissions: string[], permission: string) {
  const [resource] = permission.split(":");
  return permissions.some((p) => p === "*" || p === permission || p === `${resource}:*`);
}

export default async function ProjectStoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ stage?: string; status?: string; assignee?: string }>;
}) {
  const [{ projectId }, { stage, status, assignee }] = await Promise.all([params, searchParams]);
  const [pipelineResult, me, project] = await Promise.all([
    api.pipeline(projectId),
    api.me(),
    api.project(projectId),
  ]);

  if (!pipelineResult.ok && pipelineResult.offline) return <Offline />;

  const permissions = me.ok ? me.data.permissions : [];
  const canTrigger = hasPermission(permissions, "runs:trigger");
  const canSync = hasPermission(permissions, "repos:write");
  const myGithubLogin = me.ok ? me.data.principal.githubLogin : null;
  const stages = pipelineResult.ok ? pipelineResult.data.stages : [];
  const stageKeys = new Set(stages.map((candidate) => candidate.key));
  const activeStage =
    stage && stageKeys.has(stage as PipelineStageKey) ? (stage as PipelineStageKey) : null;
  const items = pipelineResult.ok ? pipelineStories(pipelineResult.data) : [];
  const stageStates = new Set(items.map((story) => story.stageState));
  const activeStatus =
    activeStage && status && stageStates.has(status as PipelineStageState)
      ? (status as PipelineStageState)
      : null;

  const activeOpenStoryCount = items.filter((story) => story.state === "open").length;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>stories</Eyebrow>
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Stories</h1>
          <p className="text-[12.5px] text-(--dim)">
            {pipelineResult.ok
              ? `${activeOpenStoryCount} active open stories · closest to shipping on top`
              : "pipeline unavailable"}{" "}
            · the full life of each unit of work — synced with GitHub
          </p>
        </div>
        {canSync ? <SyncIssuesButton projectId={projectId} /> : null}
      </div>

      {!pipelineResult.ok ? (
        <ErrorNotice
          message={
            pipelineResult.status === 404
              ? "The story pipeline isn't available on this control plane yet."
              : `Couldn't load stories — ${pipelineResult.message}`
          }
        />
      ) : items.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No active stories right now. Closed and merged stories leave Shipped after seven days;
          sync refreshes the GitHub mirror.
        </p>
      ) : (
        <StoriesBoard
          projectId={projectId}
          stages={stages}
          activeStage={activeStage}
          activeStatus={activeStatus}
          myGithubLogin={myGithubLogin}
          canTrigger={canTrigger}
          builderPlanRequired={!project.ok || project.data.builderPlanPolicy === "required"}
          assigneeFilter={assignee}
          initialItems={items}
        />
      )}
    </div>
  );
}