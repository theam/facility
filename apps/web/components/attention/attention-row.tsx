import { cx, StatusDot } from "@facility/ui";
import Link from "next/link";
import { AttentionActions } from "@/components/story/attention-actions";
import { type AttentionEntry, relativeTime, storyHref } from "@/lib/overview-presentation";

/**
 * One thing waiting on a person, with the verb that handles it. The overview
 * renders it compact (a two-line summary, no technical details) so the block
 * stays scannable; the attention page renders it in full.
 */
export function AttentionRow({
  entry,
  projectId,
  now,
  canExecute,
  compact = false,
}: {
  entry: AttentionEntry;
  projectId: string;
  now: Date;
  canExecute: boolean;
  compact?: boolean;
}) {
  return (
    <article
      className={cx(
        "flex flex-col border-t border-(--line)",
        compact ? "gap-1.5 py-3" : "gap-2 py-4",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={entry.tone} />
        <p className={cx("font-medium", entry.resolved ? "text-(--mut)" : undefined)}>
          {entry.title}
        </p>
        {entry.at ? (
          <time dateTime={entry.at} className="text-[11.5px] text-(--dim)">
            {relativeTime(entry.at, now)}
          </time>
        ) : null}
        {entry.resolved ? (
          <span className="text-[11.5px] text-(--dim)">
            {entry.resolved.label}
            {entry.resolved.at ? ` ${relativeTime(entry.resolved.at, now)}` : ""}
          </span>
        ) : null}
      </div>
      {entry.storyId ? (
        <Link
          href={storyHref(projectId, entry.storyId)}
          className="w-fit text-sm text-(--ink) hover:underline"
        >
          {entry.storyTitle} →
        </Link>
      ) : entry.storyTitle ? (
        <p className="text-sm text-(--ink)">{entry.storyTitle}</p>
      ) : null}
      <p
        className={cx(
          "max-w-prose text-sm leading-relaxed text-(--mut)",
          compact ? "line-clamp-2" : undefined,
        )}
      >
        {entry.summary}
      </p>
      {entry.detail && !compact ? (
        <details className="text-xs text-(--dim)">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {entry.detail}
          </pre>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] [&>div]:mt-0">
        {entry.action ? (
          entry.action.external ? (
            <a
              href={entry.action.href}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) hover:underline"
            >
              {entry.action.label} ↗
            </a>
          ) : (
            <Link href={entry.action.href} className="text-(--info) hover:underline">
              {entry.action.label} →
            </Link>
          )
        ) : null}
        {entry.item && entry.storyId && canExecute ? (
          <AttentionActions
            projectId={projectId}
            storyId={entry.storyId}
            replyAnchor={false}
            item={{
              id: entry.item.id,
              kind: entry.item.kind,
              turnId: entry.item.turnId,
              title: entry.item.title,
              detail: entry.item.detail,
              createdAt: entry.item.createdAt,
              status: "open",
              resolution: null,
              resolvedBy: null,
              resolvedAt: null,
            }}
          />
        ) : null}
      </div>
    </article>
  );
}
