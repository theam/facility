"use client";

import { Button, Field, Select, TextArea } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StoryAgent, StoryWorkspace, WorkspaceStory } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

export function StoryComposer({
  projectId,
  storyId,
  agents,
}: {
  projectId: string;
  storyId: string;
  agents: StoryAgent[];
}) {
  const router = useRouter();
  const enabled = agents.filter((candidate) => candidate.enabled);
  const [agent, setAgent] = useState(
    enabled.find((candidate) => candidate.name === "builder")?.name ?? enabled[0]?.name ?? "",
  );
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const key = `ui-message-${crypto.randomUUID()}`;
    const result = await clientApi("POST", storyPath(projectId, storyId, "/messages"), {
      agent,
      message,
      idempotency_key: key,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMessage("");
    router.refresh();
  }

  return (
    <form
      id="story-composer"
      onSubmit={submit}
      className="grid gap-3 border border-(--line) bg-(--bg-subtle) p-4 sm:p-5"
    >
      <Field label="Message" error={error || undefined}>
        <TextArea
          required
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Ask for the next change, review, diagnosis, or verification."
          rows={4}
        />
      </Field>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Run as" className="min-w-56">
          <Select value={agent} onChange={(event) => setAgent(event.target.value)}>
            {enabled.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {candidate.model}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" tone="agent" disabled={pending || !agent}>
          {pending ? "queueing…" : "send to agent"}
        </Button>
      </div>
    </form>
  );
}

export function WorkspaceControls({
  projectId,
  story,
  workspace,
  canExecute,
  canWrite,
}: {
  projectId: string;
  story: WorkspaceStory;
  workspace: StoryWorkspace | null;
  canExecute: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
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
    setPreviewUrl(result.data.url);
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {story.status === "archived" && canWrite && !workspaceDeleted ? (
          <Button size="sm" onClick={() => lifecycle("restore")} disabled={Boolean(pending)}>
            {pending === "restore" ? "restoring…" : "restore"}
          </Button>
        ) : story.status !== "archived" ? (
          <>
            {canExecute ? (
              <Button size="sm" onClick={() => lifecycle("suspend")} disabled={Boolean(pending)}>
                {pending === "suspend" ? "suspending…" : "suspend compute"}
              </Button>
            ) : null}
            {canWrite ? (
              <Button size="sm" onClick={() => lifecycle("archive")} disabled={Boolean(pending)}>
                {pending === "archive" ? "archiving…" : "archive"}
              </Button>
            ) : null}
          </>
        ) : null}
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
        {canWrite && !workspaceDeleted ? (
          <Button
            size="sm"
            onClick={() => environmentAction("clean-setup")}
            disabled={Boolean(pending)}
          >
            {pending === "clean-setup" ? "setting up…" : "clean setup"}
          </Button>
        ) : null}
      </div>
      {workspaceDeleted ? (
        <p className="text-[12px] leading-relaxed text-(--dim)">
          This workspace was permanently deleted. Its conversation and metadata remain as history.
        </p>
      ) : null}
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          className="break-all font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
        >
          Open authenticated preview ↗
        </a>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          {error}
        </p>
      ) : null}

      {canWrite && workspace && !workspaceDeleted ? (
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
              The story transcript remains as a tombstone. Merge, archive, and suspend never do
              this.
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
}: {
  projectId: string;
  storyId: string;
  turnId: string;
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
    <div className="mt-3 flex flex-col items-end gap-1">
      <Button size="sm" variant="danger" disabled={pending} onClick={cancel}>
        {pending ? "canceling…" : "cancel turn"}
      </Button>
      {error ? <p className="text-[10px] text-(--bad)">{error}</p> : null}
    </div>
  );
}

function storyPath(projectId: string, storyId: string, suffix = "") {
  return `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}${suffix}`;
}
