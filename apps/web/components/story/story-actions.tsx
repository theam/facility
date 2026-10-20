"use client";

import { Button, Field, Select, TextArea } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
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
  canPreview = canExecute,
  canWrite,
  computeState,
  activeTurn,
  waitingAgent,
  artifacts,
  session,
  canControlSession = false,
}: {
  projectId: string;
  story: WorkspaceStory;
  workspace: StoryWorkspace | null;
  agents: StoryAgent[];
  canExecute: boolean;
  canPreview?: boolean;
  canWrite: boolean;
  computeState?: StoryWorkspace["state"];
  activeTurn: Turn | null;
  waitingAgent: string | null;
  artifacts: Artifact[];
  session?: WorkspaceStoryBundle["session"];
  canControlSession?: boolean;
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
      {session ? (
        <aside className="border border-(--line) p-3 text-sm" aria-label="Session holder">
          {session.holder ? (
            <p>
              {session.holder.kind === "person"
                ? `${session.holder.name} has an interactive session open`
                : `${session.holder.agent} is running a Facility turn (${session.holder.trigger})`}{" "}
              since{" "}
              <time dateTime={session.holder.since}>
                {new Date(session.holder.since).toLocaleString()}
              </time>
              .
            </p>
          ) : (
            <p>The story session is free.</p>
          )}
          {session.waiting.length ? (
            <p>
              {session.waiting.map((person) => person.name ?? "A person").join(", ")} is waiting to
              enter; queued messages run after.
            </p>
          ) : null}
          {!session.supported ? (
            <p>
              Interactive sessions are not supported yet on this provider. The conversation remains
              available read-only.
            </p>
          ) : null}
          {session.supported &&
          session.holder?.kind === "person" &&
          canControlSession &&
          canSend ? (
            <Button type="button" size="sm" onClick={() => setOpen(true)}>
              Take over and send a task
            </Button>
          ) : null}
        </aside>
      ) : null}
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
        {canExecute && activeTurn && activeTurn.triggerType !== "interactive" ? (
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
          canPreview={canPreview}
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
              canControlSession={canControlSession}
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
  canControlSession = false,
}: {
  projectId: string;
  storyId: string;
  agents: StoryAgent[];
  preset?: string;
  onDone?: () => void;
  onCancel?: () => void;
  canControlSession?: boolean;
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
  const [held, setHeld] = useState<NonNullable<
    NonNullable<WorkspaceStoryBundle["session"]>["holder"]
  > | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (held) dialog.current?.showModal?.();
    else dialog.current?.close?.();
  }, [held]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const status = await clientApi<NonNullable<WorkspaceStoryBundle["session"]>>(
      "GET",
      storyPath(projectId, storyId, "/session/status"),
    );
    setPending(false);
    if (!status.ok) {
      setError(status.message);
      return;
    }
    if (status.data.holder?.kind === "person") {
      setHeld(status.data.holder);
      return;
    }
    await send();
  }

  async function send(takeover = false) {
    setPending(true);
    setError("");
    const key = `ui-message-${crypto.randomUUID()}`;
    const result = await clientApi<{ queued: { queued: boolean } }>(
      "POST",
      storyPath(projectId, storyId, "/messages"),
      {
        agent,
        message,
        idempotency_key: key,
        ...(takeover && held ? { takeover_turn_id: held.turnId, confirm_takeover: true } : {}),
      },
    );
    setPending(false);
    setHeld(null);
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
      <dialog
        ref={dialog}
        onCancel={() => setHeld(null)}
        aria-label="Session is held"
        className="border border-(--line) bg-(--bg) p-5 text-(--ink) backdrop:bg-black/50"
      >
        {held ? (
          <>
            <p>
              {held.name} has had an interactive session open since{" "}
              {new Date(held.since).toLocaleString()}.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" disabled={pending} onClick={() => void send(false)}>
                Send when it ends
              </Button>
              {canControlSession ? (
                <Button type="button" disabled={pending} onClick={() => void send(true)}>
                  Take over and send now
                </Button>
              ) : null}
              <Button type="button" disabled={pending} onClick={() => setHeld(null)}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}
      </dialog>
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
