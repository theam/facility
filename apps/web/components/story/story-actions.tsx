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
import {
  clearSentStoryDraft,
  readStoryDraft,
  type StoryDraft,
  storyDraftKey,
  writeStoryDraft,
} from "@/lib/story-draft";
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
  draftOwnerId,
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
  draftOwnerId?: string;
}) {
  const enabled = agents.filter((candidate) => candidate.enabled);
  const canSend = canExecute && story.deletedAt === null;
  const [open, setOpen] = useState(Boolean(waitingAgent) && canSend);
  const [hasOpened, setHasOpened] = useState(open);
  const [preset, setPreset] = useState<string | undefined>(waitingAgent ?? undefined);
  const [focusRequest, setFocusRequest] = useState(0);
  const [retargetRequest, setRetargetRequest] = useState(0);
  const [notice, setNotice] = useState("");
  const actionBar = useRef<HTMLElement>(null);
  const panelId = useId();
  const pullRequestUrl = safeExternalUrl(story.pullRequestUrl);
  const results = artifacts.filter((artifact) => safeExternalUrl(artifact.uri)).slice(0, 3);

  useEffect(() => {
    const listener = (event: Event) => {
      const agent = (event as CustomEvent<{ agent?: string }>).detail?.agent;
      setPreset(agent);
      setRetargetRequest((request) => request + 1);
      setOpen(true);
      setHasOpened(true);
      setFocusRequest((request) => request + 1);
    };
    window.addEventListener(COMPOSE_EVENT, listener);
    return () => window.removeEventListener(COMPOSE_EVENT, listener);
  }, []);

  function close() {
    setOpen(false);
    actionBar.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <section
        ref={actionBar}
        className="flex flex-wrap items-center gap-2"
        aria-label="Story actions"
      >
        {canSend ? (
          <Button
            variant="primary"
            tone="agent"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              if (open) close();
              else {
                setOpen(true);
                setHasOpened(true);
                setFocusRequest((request) => request + 1);
              }
            }}
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
            source pull request #{story.pullRequestNumber} ↗
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
          {hasOpened ? (
            <StoryComposer
              key={JSON.stringify([draftOwnerId, projectId, story.id])}
              projectId={projectId}
              storyId={story.id}
              draftOwnerId={draftOwnerId}
              agents={enabled}
              preset={preset}
              open={open}
              focusRequest={focusRequest}
              retargetRequest={retargetRequest}
              onDone={(message) => {
                setNotice(message);
                close();
              }}
              onCancel={close}
            />
          ) : null}
        </div>
      ) : null}
      <p role="status" className="text-[12px] text-(--mut)">
        {notice}
      </p>
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
  draftOwnerId,
  open = true,
  focusRequest = 0,
  initialDraft,
  composerId = "story-composer",
  formLabel = "Send a task",
  retargetRequest = 0,
}: {
  projectId: string;
  storyId: string;
  agents: StoryAgent[];
  preset?: string;
  onDone?: (notice: string) => void;
  onCancel?: () => void;
  draftOwnerId?: string;
  open?: boolean;
  focusRequest?: number;
  initialDraft?: StoryDraft;
  composerId?: string;
  formLabel?: string;
  retargetRequest?: number;
}) {
  const router = useRouter();
  const defaultAgent =
    agents.find((candidate) => candidate.name === preset)?.name ??
    agents.find((candidate) => candidate.name === "builder")?.name ??
    agents[0]?.name ??
    "";
  const storageKey = storyDraftKey(draftOwnerId, projectId, storyId);
  const [draft, setDraft] = useState<StoryDraft>(
    initialDraft ?? { agent: defaultAgent, message: "" },
  );
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  const handledRetarget = useRef(0);
  const handledFocus = useRef(-1);
  const mounted = useRef(true);
  const receiptCleared = useRef(false);
  const agent = agents.some((candidate) => candidate.name === draft.agent) ? draft.agent : "";
  const message = draft.message;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const previous = readStoryDraft(storageKey);
    if (previous) setDraft(previous);
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    if (!draft.message && receiptCleared.current) {
      receiptCleared.current = false;
      return;
    }
    setSaved(writeStoryDraft(storageKey, draft));
  }, [draft, loaded, storageKey]);

  useEffect(() => {
    if (!loaded || pending || !open || handledFocus.current === focusRequest) return;
    handledFocus.current = focusRequest;
    if (retargetRequest > handledRetarget.current) {
      handledRetarget.current = retargetRequest;
      if (preset !== undefined) {
        setDraft((current) =>
          current.agent === preset
            ? current
            : { ...current, agent: preset, idempotencyKey: undefined },
        );
      }
    }
    const input = form.current?.querySelector("textarea");
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [focusRequest, retargetRequest, loaded, open, pending, preset]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !agent || !message.trim()) return;
    sending.current = true;
    setPending(true);
    setError("");
    const key = draft.idempotencyKey ?? `ui-message-${crypto.randomUUID()}`;
    const attempt = { ...draft, idempotencyKey: key };
    setDraft(attempt);
    writeStoryDraft(storageKey, attempt);
    const result = await clientApi<{ queued: { queued: boolean } }>(
      "POST",
      storyPath(projectId, storyId, "/messages"),
      { agent, message, idempotency_key: key },
    );
    if (result.ok) clearSentStoryDraft(storageKey, attempt);
    if (!mounted.current) return;
    sending.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const sent = result.data.queued?.queued
      ? `Queued for ${agent}; it starts after the current run.`
      : `Sent to ${agent}.`;
    const empty = { agent, message: "" };
    receiptCleared.current = true;
    setDraft(empty);
    setNotice(sent);
    router.refresh();
    onDone?.(sent);
  }

  return (
    <form
      ref={form}
      id={composerId}
      onSubmit={submit}
      className="grid gap-3 border border-(--line) bg-(--bg-subtle) p-4 sm:p-5"
      aria-label={formLabel}
    >
      <Field label="Message">
        <TextArea
          aria-label="Message"
          required
          value={message}
          disabled={pending}
          maxLength={200_000}
          onChange={(event) => {
            setNotice("");
            setDraft({ agent: draft.agent, message: event.target.value });
          }}
          placeholder="Ask for the next change, review, diagnosis, or verification."
          rows={4}
        />
      </Field>
      <p className="text-[12px] text-(--dim)">
        {saved
          ? "Closing keeps your draft. Restore it in this tab for up to 24 hours."
          : "Closing keeps your draft while this page is open."}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Run as" className="min-w-0 flex-1 sm:min-w-56">
          <Select
            value={agent}
            disabled={pending}
            onChange={(event) => {
              setNotice("");
              setDraft({ agent: event.target.value, message });
            }}
          >
            {!agent ? <option value="">Choose an available agent</option> : null}
            {agents.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {candidate.model}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending || !message}
            onClick={() => {
              setDraft({ agent: draft.agent, message: "" });
              setError("");
              setNotice("Draft discarded.");
              form.current?.querySelector("textarea")?.focus();
            }}
          >
            discard draft
          </Button>
          {onCancel ? (
            <Button type="button" size="sm" onClick={onCancel} disabled={pending}>
              close
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            tone="agent"
            disabled={pending || !agent || !message.trim()}
          >
            {pending ? "queueing…" : "send to agent"}
          </Button>
        </div>
      </div>
      {!agent ? (
        <p role="status" className="text-[12px] text-(--warn)">
          The previous recipient is unavailable. Choose an agent to send this draft.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-[12px] text-(--mut)">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
