"use client";

import { cx, StatusDot } from "@facility/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { IssueRow } from "@/components/issues/issue-row";
import { StageSection } from "@/components/project/stage-section";
import type {
  PipelineStage,
  PipelineStageKey,
  PipelineStageKind,
  PipelineStageState,
  PipelineStory,
} from "@/lib/pipeline";
import { pipelineStageStateLabel } from "@/lib/pipeline";

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

interface StoriesBoardProps {
  projectId: string;
  stages: PipelineStage[];
  activeStage: PipelineStageKey | null;
  activeStatus: PipelineStageState | null;
  myGithubLogin: string | null | undefined;
  canTrigger: boolean;
  builderPlanRequired: boolean;
  assigneeFilter: string | null | undefined;
  initialItems: PipelineStory[];
}

export function StoriesBoard({
  projectId,
  stages,
  activeStage,
  activeStatus,
  myGithubLogin,
  canTrigger,
  builderPlanRequired,
  assigneeFilter,
  initialItems,
}: StoriesBoardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const [showNumberJump, setShowNumberJump] = useState(false);
  const [jumpNumber, setJumpNumber] = useState("");

  // Parse query for number jump
  const isNumberQuery = /^#?\d+$/.test(query.trim());
  const parsedNumber = isNumberQuery ? parseInt(query.trim().replace("#", ""), 10) : null;

  // Filter stories client-side
  const filteredItems = useMemo(() => {
    if (!query.trim() && !assigneeFilter) return initialItems;

    const q = query.trim().toLowerCase();
    return initialItems.filter((story) => {
      // Assignee filter
      if (assigneeFilter && !story.assignees.includes(assigneeFilter)) return false;

      // Text filter
      if (q) {
        const matchesNumber = story.number.toString().includes(q);
        const matchesTitle = story.title.toLowerCase().includes(q);
        const matchesRepo = `${story.repoOwner}/${story.repoName}`.toLowerCase().includes(q);
        const matchesAssignee = story.assignees.some((a) => a.toLowerCase().includes(q));
        if (!matchesNumber && !matchesTitle && !matchesRepo && !matchesAssignee) return false;
      }

      return true;
    });
  }, [initialItems, query, assigneeFilter]);

  // Group filtered items by stage
  const counts = [...stages].reverse();
  const stageFiltered = activeStage
    ? counts.filter((candidate) => candidate.key === activeStage)
    : counts;

  const visibleStages = useMemo(() => {
    if (activeStatus) {
      return stageFiltered.map((candidate) => ({
        ...candidate,
        stories: candidate.stories.filter(
          (story) =>
            story.stageState === activeStatus && filteredItems.some((f) => f.key === story.key),
        ),
      }));
    }
    return stageFiltered.map((candidate) => ({
      ...candidate,
      stories: candidate.stories.filter((story) => filteredItems.some((f) => f.key === story.key)),
    }));
  }, [activeStatus, stageFiltered, filteredItems]);

  const activeStatusLabel =
    activeStage && activeStatus
      ? pipelineStageStateLabel(
          activeStage,
          activeStatus,
          visibleStages.reduce((total, candidate) => total + candidate.stories.length, 0),
        )
      : null;

  const assigneeFilterActive = assigneeFilter === "mine";

  const handleSearchChange = (value: string) => {
    setQuery(value);
    const trimmed = value.trim();
    const isNum = /^#?\d+$/.test(trimmed);
    setShowNumberJump(isNum && trimmed.length > 0);
    if (isNum) {
      setJumpNumber(trimmed.replace("#", ""));
    }
  };

  const handleNumberJump = () => {
    if (jumpNumber) {
      const repoId = new URLSearchParams(searchParams.toString()).get("repoId");
      const href = `/projects/${projectId}/stories/${jumpNumber}${repoId ? `?repoId=${repoId}` : ""}`;
      router.push(href);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && showNumberJump) {
      e.preventDefault();
      handleNumberJump();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Search filter box */}
      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Filter stories by number, title, repo, assignee…"
          className="w-full border border-(--line) bg-(--bg) px-4 py-2.5 pr-12 font-mono text-[13px] text-(--ink) placeholder:text-(--dim) outline-none focus:border-(--line-strong) transition-colors"
          aria-label="Filter stories"
        />
        {showNumberJump && parsedNumber && (
          <button
            type="button"
            onClick={handleNumberJump}
            className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11px] text-(--info) hover:text-(--ink) hover:underline"
            aria-label={`Go to story #${parsedNumber}`}
          >
            Go to story #{parsedNumber}
          </button>
        )}
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-(--dim) hover:text-(--ink)"
            aria-label="Clear filter"
          >
            ×
          </button>
        )}
      </div>

      {/* Stage filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/projects/${projectId}/stories`}
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
            href={`/projects/${projectId}/stories?stage=${s.key}`}
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
                s.count > 0 ? FILTER_COUNT_TONE[s.kind] : "text-(--dim)",
              )}
            >
              {s.count}
            </span>
          </Link>
        ))}
        {activeStage && activeStatusLabel ? (
          <>
            <span className="font-mono text-[11px] text-(--dim)">/</span>
            <span className="inline-flex items-center gap-2 border border-(--line-strong) px-3 py-1.5 text-[12px] font-medium text-(--ink)">
              {activeStatusLabel}
              <Link
                href={`/projects/${projectId}/stories?stage=${activeStage}`}
                aria-label="clear status filter"
                className="text-(--dim) hover:text-(--ink)"
              >
                ×
              </Link>
            </span>
          </>
        ) : null}
        {myGithubLogin ? (
          <Link
            href={`/projects/${projectId}/stories${activeStage ? `?stage=${activeStage}` : ""}${assigneeFilterActive ? "" : `&assignee=mine`}`}
            className={cx(
              "inline-flex items-center gap-2 border px-3 py-1.5 text-[12px] font-medium transition-colors",
              assigneeFilterActive
                ? "border-(--line-strong) text-(--ink)"
                : "border-(--line) text-(--mut) hover:text-(--ink)",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="size-4 rounded-full border border-(--line) bg-(--bg-subtle) font-mono text-[10px] font-medium text-(--ink)">
                {myGithubLogin.charAt(0).toUpperCase()}
              </span>
              <span className="font-mono text-[11px]">mine</span>
            </span>
            {assigneeFilterActive && (
              <Link
                href={`/projects/${projectId}/stories${activeStage ? `?stage=${activeStage}` : ""}`}
                aria-label="clear assignee filter"
                className="text-(--dim) hover:text-(--ink)"
              >
                ×
              </Link>
            )}
          </Link>
        ) : null}
      </div>

      {/* Stories list */}
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
                  {query ? "No stories match your filter." : "Nothing here right now."}
                </p>
              ) : (
                <div className="flex flex-col border border-(--line)">
                  {stageItems.map((story) => (
                    <IssueRow
                      key={story.key}
                      projectId={projectId}
                      story={story}
                      canTrigger={canTrigger}
                      builderPlanRequired={builderPlanRequired}
                    />
                  ))}
                </div>
              )}
            </StageSection>
          );
        })}
      </div>
    </div>
  );
}