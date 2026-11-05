"use client";

import { useState } from "react";
import { RunActivity } from "@/components/story/run-activity";
import type { WorkspaceStoryBundle } from "@/lib/api";
import { formatTime } from "@/lib/story-presentation";

export function StoryProgress({
  projectId,
  storyId,
  progress,
}: {
  projectId: string;
  storyId: string;
  progress: WorkspaceStoryBundle["progress"];
}) {
  const [inspected, setInspected] = useState<{ id: string; agent: string } | null>(null);
  const latest = progress?.latest;
  const excerpt = latest?.activity.text?.slice(0, 240);
  return (
    <section
      id="story-progress"
      aria-label="Latest recorded activity"
      className="min-w-0 border border-(--line) bg-(--bg-subtle) p-4"
    >
      <h2 className="text-sm font-semibold">Latest recorded activity</h2>
      {!progress ? (
        <p className="mt-2 text-sm text-(--mut)">
          Latest activity is unavailable from this server.
        </p>
      ) : !latest ? (
        <p className="mt-2 text-sm text-(--mut)">
          No work activity recorded yet. Health checks alone do not establish progress.
        </p>
      ) : (
        <>
          <p className="mt-2 break-words text-sm">
            <span className="font-medium">{latest.turn.agentName}</span> · {latest.activity.title}
          </p>
          <p className="mt-1 text-xs text-(--mut)">
            <time dateTime={latest.activity.created_at}>
              {formatTime(latest.activity.created_at)}
            </time>{" "}
            · recorded engine or workflow event
          </p>
          {excerpt ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-(--mut)">
              {excerpt}
              {latest.activity.text && latest.activity.text.length > 240 ? "…" : ""}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setInspected({ id: latest.turn.id, agent: latest.turn.agentName })}
            className="mt-2 min-h-11 text-sm text-(--info) underline focus-visible:outline-2 focus-visible:outline-(--info)"
          >
            Inspect this run
          </button>
        </>
      )}
      {inspected ? (
        <div className="mt-3 min-w-0">
          <p className="text-xs text-(--mut)">
            Inspecting {inspected.agent} ·{" "}
            <span className="break-all font-mono">{inspected.id}</span>
            {latest && latest.turn.id !== inspected.id
              ? ". A newer run is shown above; this inspection stays on the selected run."
              : ""}
          </p>
          <RunActivity
            projectId={projectId}
            storyId={storyId}
            turnId={inspected.id}
            progressMessages={null}
            initiallyOpen
          />
        </div>
      ) : null}
    </section>
  );
}
