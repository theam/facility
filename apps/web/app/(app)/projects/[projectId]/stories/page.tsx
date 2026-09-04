import { cx, Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { IssueRow } from "@/components/issues/issue-row";
import { SyncIssuesButton } from "@/components/issues/sync-button";
import { ErrorNotice, Offline } from "@/components/offline";
import { StageSection } from "@/components/project/stage-section";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import type { PipelineStageKey, PipelineStageKind, PipelineStageState } from "@/lib/pipeline";
import {
  boardHref,
  type MeOutcome,
  mineFilterState,
  ownedBy,
  pipelineStageStateLabel,
  pipelineStories,
} from "@/lib/pipeline";

export const metadata = { title: "stories" };

const FILTER_DOT: Record<PipelineStageKind, ReactNode> = {
  human: <StatusDot tone="human" />,
  agent: <StatusDot tone="agent" />,
  machine: <StatusDot tone="machine" />,
  done: <StatusDot tone="ok" />,
};
const FILTER_COUNT_TONE: Record<PipelineStageKind, string> = {
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
  searchParams: Promise<{ stage?: string; status?: string; mine?: string }>;
}) {
  const [{ projectId }, { stage, status, mine }] = await Promise.all([params, searchParams]);
  const [pipelineResult, meResult, project] = await Promise.all([
    api.pipeline(projectId),
    api.me(),
    api.project(projectId),
  ]);

  if (!pipelineResult.ok && pipelineResult.offline) return <Offline />;

  // The identity request is allowed to fail independently of the pipeline: a
  // partial failure must not silently downgrade `?mine=1` into "show
  // everything", so the outcome — not just the login — feeds the filter.
  const me: MeOutcome = meResult.ok
    ? { ok: true, githubLogin: meResult.data.principal.githubLogin }
    : { ok: false, message: meResult.message };
  const permissions = me.ok && meResult.ok ? meResult.data.permissions : [];
  const canTrigger = hasPermission(permissions, "runs:trigger");
  const canSync = hasPermission(permissions, "repos:write");
  const viewerLogin = me.ok ? me.githubLogin : undefined;
  const mineState = mineFilterState(mine, me);
  const stages = pipelineResult.ok ? pipelineResult.data.stages : [];
  const stageKeys = new Set(stages.map((candidate) => candidate.key));
  const activeStage =
    stage && stageKeys.has(stage as PipelineStageKey) ? (stage as PipelineStageKey) : null;
  // Validated against every story, not just the mine-scoped set, so a status filter
  // never silently drops out of the URL when "mine" empties the board.
  const items = pipelineResult.ok ? pipelineStories(pipelineResult.data) : [];
  const stageStates = new Set(items.map((story) => story.stageState));
  const activeStatus =
    activeStage && status && stageStates.has(status as PipelineStageState)
      ? (status as PipelineStageState)
      : null;
  const scoped =
    mineState.kind === "on"
      ? stages.map((s) => ({
          ...s,
          stories: s.stories.filter((story) => ownedBy(story.assignees, mineState.login)),
        }))
      : stages;
  const mineOn = mineState.kind === "on";
  const counts = [...scoped].reverse();
  const scopedTotal = scoped.reduce((total, s) => total + s.stories.length, 0);
  const activeOpenStoryCount = scoped
    .flatMap((s) => s.stories)
    .filter((story) => story.state === "open").length;

  const stageFiltered = activeStage
    ? counts.filter((candidate) => candidate.key === activeStage)
    : counts;
  const visibleStages = activeStatus
    ? stageFiltered.map((candidate) => ({
        ...candidate,
        stories: candidate.stories.filter((story) => story.stageState === activeStatus),
      }))
    : stageFiltered;
  const activeStatusLabel =
    activeStage && activeStatus
      ? pipelineStageStateLabel(
          activeStage,
          activeStatus,
          visibleStages.reduce((total, candidate) => total + candidate.stories.length, 0),
        )
      : null;

  const boardBody = () => (
    <div className="flex flex-col gap-6">
      {visibleStages.map((s) => {
        const stageItems = s.stories;
        return (
          <StageSection
            key={s.key}
            label={s.label}
            sub={s.sub}
            kind={s.kind}
            total={stageItems.length}
            liveCount={stageItems.filter((story) => story.runState === "live").length}
            failedCount={
              stageItems.filter(
                (story) => story.runState === "failed" || story.ciState === "failure",
              ).length
            }
            defaultOpen={activeStage !== null || s.key !== "shipped"}
          >
            {stageItems.length === 0 ? (
              <p className="border border-(--line) px-5 py-3.5 text-[12.5px] text-(--dim)">
                Nothing here right now.
              </p>
            ) : (
              <div className="flex flex-col border border-(--line)">
                {stageItems.map((story) => (
                  <IssueRow
                    key={story.key}
                    projectId={projectId}
                    story={story}
                    canTrigger={canTrigger}
                    builderPlanRequired={
                      !project.ok || project.data.builderPlanPolicy === "required"
                    }
                  />
                ))}
              </div>
            )}
          </StageSection>
        );
      })}
    </div>
  );

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

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={boardHref(projectId, { mine: mineOn })}
          className={cx(
            "border px-3 py-1.5 text-[12px] font-medium transition-colors",
            !activeStage
              ? "border-(--line-strong) text-(--ink)"
              : "border-(--line) text-(--mut) hover:text-(--ink)",
          )}
        >
          all
        </Link>
        {counts.map((s) => (
          <Link
            key={s.key}
            href={boardHref(projectId, { stage: s.key, mine: mineOn })}
            className={cx(
              "inline-flex items-center gap-2 border px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeStage === s.key
                ? "border-(--line-strong) text-(--ink)"
                : "border-(--line) text-(--mut) hover:text-(--ink)",
            )}
          >
            {FILTER_DOT[s.kind]}
            {s.label}
            <span
              className={cx(
                "font-mono text-[11px]",
                s.stories.length > 0 ? FILTER_COUNT_TONE[s.kind] : "text-(--dim)",
              )}
            >
              {s.stories.length}
            </span>
          </Link>
        ))}
        {activeStage && activeStatusLabel ? (
          <>
            <span className="font-mono text-[11px] text-(--dim)">/</span>
            <span className="inline-flex items-center gap-2 border border-(--line-strong) px-3 py-1.5 text-[12px] font-medium text-(--ink)">
              {activeStatusLabel}
              <Link
                href={boardHref(projectId, { stage: activeStage, mine: mineOn })}
                aria-label="clear status filter"
                className="text-(--dim) hover:text-(--ink)"
              >
                ×
              </Link>
            </span>
          </>
        ) : null}
        {viewerLogin ? (
          <Link
            href={boardHref(projectId, { stage: activeStage, status: activeStatus, mine: !mineOn })}
            className={cx(
              "border px-3 py-1.5 text-[12px] font-medium transition-colors",
              mineOn
                ? "border-(--line-strong) text-(--ink)"
                : "border-(--line) text-(--mut) hover:text-(--ink)",
            )}
          >
            mine
          </Link>
        ) : null}
      </div>

      {!pipelineResult.ok ? (
        <ErrorNotice
          message={
            pipelineResult.status === 404
              ? "The story pipeline isn't available on this control plane yet."
              : `Couldn't load stories — ${pipelineResult.message}`
          }
        />
      ) : mineState.kind === "blocked" ? (
        <ErrorNotice
          message={`Couldn't apply the "mine" filter — couldn't confirm who you are (${mineState.reason}). Reload to try again.`}
        />
      ) : mineState.kind === "on" && items.length > 0 && scopedTotal === 0 ? (
        <div className="flex flex-col items-start gap-3 border border-(--line) bg-(--bg-subtle) p-8">
          <p className="max-w-lg text-sm leading-relaxed text-(--mut)">
            Nothing is assigned to{" "}
            <span className="font-mono text-[12.5px]">@{mineState.login}</span> right now. Stories
            you're assigned to in GitHub will appear here after the next sync.
          </p>
          <Link
            href={boardHref(projectId, { stage: activeStage, status: activeStatus })}
            className="border border-(--line-strong) px-3 py-1.5 text-[12px] font-medium text-(--ink) transition-colors hover:bg-(--bg-subtle)"
          >
            show all stories
          </Link>
        </div>
      ) : items.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No active stories right now. Closed and merged stories leave Shipped after seven days;
          sync refreshes the GitHub mirror.
        </p>
      ) : (
        boardBody()
      )}
    </div>
  );
}
