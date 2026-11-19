import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoryActivityItem, StoryTurnActivityPage } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyActivityPath } from "@/lib/story-paths";

const REFRESH_MS = 2_000;

/** The run details endpoint already persists and pages the engine stream. */
export function ConversationProgress({
  projectId,
  storyId,
  turnId,
  state,
  finalResponse,
}: {
  projectId: string;
  storyId: string;
  turnId: string;
  state: string;
  finalResponse?: string;
}) {
  const [entries, setEntries] = useState<StoryActivityItem[]>([]);
  const cursor = useRef(0);
  const router = useRouter();
  const refresh = useRef(router.refresh);
  refresh.current = router.refresh;
  useEffect(() => {
    const active = state === "queued" || state === "running";
    let observedState = state;
    let alive = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      const after = cursor.current;
      const result = await clientApi<StoryTurnActivityPage>(
        "GET",
        `${storyActivityPath(projectId, storyId, turnId, undefined, after)}&view=progress`,
      );
      busy = false;
      if (!alive) return;
      let more = false;
      if (result.ok && result.data?.turn?.id === turnId && result.data.order === "asc") {
        const { items, has_more, next_cursor, turn } = result.data;
        const newest = items.at(-1)?.seq ?? after;
        const next = has_more && next_cursor !== null && next_cursor > after ? next_cursor : null;
        more = next !== null;
        cursor.current = next ?? newest;
        if (active && turn.state !== observedState) {
          observedState = turn.state;
          refresh.current();
        }
        setEntries((current) => [
          ...current,
          ...items.filter(
            (item) => item.kind === "message" && item.turn_id === turnId && item.seq > after,
          ),
        ]);
      }
      if (active || more) timer = setTimeout(() => void read(), REFRESH_MS);
    }
    function onVisible() {
      clearTimeout(timer);
      void read();
    }
    void read();
    if (active) document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, storyId, turnId, state]);

  // Both engines can emit the final prose as an assistant item before Facility
  // stores the final response. Keep the final response in one place once known.
  const last = entries.at(-1);
  const duplicate =
    finalResponse !== undefined &&
    last?.text &&
    (last.text.trim() === finalResponse.trim() ||
      (last.truncated && finalResponse.trim().startsWith(last.text.slice(0, -1).trim())));
  const visible = duplicate ? entries.slice(0, -1) : entries;
  return (
    <ol aria-label="Agent progress" aria-live="polite" className="flex flex-col gap-2">
      {visible.map((entry) => (
        <li
          key={entry.seq}
          className="max-w-prose whitespace-pre-wrap break-words text-[13px] leading-relaxed text-(--mut)"
        >
          {entry.text}
        </li>
      ))}
    </ol>
  );
}
