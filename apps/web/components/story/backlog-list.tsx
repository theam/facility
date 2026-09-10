import { cx, StatusDot } from "@facility/ui";
import Link from "next/link";
import type { BacklogItem, BacklogPerson } from "@/lib/api";
import {
  activityLine,
  PHASES,
  personLabel,
  phaseLabel,
  phaseTone,
  relativeTime,
  type StoriesSearch,
  storiesHref,
  titleStatus,
} from "@/lib/backlog-presentation";
import { safeExternalUrl } from "@/lib/story-presentation";

const LABEL_LIMIT = 3;
const PERSON_LIMIT = 4;

/**
 * One row per unit of work. When the page is ordered by what needs action,
 * rows are grouped under their phase so the eye can skip whole sections.
 */
export function BacklogList({
  projectId,
  items,
  search,
  counts,
  canStart,
  now,
}: {
  projectId: string;
  items: BacklogItem[];
  search: StoriesSearch;
  counts: Record<BacklogItem["phase"], number>;
  canStart: boolean;
  now: Date;
}) {
  const grouped = search.sort === "priority" && search.phase.length !== 1;
  let lastPhase: BacklogItem["phase"] | null = null;
  return (
    <ol className="flex flex-col border border-(--line)">
      {items.map((item) => {
        const header = grouped && item.phase !== lastPhase;
        lastPhase = item.phase;
        return (
          <li key={item.key} className="flex flex-col">
            {header ? (
              <h3 className="flex items-center gap-2 border-b border-(--line) bg-(--bg-subtle) px-4 py-2 text-[11.5px] font-medium text-(--mut) sm:px-5">
                <StatusDot tone={phaseTone(item.phase)} />
                {phaseLabel(item.phase)}
                <span className="font-mono text-(--dim)">{counts[item.phase]}</span>
              </h3>
            ) : null}
            <BacklogRow
              projectId={projectId}
              item={item}
              canStart={canStart}
              search={search}
              now={now}
            />
          </li>
        );
      })}
    </ol>
  );
}

function BacklogRow({
  projectId,
  item,
  canStart,
  search,
  now,
}: {
  projectId: string;
  item: BacklogItem;
  canStart: boolean;
  search: StoriesSearch;
  now: Date;
}) {
  const storyHref = item.story
    ? `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(item.story.id)}`
    : null;
  const issueUrl = safeExternalUrl(item.issue?.url ?? null);
  const pullUrl = safeExternalUrl(item.pullRequest?.url ?? null);
  const running = item.activity.state === "running";
  const status = titleStatus({ titleSource: item.titleSource, createdAt: item.story?.createdAt });
  const extraLabels = Math.max(0, item.labels.length - LABEL_LIMIT);
  const startHref = `${storiesHref(projectId, search, { start: undefined })}${
    storiesHref(projectId, search).includes("?") ? "&" : "?"
  }start=${encodeURIComponent(item.key)}#new-story`;

  return (
    <article
      className="grid gap-x-6 gap-y-2 border-b border-(--line) px-4 py-3 last:border-b-0 hover:bg-(--bg-subtle) sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]"
      aria-label={item.title}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <StatusDot tone={phaseTone(item.phase)} pulse={running} className="mt-[7px]" />
          <div className="min-w-0 flex-1">
            <h4 className="text-[13.5px] font-medium leading-snug text-(--ink)">
              {storyHref ? (
                <Link href={storyHref} className="hover:underline">
                  {item.title}
                </Link>
              ) : issueUrl ? (
                <a href={issueUrl} target="_blank" rel="noreferrer" className="hover:underline">
                  {item.title}
                </a>
              ) : pullUrl ? (
                <a href={pullUrl} target="_blank" rel="noreferrer" className="hover:underline">
                  {item.title}
                </a>
              ) : (
                item.title
              )}
              {status ? (
                <span className="ml-2 text-[11px] font-normal text-(--dim)">{status}</span>
              ) : null}
            </h4>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-(--dim)">
              {item.issue && issueUrl ? (
                <a
                  href={issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:text-(--ink)"
                  title={`${item.issue.repository} issue #${item.issue.number}`}
                >
                  {item.issue.repository}#{item.issue.number}
                </a>
              ) : item.story?.provider === "manual" ? (
                <span>Started in Facility</span>
              ) : item.story?.provider === "schedule" ? (
                <span>Scheduled</span>
              ) : null}
              {item.pullRequest && pullUrl ? (
                <a
                  href={pullUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:text-(--ink)"
                  title={`Pull request #${item.pullRequest.number} · ${item.pullRequest.state}${item.pullRequest.draft ? " · draft" : ""}`}
                >
                  PR #{item.pullRequest.number}
                  {item.pullRequest.draft ? " draft" : ""}
                </a>
              ) : null}
              {item.story?.branch ? (
                <span className="truncate font-mono" title="Branch">
                  {item.story.branch}
                </span>
              ) : null}
              {item.labels.slice(0, LABEL_LIMIT).map((label) => (
                <Link
                  key={label}
                  href={storiesHref(projectId, search, { label: [label], page: 1 })}
                  className="border border-(--line) px-1.5 py-px text-[10.5px] text-(--mut) hover:border-(--line-strong) hover:text-(--ink)"
                >
                  {label}
                </Link>
              ))}
              {extraLabels > 0 ? (
                <span className="text-[10.5px]" title={item.labels.slice(LABEL_LIMIT).join(", ")}>
                  +{extraLabels}
                </span>
              ) : null}
              {item.issue?.stale ? (
                <span title={`Mirror last synced ${relativeTime(item.issue.syncedAt, now)}`}>
                  GitHub data may be stale
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 lg:items-end lg:text-right">
        <p
          className={cx(
            "text-[12px] leading-snug",
            item.phase === "attention"
              ? "text-(--bad)"
              : running
                ? "text-(--accent)"
                : "text-(--mut)",
          )}
        >
          {activityLine(item, now)}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--dim) lg:justify-end">
          <People people={item.assignees} projectId={projectId} search={search} />
          <time dateTime={item.lastActivityAt} title="Last activity">
            {relativeTime(item.lastActivityAt, now)}
          </time>
        </div>
        <nav
          aria-label={`Links for ${item.title}`}
          className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] lg:justify-end"
        >
          {storyHref ? (
            <Link href={storyHref} className="text-(--info) underline-offset-4 hover:underline">
              Story →
            </Link>
          ) : null}
          {storyHref && item.activity.turnId ? (
            <Link
              href={`${storyHref}#run-${item.activity.turnId}`}
              className="text-(--accent) underline-offset-4 hover:underline"
            >
              Run →
            </Link>
          ) : null}
          {issueUrl ? (
            <a
              href={issueUrl}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              Issue ↗
            </a>
          ) : null}
          {pullUrl ? (
            <a
              href={pullUrl}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              PR ↗
            </a>
          ) : null}
          {canStart && item.kind === "issue" && item.phase === "not_started" ? (
            <Link
              href={startHref}
              className="border border-(--accent) px-2 py-px text-(--accent) hover:bg-(--accent) hover:text-black"
            >
              Start
            </Link>
          ) : null}
        </nav>
      </div>
    </article>
  );
}

function People({
  people,
  projectId,
  search,
}: {
  people: BacklogPerson[];
  projectId: string;
  search: StoriesSearch;
}) {
  if (people.length === 0) return <span>Unassigned</span>;
  const shown = people.slice(0, PERSON_LIMIT);
  const extra = people.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((person) => {
        const sources = person.sources
          .map((source) => (source === "github" ? "assigned on GitHub" : "working in Facility"))
          .join(", ");
        return (
          <Link
            key={person.key}
            href={storiesHref(projectId, search, { assignee: [person.key], page: 1 })}
            title={`${personLabel(person)} · ${sources}`}
            className="inline-flex items-center gap-1 hover:text-(--ink)"
          >
            {person.avatarUrl ? (
              // biome-ignore lint/performance/noImgElement: avatars come from arbitrary GitHub hosts.
              <img
                src={person.avatarUrl}
                alt=""
                width={16}
                height={16}
                className="size-4 rounded-full"
              />
            ) : (
              <span
                aria-hidden
                className="inline-flex size-4 items-center justify-center rounded-full bg-(--card) text-[9px] font-medium uppercase text-(--mut)"
              >
                {personLabel(person).replace(/^@/, "").slice(0, 1)}
              </span>
            )}
            <span className="max-w-[9rem] truncate">{personLabel(person)}</span>
          </Link>
        );
      })}
      {extra > 0 ? <span>+{extra}</span> : null}
    </span>
  );
}

export function PhaseChips({
  projectId,
  search,
  counts,
}: {
  projectId: string;
  search: StoriesSearch;
  counts: Record<BacklogItem["phase"], number>;
}) {
  const selected =
    search.phase.length === 0 ? "open" : search.phase.length === 1 ? search.phase[0] : "custom";
  const open = counts.attention + counts.in_progress + counts.review + counts.not_started;
  const all = open + counts.done + counts.archived;
  const chips = [
    { value: "open", label: "Open", count: open },
    ...PHASES.map((phase) => ({
      value: phase.value,
      label: phase.label,
      count: counts[phase.value],
    })),
    { value: "all", label: "All", count: all },
  ];
  return (
    <nav aria-label="Work phase" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <Link
          key={chip.value}
          href={storiesHref(projectId, search, {
            phase: chip.value === "open" ? [] : [chip.value],
            page: 1,
          })}
          aria-current={selected === chip.value ? "page" : undefined}
          className={cx(
            "inline-flex h-8 items-center gap-1.5 border px-2.5 text-[12px] transition-colors",
            selected === chip.value
              ? "border-(--line-strong) text-(--ink)"
              : "border-(--line) text-(--mut) hover:text-(--ink)",
          )}
        >
          {chip.label}
          <span className="font-mono text-[10.5px] text-(--dim)">{chip.count}</span>
        </Link>
      ))}
    </nav>
  );
}
