"use client";

import { useState } from "react";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import type { StoryEnvironment } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyEnvironmentPath } from "@/lib/story-paths";
import { formatTime } from "@/lib/story-presentation";

type EnvironmentEvent = StoryEnvironment["events"][number];

/** Provider events for the workspace, ten at a time, fetched only once opened. */
export function EnvironmentLogs({ projectId, storyId }: { projectId: string; storyId: string }) {
  const [events, setEvents] = useState<EnvironmentEvent[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);

  async function load(before?: number) {
    setState("loading");
    setError("");
    const result = await clientApi<StoryEnvironment>(
      "GET",
      storyEnvironmentPath(projectId, storyId, before),
    );
    if (!result.ok) {
      setState("error");
      setError(result.message);
      return;
    }
    const page = [...result.data.events].sort((a, b) => b.seq - a.seq);
    setEvents((current) => {
      const seen = new Set(current.map((event) => event.seq));
      return [...current, ...page.filter((event) => !seen.has(event.seq))];
    });
    setServices(
      (result.data.workspace.environment.ports ?? []).map(
        (service) => `${service.service}:${service.port} · ${result.data.inspection.state}`,
      ),
    );
    setState(result.data.has_more ? "idle" : "end");
  }

  const oldest = events.at(-1)?.seq;
  return (
    <details
      className="group"
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void load();
        }
      }}
    >
      <summary className="cursor-pointer list-none text-sm font-medium">
        <span
          aria-hidden="true"
          className="mr-2 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Environment logs
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {services.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {services.map((service) => (
              <span
                key={service}
                className="border border-(--line) px-2 py-1 font-mono text-[10px] text-(--mut)"
              >
                {service}
              </span>
            ))}
          </div>
        ) : null}
        {events.length === 0 && state === "end" ? (
          <p className="text-[12px] text-(--dim)">No environment events yet.</p>
        ) : events.length > 0 ? (
          <div className="max-h-96 overflow-auto border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[10.5px] leading-relaxed">
            {events.map((event) => (
              <div key={event.seq} className="mb-3 last:mb-0">
                <p className="text-(--accent)">
                  {event.seq} · {event.type}
                  <span className="ml-2 text-(--dim)">{formatTime(event.createdAt)}</span>
                </p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-(--mut)">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        ) : null}
        {opened ? (
          <LoadMore
            state={state}
            label="Older events"
            endLabel={events.length > 0 ? "First environment event." : ""}
            error={error}
            onLoad={() => void load(oldest)}
          />
        ) : null}
      </div>
    </details>
  );
}
