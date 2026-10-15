"use client";

import { Button, TextArea } from "@facility/ui";
import { useState } from "react";
import { requestCompose } from "@/components/story/story-conversation";
import type { LocalReviewState } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

type Action = "load" | "approve" | "request" | "checks" | "refresh" | "export";

const BLOCKERS: Record<LocalReviewState["blockers"][number], string> = {
  story_branch_not_checked_out: "The workspace is not on the story branch.",
  uncommitted_changes: "There are uncommitted changes. Ask the agent to commit or discard them.",
  no_changes: "The story branch has no commits yet.",
  approval_required: "Approve the latest commit to export it.",
};

const APPROVAL: Record<LocalReviewState["approval"]["status"], string> = {
  none: "Not reviewed",
  approved: "Approved",
  stale: "Approval is stale — the story changed after it was approved",
  changes_requested: "Changes requested",
};

/**
 * Review for a story backed by a local repository, in place of a pull request:
 * the commits and files since the imported source, configured checks for the
 * exact head commit, approval of that commit, and exports the user imports into
 * their own repository. Nothing loads, and no workspace wakes, until opened.
 */
export function LocalReview({
  projectId,
  storyId,
  canExecute,
  canReview,
}: {
  projectId: string;
  storyId: string;
  canExecute: boolean;
  canReview: boolean;
}) {
  const [state, setState] = useState<LocalReviewState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState(false);
  const base = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/local-review`;

  async function run(action: Action, method: "GET" | "POST", path = "", body?: unknown) {
    setBusy(action);
    setError("");
    const result = await clientApi<LocalReviewState | { state: LocalReviewState }>(
      method,
      `${base}${path}`,
      body,
    );
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setState("state" in result.data ? result.data.state : result.data);
    return true;
  }

  const downloads = `/api${base}/exports`;
  return (
    <details
      className="group border border-(--line) p-5 lg:p-6"
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void run("load", "GET");
        }
      }}
    >
      <summary className="cursor-pointer list-none text-lg font-semibold">
        <span
          aria-hidden="true"
          className="mr-2 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Review and export
      </summary>
      <div className="mt-4 flex flex-col gap-5 text-sm">
        <p className="text-(--mut)">
          This story works on a Facility-managed copy of a local repository. Approve an exact
          commit, then import the export into your own checkout. Exporting never merges.
        </p>
        {error ? <p className="text-(--bad)">{error}</p> : null}
        {busy === "load" && !state ? <p className="text-(--dim)">Loading…</p> : null}
        {state ? (
          <>
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12.5px]">
              <dt className="text-(--mut)">Story branch</dt>
              <dd className="font-mono">{state.branch}</dd>
              <dt className="text-(--mut)">Head</dt>
              <dd className="font-mono">{state.headSha.slice(0, 12)}</dd>
              <dt className="text-(--mut)">Source</dt>
              <dd>
                <span className="font-mono">{state.repository.defaultBranch}</span> at{" "}
                <span className="font-mono">{state.sourceRevision.slice(0, 12)}</span>
                <span className="text-(--dim)">
                  {" "}
                  · imported {formatTime(state.sourceImportedAt)}
                </span>
              </dd>
              <dt className="text-(--mut)">Approval</dt>
              <dd className={state.approval.status === "approved" ? "text-(--ok)" : ""}>
                {APPROVAL[state.approval.status]}
                {state.approval.commitSha ? (
                  <span className="font-mono text-(--dim)">
                    {" "}
                    · {state.approval.commitSha.slice(0, 12)}
                  </span>
                ) : null}
                {state.approval.note ? (
                  <span className="block text-(--mut)">“{state.approval.note}”</span>
                ) : null}
              </dd>
            </dl>

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">Commits · {state.commits.length}</h3>
              {state.commits.length === 0 ? (
                <p className="text-(--dim)">No commits since the imported source.</p>
              ) : (
                <ul className="flex flex-col border border-(--line)">
                  {state.commits.map((commit) => (
                    <li
                      key={commit.sha}
                      className="flex gap-3 border-b border-(--line) px-3 py-2 last:border-b-0"
                    >
                      <span className="font-mono text-(--dim)">{commit.sha.slice(0, 8)}</span>
                      <span>{commit.subject}</span>
                    </li>
                  ))}
                </ul>
              )}
              {state.changedFiles.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-(--mut)">
                    Changed files · {state.changedFiles.length}
                  </summary>
                  <ul className="mt-2 font-mono text-[12px]">
                    {state.changedFiles.map((file) => (
                      <li key={file.path}>
                        <span className="text-(--dim)">{file.status}</span> {file.path}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {state.uncommitted.length > 0 ? (
                <p className="text-(--bad)">
                  {state.uncommitted.length} uncommitted change
                  {state.uncommitted.length === 1 ? "" : "s"} — unfinished work is not exported.
                </p>
              ) : null}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">Checks for this commit</h3>
              {state.checks.length === 0 ? (
                <p className="text-(--dim)">
                  No check results for {state.headSha.slice(0, 12)}. Configure environment.checks in
                  .facility.yml.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {state.checks.map((check) => (
                    <li key={check.name}>
                      <span className={check.exitCode === 0 ? "text-(--ok)" : "text-(--bad)"}>
                        {check.exitCode === 0 ? "passed" : `failed (${check.exitCode})`}
                      </span>{" "}
                      <span className="font-mono">{check.name}</span>
                      {check.exitCode !== 0 && (check.stderr || check.stdout) ? (
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-(--mut)">
                          {check.stderr || check.stdout}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {state.blockers.length > 0 ? (
              <ul className="list-disc pl-5 text-(--mut)">
                {state.blockers.map((blocker) => (
                  <li key={blocker}>{BLOCKERS[blocker]}</li>
                ))}
              </ul>
            ) : null}

            {canReview ? (
              <div className="flex flex-col gap-3">
                <TextArea
                  aria-label="Review note"
                  placeholder="Optional note for approval; required to request changes"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy !== null || state.dirty || state.commits.length === 0}
                    onClick={() =>
                      void run("approve", "POST", "/approve", {
                        commit_sha: state.headSha,
                        ...(note.trim() ? { note: note.trim() } : {}),
                      })
                    }
                  >
                    Approve {state.headSha.slice(0, 8)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !note.trim()}
                    onClick={async () => {
                      const requested = await run("request", "POST", "/request-changes", {
                        commit_sha: state.headSha,
                        note: note.trim(),
                      });
                      if (requested && canExecute) requestCompose();
                    }}
                  >
                    Request changes
                  </Button>
                </div>
              </div>
            ) : null}

            {canExecute ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void run("checks", "POST", "/checks")}
                >
                  {busy === "checks" ? "Running checks…" : "Run checks"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void run("refresh", "POST", "/refresh-source", {})}
                >
                  Refresh source from repository
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || !state.exportable}
                  onClick={() => void run("export", "POST", "/exports")}
                >
                  Export approved commits
                </Button>
              </div>
            ) : null}

            {state.exports.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h3 className="font-medium">Exports</h3>
                {state.exports.map((item) => (
                  <div key={item.id} className="flex flex-col gap-2 border border-(--line) p-3">
                    <p>
                      {item.commitCount} commit{item.commitCount === 1 ? "" : "s"} ·{" "}
                      <span className="font-mono">{item.headSha.slice(0, 12)}</span> ·{" "}
                      <span className="text-(--dim)">{formatTime(item.createdAt)}</span>
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <a
                        className="text-(--info) underline"
                        href={`${downloads}/${encodeURIComponent(item.id)}/bundle`}
                        download
                      >
                        Download bundle
                      </a>
                      <a
                        className="text-(--info) underline"
                        href={`${downloads}/${encodeURIComponent(item.id)}/patch`}
                        download
                      >
                        Download patch
                      </a>
                    </div>
                    <p className="text-(--mut)">
                      From your repository, with the bundle downloaded next to it:
                    </p>
                    <pre className="overflow-auto bg-(--bg-subtle) p-2 text-[11.5px]">
                      {item.instructions.join("\n")}
                    </pre>
                    <p className="text-[12px] text-(--dim)">
                      Importing creates {item.reviewBranch}. Merging it is your decision; an export
                      is not recorded as merged.
                    </p>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
