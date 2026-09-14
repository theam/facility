"use client";

import { useState } from "react";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import type { StoryTimelineEntry, StoryTimelinePage } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyTimelinePath } from "@/lib/story-paths";
import { formatTime, timelineSummary } from "@/lib/story-presentation";

/** Evidence across the story, ten entries at a time, fetched only once opened. */
export function StoryTimeline({ projectId, storyId }: { projectId: string; storyId: string }) {
  const [entries, setEntries] = useState<StoryTimelineEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);

  async function load(before?: string) {
    setState("loading");
    setError("");
    const result = await clientApi<StoryTimelinePage>(
      "GET",
      storyTimelinePath(projectId, storyId, before),
    );
    if (!result.ok) {
      setState("error");
      setError(result.message);
      return;
    }
    setEntries((current) => {
      const seen = new Set(current.map((entry) => entry.id));
      return [...current, ...result.data.entries.filter((entry) => !seen.has(entry.id))];
    });
    setCursor(result.data.next_cursor);
    setState(result.data.has_more ? "idle" : "end");
  }

  return (
    <details
      className="group border border-(--line) p-5"
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void load();
        }
      }}
    >
      <summary className="cursor-pointer list-none font-medium">
        <span
          aria-hidden="true"
          className="mr-2 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Activity timeline and technical evidence
      </summary>
      <div className="mt-5 flex flex-col gap-3">
        <p className="text-[11.5px] text-(--dim)">
          Agent, workspace, Git and GitHub evidence in the order it happened, newest first.
        </p>
        {entries.length === 0 && state === "end" ? (
          <p className="text-[12px] text-(--dim)">No evidence has been recorded yet.</p>
        ) : entries.length > 0 ? (
          <ol className="flex flex-col border border-(--line)">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-2 border-b border-(--line) p-4 last:border-b-0 sm:grid-cols-[130px_minmax(0,1fr)]"
              >
                <div>
                  <p className="text-[11px] font-medium text-(--mut)">{entry.source}</p>
                  <time className="text-[10px] text-(--dim)" dateTime={entry.occurred_at}>
                    {formatTime(entry.occurred_at)}
                  </time>
                </div>
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-(--ink)">{entry.type}</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-(--mut)">
                    {timelineSummary(entry.type, entry.data)}
                  </p>
                  {entry.source === "agent" && typeof entry.data.text === "string" ? (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] text-(--dim)">
                      {entry.data.text}
                    </pre>
                  ) : null}
                  {entry.turn_id ? (
                    <p className="mt-1 font-mono text-[9.5px] text-(--dim)">run {entry.turn_id}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {opened ? (
          <LoadMore
            state={state}
            label="Older entries"
            endLabel={entries.length > 0 ? "Beginning of the story." : ""}
            error={error}
            onLoad={() => void load(cursor ?? undefined)}
          />
        ) : null}
      </div>
    </details>
  );
}
