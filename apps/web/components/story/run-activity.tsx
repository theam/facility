"use client";

import { useState } from "react";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import type { StoryActivityItem, StoryTurnActivityPage, StoryTurnEvent } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyActivityPath, storyTurnEventPath } from "@/lib/story-paths";
import { formatTime } from "@/lib/story-presentation";

const KIND_GLYPH: Record<StoryActivityItem["kind"], string> = {
  message: "💬",
  reasoning: "…",
  tool: "⚙",
  command: "$",
  file_change: "±",
  result: "✓",
  lifecycle: "•",
  error: "!",
  session: "#",
  other: "·",
};

/**
 * Progress messages and logs for one run. Nothing is fetched until the reader
 * opens it; pages of ten follow, newest first, and a single stored event is
 * fetched on its own only when asked for.
 */
export function RunActivity({
  projectId,
  storyId,
  turnId,
  progressMessages,
}: {
  projectId: string;
  storyId: string;
  turnId: string;
  progressMessages: number | null;
}) {
  const [items, setItems] = useState<StoryActivityItem[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);

  async function load(before?: number) {
    setState("loading");
    setError("");
    const result = await clientApi<StoryTurnActivityPage>(
      "GET",
      storyActivityPath(projectId, storyId, turnId, before),
    );
    if (!result.ok) {
      setState("error");
      setError(result.message);
      return;
    }
    setItems((current) => {
      const seen = new Set(current.map((item) => item.seq));
      return [...current, ...result.data.items.filter((item) => !seen.has(item.seq))];
    });
    setCursor(result.data.next_cursor);
    setState(result.data.has_more ? "idle" : "end");
  }

  return (
    <details
      className="group border-t border-(--line) pt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void load();
        }
      }}
    >
      <summary className="cursor-pointer list-none text-[12.5px] text-(--mut) hover:text-(--ink)">
        <span
          aria-hidden="true"
          className="mr-1.5 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Run details
        {progressMessages !== null && progressMessages > 0
          ? ` · ${progressMessages} progress message${progressMessages === 1 ? "" : "s"}`
          : ""}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-[11.5px] text-(--dim)">
          Activity the engine reported while working, newest first. Progress messages are what the
          agent said along the way; the final response is above.
        </p>
        {items.length === 0 && state === "end" ? (
          <p className="text-[12px] text-(--dim)">No activity was recorded for this run.</p>
        ) : (
          <ol className="flex flex-col border border-(--line)">
            {items.map((item) => (
              <ActivityRow
                key={item.seq}
                item={item}
                projectId={projectId}
                storyId={storyId}
                turnId={turnId}
              />
            ))}
          </ol>
        )}
        {opened ? (
          <LoadMore
            state={state}
            label="Older activity"
            endLabel={items.length > 0 ? "Start of this run." : ""}
            error={error}
            onLoad={() => void load(cursor ?? undefined)}
          />
        ) : null}
      </div>
    </details>
  );
}

function ActivityRow({
  item,
  projectId,
  storyId,
  turnId,
}: {
  item: StoryActivityItem;
  projectId: string;
  storyId: string;
  turnId: string;
}) {
  const [raw, setRaw] = useState<StoryTurnEvent | null>(null);
  const [rawState, setRawState] = useState<"idle" | "loading" | "error">("idle");
  const [rawError, setRawError] = useState("");
  const tone =
    item.kind === "error"
      ? "text-(--bad)"
      : item.kind === "result"
        ? "text-(--ok)"
        : item.kind === "message"
          ? "text-(--accent)"
          : "text-(--mut)";

  async function loadRaw() {
    setRawState("loading");
    setRawError("");
    const result = await clientApi<StoryTurnEvent>(
      "GET",
      storyTurnEventPath(projectId, storyId, turnId, item.seq),
    );
    if (!result.ok) {
      setRawState("error");
      setRawError(result.message);
      return;
    }
    setRaw(result.data);
    setRawState("idle");
  }

  return (
    <li className="grid gap-1 border-b border-(--line) p-3 last:border-b-0 sm:grid-cols-[24px_minmax(0,1fr)_auto]">
      <span aria-hidden="true" className={`font-mono text-[12px] ${tone}`}>
        {KIND_GLYPH[item.kind]}
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] text-(--ink)">
          <span className="sr-only">{item.kind.replaceAll("_", " ")}: </span>
          {item.title}
        </p>
        {item.text ? (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--mut)">
            {item.text}
          </pre>
        ) : null}
        {item.truncated || raw ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {item.truncated && !raw ? (
              <span className="text-(--dim)">
                Shortened here · {formatBytes(item.size_bytes)} stored
              </span>
            ) : null}
            {!raw ? (
              <button
                type="button"
                onClick={loadRaw}
                disabled={rawState === "loading"}
                className="text-(--info) underline-offset-4 hover:underline disabled:opacity-60"
              >
                {rawState === "loading" ? "loading…" : "Load the full stored event"}
              </button>
            ) : null}
            {rawState === "error" ? (
              <span role="alert" className="text-(--bad)">
                {rawError}
              </span>
            ) : null}
          </div>
        ) : null}
        {raw ? (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all border border-(--line) bg-(--bg-subtle) p-3 font-mono text-[10.5px] leading-relaxed text-(--mut)">
            {JSON.stringify(raw.data, null, 2)}
          </pre>
        ) : null}
      </div>
      <time className="font-mono text-[10px] text-(--dim)" dateTime={item.created_at}>
        {formatTime(item.created_at)}
      </time>
    </li>
  );
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
