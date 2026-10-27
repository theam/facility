"use client";

import { useState } from "react";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import type { StoryTimelineEntry, StoryTimelinePage } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyTimelinePath } from "@/lib/story-paths";
import {
  formatTime,
  type GitFileStatusTone,
  gitFileStatus,
  githubCommitUrl,
  parseGitChanges,
  timelineSummary,
} from "@/lib/story-presentation";

const STATUS_TONE_CLASSES: Record<GitFileStatusTone, string> = {
  ok: "border-(--ok)/40 text-(--ok)",
  agent: "border-(--accent)/40 text-(--accent)",
  bad: "border-(--bad)/40 text-(--bad)",
  info: "border-(--info)/40 text-(--info)",
  dim: "border-(--line) text-(--dim)",
};

function GitChangesDetail({
  data,
  pullRequestUrl,
}: {
  data: Record<string, unknown>;
  pullRequestUrl?: string | null;
}) {
  const changes = parseGitChanges(data);
  if (!changes) return null;

  const commitCount = changes.commits.length;
  const fileCount = changes.changedFiles.length;

  return (
    <details className="group/git mt-2 border border-(--line) bg-(--bg-subtle)">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] text-(--mut) hover:text-(--ink)">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span
            aria-hidden="true"
            className="inline-block transition-transform group-open/git:rotate-90"
          >
            ▸
          </span>
          Inspect changed files and commits
        </span>
        <span className="inline-flex items-center gap-2 font-mono text-[10px] text-(--dim)">
          {commitCount > 0 ? (
            <span>
              {commitCount} {commitCount === 1 ? "commit" : "commits"}
            </span>
          ) : null}
          {commitCount > 0 && fileCount > 0 ? <span>·</span> : null}
          {fileCount > 0 ? (
            <span>
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </span>
      </summary>

      <div className="flex flex-col gap-4 border-t border-(--line) p-3 text-[11px]">
        {changes.commits.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-(--dim)">
              Commits ({changes.commits.length})
            </p>
            <ol className="flex flex-col divide-y divide-(--line) border border-(--line)">
              {changes.commits.map((commit, index) => {
                const shortSha = commit.sha.slice(0, 7);
                const commitUrl = githubCommitUrl(pullRequestUrl, commit.sha);
                return (
                  <li
                    key={`${commit.sha}-${index}`}
                    className="flex flex-col gap-1 p-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                  >
                    <div className="flex min-w-0 items-baseline gap-2">
                      {commitUrl ? (
                        <a
                          href={commitUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 font-mono text-[11px] text-(--info) hover:underline"
                        >
                          {shortSha} ↗
                        </a>
                      ) : (
                        <span className="shrink-0 font-mono text-[11px] text-(--ink)">
                          {shortSha}
                        </span>
                      )}
                      <span className="break-words text-(--ink)">{commit.subject}</span>
                    </div>
                    <div className="shrink-0 text-[10px] text-(--dim)">
                      <span>{commit.author}</span>
                      {commit.authoredAt ? (
                        <>
                          <span> · </span>
                          <time dateTime={commit.authoredAt}>{formatTime(commit.authoredAt)}</time>
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {changes.changedFiles.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-(--dim)">
              Changed files ({changes.changedFiles.length})
            </p>
            <ul className="flex flex-col divide-y divide-(--line) border border-(--line)">
              {changes.changedFiles.map((file, index) => {
                const statusInfo = gitFileStatus(file.status);
                return (
                  <li
                    key={`${file.path}-${index}`}
                    className="flex items-baseline gap-2.5 p-2 font-mono text-[11px]"
                  >
                    <span
                      title={statusInfo.label}
                      className={`shrink-0 border px-1 py-0.5 text-[10px] leading-none ${STATUS_TONE_CLASSES[statusInfo.tone]}`}
                    >
                      [{statusInfo.code}]
                    </span>
                    <span className="min-w-0 break-all text-(--ink)">
                      {statusInfo.code === "R" && file.previousPath ? (
                        <>
                          <span className="text-(--dim)">{file.previousPath}</span>
                          <span className="mx-1.5 text-(--dim)">→</span>
                          <span>{file.path}</span>
                        </>
                      ) : (
                        file.path
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {changes.dirty || changes.truncated ? (
          <div className="flex flex-col gap-1 border-t border-(--line) pt-2 text-[10.5px]">
            {changes.dirty ? (
              <p className="text-(--accent)">
                Uncommitted workspace modifications remained when this turn completed.
              </p>
            ) : null}
            {changes.truncated ? (
              <p className="text-(--dim)">
                Commit or file list was truncated after reaching maximum capture limits.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}


/** Evidence across the story, ten entries at a time, fetched only once opened. */
export function StoryTimeline({
  projectId,
  storyId,
  pullRequestUrl,
}: {
  projectId: string;
  storyId: string;
  pullRequestUrl?: string | null;
}) {
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
                  {entry.type === "git.changes_recorded" ? (
                    <GitChangesDetail data={entry.data} pullRequestUrl={pullRequestUrl} />
                  ) : null}
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
