"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StoryWorkspace, WorkspaceStory } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

/**
 * Environment actions from the top of the story: previews and browser checks
 * for everyday work, maintenance and deletion set apart so they never compete
 * with it. Permissions, confirmations and the one-time preview grant behave
 * exactly as before; only the arrangement changed.
 */
export function WorkspaceControls({
  projectId,
  story,
  workspace,
  canExecute,
  canWrite,
  computeState,
}: {
  projectId: string;
  story: WorkspaceStory;
  workspace: StoryWorkspace | null;
  canExecute: boolean;
  canWrite: boolean;
  computeState?: StoryWorkspace["state"];
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [previewService, setPreviewService] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const services = workspace?.environment.ports ?? [];
  const workspaceDeleted = isWorkspaceDeleted(story, workspace);

  async function lifecycle(action: "suspend" | "archive" | "restore") {
    setPending(action);
    setError("");
    const result = await clientApi("POST", storyPath(projectId, story.id, `/${action}`));
    setPending("");
    if (!result.ok) setError(result.message);
    else router.refresh();
  }

  async function environmentAction(action: "clean-setup" | "browser-test") {
    setPending(action);
    setError("");
    const result = await clientApi(
      "POST",
      storyPath(projectId, story.id, `/environment/${action}`),
    );
    setPending("");
    if (!result.ok) setError(result.message);
    else router.refresh();
  }

  async function openPreview(service: string) {
    setPending(`preview:${service}`);
    setError("");
    const result = await clientApi<{ url: string }>(
      "POST",
      storyPath(projectId, story.id, `/preview/${encodeURIComponent(service)}/open`),
    );
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPreviewService(service);
    window.open(result.data.url, "_blank", "noopener,noreferrer");
  }

  async function deleteWorkspace() {
    const key = `ui-delete-${crypto.randomUUID()}`;
    setPending("delete");
    setError("");
    const result = await clientApi("DELETE", storyPath(projectId, story.id, "/workspace"), {
      confirm: true,
      idempotency_key: key,
    });
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  const maintenance = [
    story.status === "archived" && canWrite && !workspaceDeleted ? (
      <Button
        key="restore"
        size="sm"
        onClick={() => lifecycle("restore")}
        disabled={Boolean(pending)}
      >
        {pending === "restore" ? "restoring…" : "restore"}
      </Button>
    ) : null,
    story.status !== "archived" && !workspaceDeleted && canExecute && computeState === "running" ? (
      <Button
        key="suspend"
        size="sm"
        onClick={() => lifecycle("suspend")}
        disabled={Boolean(pending)}
      >
        {pending === "suspend" ? "suspending…" : "suspend compute"}
      </Button>
    ) : null,
    story.status !== "archived" && !workspaceDeleted && canWrite ? (
      <Button
        key="archive"
        size="sm"
        onClick={() => lifecycle("archive")}
        disabled={Boolean(pending)}
      >
        {pending === "archive" ? "archiving…" : "archive"}
      </Button>
    ) : null,
    canWrite && !workspaceDeleted ? (
      <Button
        key="clean-setup"
        size="sm"
        onClick={() => environmentAction("clean-setup")}
        disabled={Boolean(pending)}
      >
        {pending === "clean-setup" ? "setting up…" : "clean setup"}
      </Button>
    ) : null,
  ].filter(Boolean);
  const canDelete = canWrite && workspace && !workspaceDeleted;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {canExecute
          ? services.map((service) => (
              <Button
                key={service.service}
                size="sm"
                variant="primary"
                tone="agent"
                onClick={() => openPreview(service.service)}
                disabled={Boolean(pending) || workspaceDeleted}
              >
                {pending === `preview:${service.service}`
                  ? "opening…"
                  : `open ${service.service} ↗`}
              </Button>
            ))
          : null}
        {canExecute && !workspaceDeleted ? (
          <Button
            size="sm"
            onClick={() => environmentAction("browser-test")}
            disabled={Boolean(pending)}
          >
            {pending === "browser-test" ? "testing…" : "run browser test"}
          </Button>
        ) : null}
        {maintenance.length > 0 || canDelete ? (
          <details className="group relative">
            <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-2 border border-(--line) px-3.5 text-[12.5px] font-medium text-(--mut) hover:border-(--line-strong) hover:text-(--ink)">
              maintenance
              <span aria-hidden="true" className="transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <div className="absolute left-0 z-20 mt-2 flex w-[min(92vw,26rem)] flex-col gap-4 border border-(--line) bg-(--bg) p-4 shadow-(--shadow-lift)">
              <p className="text-xs leading-relaxed text-(--dim)">
                Suspend stops compute and preserves files. Archive keeps the workspace as history.
                Clean setup reruns project setup and can reset development data.
              </p>
              {maintenance.length > 0 ? (
                <div className="flex flex-wrap gap-2">{maintenance}</div>
              ) : null}
              {canDelete ? (
                <details className="border border-(--bad)/40 p-4">
                  <summary className="cursor-pointer text-[12px] font-medium text-(--bad)">
                    Permanently delete workspace
                  </summary>
                  <div className="mt-4 flex flex-col gap-4 text-[12px] leading-relaxed text-(--mut)">
                    <p>This permanently deletes:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>the durable volume {workspace.volumeRef}</li>
                      <li>all repository worktrees and unpushed local changes in that volume</li>
                      <li>persisted Claude Code and Codex native sessions</li>
                    </ul>
                    <p>
                      The story transcript remains as a tombstone. Merge, archive, and suspend never
                      do this.
                    </p>
                    <label className="flex items-start gap-2 text-(--ink)">
                      <input
                        type="checkbox"
                        checked={deleteConfirmed}
                        onChange={(event) => setDeleteConfirmed(event.target.checked)}
                        className="mt-0.5"
                      />
                      I understand this workspace state cannot be recovered.
                    </label>
                    <Button
                      size="sm"
                      variant="danger"
                      className="w-fit"
                      disabled={!deleteConfirmed || Boolean(pending)}
                      onClick={deleteWorkspace}
                    >
                      {pending === "delete" ? "deleting…" : "delete workspace"}
                    </Button>
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
      {workspaceDeleted ? (
        <p className="text-[12px] leading-relaxed text-(--dim)">
          This workspace was permanently deleted. Its conversation and metadata remain as history.
        </p>
      ) : null}
      {previewService && canExecute && !workspaceDeleted ? (
        <button
          type="button"
          onClick={() => openPreview(previewService)}
          disabled={Boolean(pending)}
          className="w-fit break-all text-left font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
        >
          Open a new authenticated preview ↗
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function isWorkspaceDeleted(
  story: Pick<WorkspaceStory, "deletedAt">,
  workspace: Pick<StoryWorkspace, "state"> | null,
) {
  return story.deletedAt !== null || workspace?.state === "destroyed";
}

export function CancelTurnButton({
  projectId,
  storyId,
  turnId,
  inline = false,
}: {
  projectId: string;
  storyId: string;
  turnId: string;
  inline?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function cancel() {
    setPending(true);
    setError("");
    const result = await clientApi(
      "POST",
      storyPath(projectId, storyId, `/turns/${encodeURIComponent(turnId)}/cancel`),
    );
    setPending(false);
    if (!result.ok) setError(result.message);
    else router.refresh();
  }

  return (
    <span
      className={inline ? "inline-flex items-center gap-2" : "mt-3 flex flex-col items-end gap-1"}
    >
      <Button size="sm" variant="danger" disabled={pending} onClick={cancel}>
        {pending ? "canceling…" : "cancel turn"}
      </Button>
      {error ? (
        <span role="alert" className="text-[10px] text-(--bad)">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function storyPath(projectId: string, storyId: string, suffix = "") {
  return `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}${suffix}`;
}
