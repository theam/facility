"use client";

import { TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { IssueRow } from "@/components/issues/issue-row";
import { StageSection } from "@/components/project/stage-section";
import type { PipelineStage, PipelineStory } from "@/lib/pipeline";
import { storyHref } from "@/lib/pipeline";
import { interpretJumpResponse, resolveLocalJump, type StoryMatch } from "@/lib/story-jump";

export type BoardStage = Pick<PipelineStage, "key" | "label" | "sub" | "kind"> & {
  stories: PipelineStory[];
};

type JumpState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "not-found"; number: number }
  | { status: "ambiguous"; number: number; matches: StoryMatch[] }
  | { status: "error"; number: number };

/**
 * Client-side filter over the stories already on the board, plus a number
 * jump that escapes the board's 7-day window by asking the server directly.
 * A number can be ambiguous either locally (two repos both loaded on the
 * board share it) or off-board (the server finds more than one match) —
 * both cases are reported explicitly rather than guessing the first match.
 *
 * jumpSeq guards against out-of-order async responses: if the user submits
 * a second number before the first request resolves, the stale response is
 * ignored rather than overwriting the newer state or navigating away.
 */
export function StoriesBoard({
  projectId,
  stages,
  canTrigger,
  builderPlanRequired,
}: {
  projectId: string;
  stages: BoardStage[];
  canTrigger: boolean;
  builderPlanRequired: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState<JumpState>({ status: "idle" });
  const jumpSeq = useRef(0);

  const trimmed = query.trim();
  const bareNumber = /^#?\d+$/.test(trimmed) ? Number(trimmed.replace("#", "")) : null;
  const needle = trimmed.toLowerCase().replace(/^#/, "");

  const filtered = useMemo(() => {
    if (!trimmed) return stages;
    return stages.map((stage) => ({
      ...stage,
      stories: stage.stories.filter(
        (story) => story.title.toLowerCase().includes(needle) || String(story.number) === needle,
      ),
    }));
  }, [stages, trimmed, needle]);

  const totalVisible = filtered.reduce((sum, stage) => sum + stage.stories.length, 0);

  async function jumpToNumber(number: number, seq: number) {
    setJump({ status: "checking" });
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/stories/${number}`);
      if (jumpSeq.current !== seq) return; // superseded by a later submission
      const outcome = await interpretJumpResponse(res);
      if (jumpSeq.current !== seq) return;
      if (outcome.kind === "match") {
        router.push(storyHref(projectId, outcome.story));
        return;
      }
      if (outcome.kind === "ambiguous") {
        setJump({ status: "ambiguous", number, matches: outcome.matches });
        return;
      }
      if (outcome.kind === "not-found") {
        setJump({ status: "not-found", number });
        return;
      }
      setJump({ status: "error", number });
    } catch {
      if (jumpSeq.current !== seq) return;
      setJump({ status: "error", number });
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (bareNumber === null) return;
    const seq = ++jumpSeq.current;
    const allStories = stages.flatMap((stage) => stage.stories);
    const local = resolveLocalJump(allStories, bareNumber);
    if (local.kind === "match") {
      router.push(storyHref(projectId, local.story));
      return;
    }
    if (local.kind === "ambiguous") {
      setJump({ status: "ambiguous", number: bareNumber, matches: local.matches });
      return;
    }
    void jumpToNumber(bareNumber, seq);
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="max-w-sm">
        <TextInput
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            jumpSeq.current += 1; // invalidate any in-flight lookup
            setJump({ status: "idle" });
          }}
          placeholder="Filter by title, or press Enter on a story number…"
          aria-label="Filter stories"
        />
      </form>

      <div aria-live="polite" className="flex flex-col gap-2">
        {jump.status === "checking" ? (
          <p className="text-[12.5px] text-(--dim)">Checking older stories for #{bareNumber}…</p>
        ) : null}

        {jump.status === "not-found" ? (
          <p className="text-[12.5px] text-(--dim)">
            No story numbered #{jump.number} in this project.
          </p>
        ) : null}

        {jump.status === "error" ? (
          <p className="text-[12.5px] text-(--dim)">
            Couldn't check story #{jump.number} right now — try again.
          </p>
        ) : null}

        {jump.status === "ambiguous" ? (
          jump.matches.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-(--dim)">
              <span>#{jump.number} exists in more than one repository — pick one:</span>
              {jump.matches.map((match) => (
                <Link
                  key={match.repoId}
                  href={storyHref(projectId, match)}
                  className="border border-(--line) px-2 py-1 font-mono text-[11px] text-(--ink) hover:border-(--line-strong)"
                >
                  {match.repoOwner}/{match.repoName}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-(--dim)">
              #{jump.number} exists in more than one repository in this project, but the specific
              repositories couldn't be determined — open it from that repository's board to
              disambiguate.
            </p>
          )
        ) : null}
      </div>

      {trimmed && totalVisible === 0 && jump.status === "idle" ? (
        <p className="text-[12.5px] text-(--dim)">
          {bareNumber !== null
            ? "Nothing on the board matches — press Enter to check older stories."
            : `No stories on the board match "${trimmed}".`}
        </p>
      ) : null}

      {filtered.map((stage) => {
        const stageItems = stage.stories;
        if (trimmed && stageItems.length === 0) return null;
        return (
          <StageSection
            key={stage.key}
            label={stage.label}
            sub={stage.sub}
            kind={stage.kind}
            total={stageItems.length}
            liveCount={stageItems.filter((story) => story.runState === "live").length}
            failedCount={
              stageItems.filter(
                (story) => story.runState === "failed" || story.ciState === "failure",
              ).length
            }
            defaultOpen={Boolean(trimmed) || stage.key !== "shipped"}
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
                    builderPlanRequired={builderPlanRequired}
                  />
                ))}
              </div>
            )}
          </StageSection>
        );
      })}
    </div>
  );
}
