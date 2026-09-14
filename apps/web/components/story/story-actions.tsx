"use client";

import { Button, Field, Select, TextArea } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { COMPOSE_EVENT } from "@/components/story/story-conversation";
import {
  CancelTurnButton,
  storyPath,
  WorkspaceControls,
} from "@/components/story/workspace-story-controls";
import type { StoryAgent, StoryWorkspace, WorkspaceStory, WorkspaceStoryBundle } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { safeExternalUrl } from "@/lib/story-presentation";

type Turn = WorkspaceStoryBundle["turns"][number];
type Artifact = WorkspaceStoryBundle["artifacts"][number];

/**
 * Everything a reader can do from the top of a story: send or answer a task,
 * open the running app, reach the pull request and results, stop the current
 * run, and — set apart — maintain or delete the workspace. Reading the page
 * performs none of these; each is an explicit click.
 */
export function StoryActions({
  projectId,
  story,
  workspace,
  agents,
  canExecute,
  canWrite,
  computeState,
  activeTurn,
  waitingAgent,
  artifacts,
}: {
  projectId: string;
  story: WorkspaceStory;
  workspace: StoryWorkspace | null;
  agents: StoryAgent[];
  canExecute: boolean;
  canWrite: boolean;
  computeState?: StoryWorkspace["state"];
  activeTurn: Turn | null;
  waitingAgent: string | null;
  artifacts: Artifact[];
}) {
  const enabled = agents.filter((candidate) => candidate.enabled);
  const canSend = canExecute && story.deletedAt === null && enabled.length > 0;
  const [open, setOpen] = useState(Boolean(waitingAgent) && canSend);
  const [preset, setPreset] = useState<string | undefined>(waitingAgent ?? undefined);
  const panelId = useId();
  const pullRequestUrl = safeExternalUrl(story.pullRequestUrl);
  const results = artifacts.filter((artifact) => safeExternalUrl(artifact.uri)).slice(0, 3);

  useEffect(() => {
    const listener = (event: Event) => {
      const agent = (event as CustomEvent<{ agent?: string }>).detail?.agent;
      setPreset(agent);
      setOpen(true);
    };
    window.addEventListener(COMPOSE_EVENT, listener);
    return () => window.removeEventListener(COMPOSE_EVENT, listener);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-wrap items-center gap-2" aria-label="Story actions">
        {canSend ? (
          <Button
            variant="primary"
            tone="agent"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {waitingAgent ? `reply to ${waitingAgent}` : "send a task"}
          </Button>
        ) : null}
        {pullRequestUrl ? (
          <a
            href={pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-2 border border-(--line-strong) px-3.5 text-[12.5px] font-medium text-(--ink) hover:bg-(--card)"
          >
            pull request #{story.pullRequestNumber} ↗
          </a>
        ) : null}
        {canExecute && activeTurn ? (
          <CancelTurnButton
            projectId={projectId}
            storyId={story.id}
            turnId={activeTurn.id}
            inline
          />
        ) : null}
        <WorkspaceControls
          projectId={projectId}
          story={story}
          workspace={workspace}
          canExecute={canExecute}
          canWrite={canWrite}
          computeState={computeState}
        />
      </section>
      {results.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-(--mut)">
          <span>Results:</span>
          {results.map((artifact) => (
            <a
              key={artifact.id}
              href={artifact.uri}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              {artifact.label} <span className="text-(--dim)">({artifact.kind})</span> ↗
            </a>
          ))}
          {artifacts.length > results.length ? (
            <a href="#results" className="text-(--dim) underline-offset-4 hover:underline">
              all {artifacts.length} results ↓
            </a>
          ) : null}
        </p>
      ) : null}
      {canSend ? (
        <div id={panelId} hidden={!open}>
          {open ? (
            <StoryComposer
              projectId={projectId}
              storyId={story.id}
              agents={enabled}
              preset={preset}
              onDone={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StoryComposer({
  projectId,
  storyId,
  agents,
  preset,
  onDone,
  onCancel,
}: {
  projectId: string;
  storyId: string;
  agents: StoryAgent[];
  preset?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [agent, setAgent] = useState(
    agents.find((candidate) => candidate.name === preset)?.name ??
      agents.find((candidate) => candidate.name === "builder")?.name ??
      agents[0]?.name ??
      "",
  );
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const key = `ui-message-${crypto.randomUUID()}`;
    const result = await clientApi<{ queued: { queued: boolean } }>(
      "POST",
      storyPath(projectId, storyId, "/messages"),
      { agent, message, idempotency_key: key },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMessage("");
    setNotice(
      result.data.queued?.queued
        ? `Queued for ${agent}; it starts after the current run.`
        : `Sent to ${agent}.`,
    );
    router.refresh();
    onDone?.();
  }

  return (
    <form
      id="story-composer"
      onSubmit={submit}
      className="grid gap-3 border border-(--line) bg-(--bg-subtle) p-4 sm:p-5"
      aria-label="Send a task"
    >
      <Field label="Message" error={error || undefined}>
        <TextArea
          autoFocus
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
            {agents.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {candidate.model}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" size="sm" onClick={onCancel} disabled={pending}>
              close
            </Button>
          ) : null}
          <Button type="submit" variant="primary" tone="agent" disabled={pending || !agent}>
            {pending ? "queueing…" : "send to agent"}
          </Button>
        </div>
      </div>
      {notice ? (
        <p role="status" className="text-[12px] text-(--mut)">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
