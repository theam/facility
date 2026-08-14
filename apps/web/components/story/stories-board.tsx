"use client";

import { TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { IssueRow } from "@/components/issues/issue-row";
import { StageSection } from "@/components/project/stage-section";
import type { PipelineStage, PipelineStory } from "@/lib/pipeline";
import { storyHref } from "@/lib/pipeline";

export type BoardStage = Pick<PipelineStage, "key" | "label" | "sub" | "kind"> & {
  stories: PipelineStory[];
};

type JumpState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "not-found"; number: number }
  | { status: "ambiguous"; number: number };

/**
 * Client-side filter over the stories already on the board, plus a number
 * jump that escapes the board's 7-day window by asking the server directly.
 * Ambiguous numbers (same number in more than one connected repo) currently
 * only surface a message — the API's 409 doesn't yet return the candidate
 * repos, so there's nothing to build a picker out of. See PR description.
 */
export function StoriesBoard({
  projectId,
  stages,
  canTrigger,
}: {
  projectId: string;
  stages: BoardStage[];
  canTrigger: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState<JumpState>({ status: "idle" });

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
  const localMatch =
    bareNumber !== null
      ? stages.flatMap((stage) => stage.stories).find((story) => story.number === bareNumber)
      : undefined;

  async function jumpToNumber(number: number) {
    setJump({ status: "checking" });
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/stories/${number}`);
      if (res.status === 404) {
        setJump({ status: "not-found", number });
        return;
      }
      if (res.status === 409) {
        setJump({ status: "ambiguous", number });
        return;
      }
      if (!res.ok) {
        setJump({ status: "not-found", number });
        return;
      }
      const story = (await res.json()) as {
        number: number;
        repoId: string;
        storyType: "issue" | "pull_request";
      };
      router.push(storyHref(projectId, story));
    } catch {
      setJump({ status: "not-found", number });
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (bareNumber === null) return;
    if (localMatch) {
      router.push(storyHref(projectId, localMatch));
      return;
    }
    void jumpToNumber(bareNumber);
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="max-w-sm">
        <TextInput
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setJump({ status: "idle" });
          }}
          placeholder="Filter by title, or press Enter on a story number…"
          aria-label="Filter stories"
        />
      </form>

      {jump.status === "checking" ? (
        <p className="text-[12.5px] text-(--dim)">Checking older stories for #{bareNumber}…</p>
      ) : null}

      {jump.status === "not-found" ? (
        <p className="text-[12.5px] text-(--dim)">
          No story numbered #{jump.number} in this project.
        </p>
      ) : null}

      {jump.status === "ambiguous" ? (
        <p className="text-[12.5px] text-(--dim)">
          #{jump.number} exists in more than one repository in this project — open it from that
          repository's board to disambiguate.
        </p>
      ) : null}

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
