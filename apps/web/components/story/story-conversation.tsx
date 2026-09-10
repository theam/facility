"use client";

import { Button, StatusDot } from "@facility/ui";
import { useEffect, useRef, useState } from "react";
import { ExpandableMarkdown } from "@/components/story/expandable-markdown";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import { AgentLine, Person } from "@/components/story/participant";
import { RunActivity } from "@/components/story/run-activity";
import { CancelTurnButton } from "@/components/story/workspace-story-controls";
import type { StoryConversationPage, StoryMessage } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyConversationPath } from "@/lib/story-paths";
import {
  type Exchange,
  formatDurationBetween,
  formatTime,
  groupExchanges,
  mergeMessages,
  presentMessage,
  runStatus,
} from "@/lib/story-presentation";

export const COMPOSE_EVENT = "facility:story-compose";

export function requestCompose(agent?: string) {
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { agent } }));
}

/**
 * The shared conversation as exchanges: each human request with the run and
 * the final response it produced. The first page is server-rendered; older
 * pages load on request and stay in place while the page refreshes. New
 * exchanges that arrive while the reader is further down are announced
 * instead of pushed into view.
 */
export function StoryConversation({
  projectId,
  storyId,
  initial,
  waitingTurnIds,
  canExecute,
}: {
  projectId: string;
  storyId: string;
  initial: StoryConversationPage;
  waitingTurnIds: string[];
  canExecute: boolean;
}) {
  const [shown, setShown] = useState<StoryMessage[]>(() =>
    mergeMessages(initial.messages, initial.related),
  );
  const [pending, setPending] = useState<StoryMessage[]>([]);
  const [floor, setFloor] = useState<{ cursor: number | null; state: LoadState }>(() => ({
    cursor: initial.has_more ? initial.next_cursor : null,
    state: initial.has_more ? "idle" : "end",
  }));
  const [error, setError] = useState("");
  const paged = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // A refreshed first page updates exchanges already on screen in place. Exchanges
  // the reader has not seen yet are held while they are reading further down.
  useEffect(() => {
    const incoming = mergeMessages(initial.messages, initial.related);
    const keys = new Set(shownRef.current.map(exchangeKey));
    const fresh = incoming.filter((message) => !keys.has(exchangeKey(message)));
    const away =
      paged.current ||
      (container.current ? container.current.getBoundingClientRect().top < -240 : false);
    if (fresh.length > 0 && away) {
      const updates = incoming.filter((message) => keys.has(exchangeKey(message)));
      setPending((held) => mergeMessages(held, fresh));
      setShown((current) => mergeMessages(current, updates));
      return;
    }
    setShown((current) => mergeMessages(current, incoming));
  }, [initial]);

  async function loadOlder() {
    if (floor.cursor === null) return;
    paged.current = true;
    setFloor((current) => ({ ...current, state: "loading" }));
    setError("");
    const result = await clientApi<StoryConversationPage>(
      "GET",
      storyConversationPath(projectId, storyId, floor.cursor),
    );
    if (!result.ok) {
      setError(result.message);
      setFloor((current) => ({ ...current, state: "error" }));
      return;
    }
    const page = result.data;
    setShown((current) => mergeMessages(current, page.messages, page.related));
    setFloor({
      cursor: page.has_more ? page.next_cursor : null,
      state: page.has_more ? "idle" : "end",
    });
  }

  const exchanges = groupExchanges(shown);
  const pendingCount = new Set(pending.map(exchangeKey)).size;

  return (
    <div ref={container} className="flex flex-col gap-4">
      {pendingCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-(--accent)/60 bg-(--bg-subtle) px-4 py-3">
          <p role="status" className="text-[13px]">
            {pendingCount === 1 ? "1 new exchange" : `${pendingCount} new exchanges`} arrived while
            you were reading.
          </p>
          <Button
            size="sm"
            variant="primary"
            tone="agent"
            onClick={() => {
              setShown((current) => mergeMessages(current, pending));
              setPending([]);
              container.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
            }}
          >
            show latest
          </Button>
        </div>
      ) : null}
      {exchanges.length === 0 ? (
        <p className="border border-(--line) p-6 text-sm text-(--dim)">No messages yet.</p>
      ) : (
        <ol className="flex flex-col gap-4" aria-label="Conversation, newest first">
          {exchanges.map((exchange) => (
            <li key={exchange.key}>
              <ExchangeCard
                exchange={exchange}
                projectId={projectId}
                storyId={storyId}
                waitingForReply={exchange.turn ? waitingTurnIds.includes(exchange.turn.id) : false}
                canExecute={canExecute}
              />
            </li>
          ))}
        </ol>
      )}
      <LoadMore
        state={floor.state}
        label="Older messages"
        endLabel={exchanges.length > 0 ? "Beginning of the conversation." : ""}
        error={error}
        onLoad={() => void loadOlder()}
      />
    </div>
  );
}

function exchangeKey(message: StoryMessage) {
  return message.turnId ? `turn:${message.turnId}` : `message:${message.id}`;
}

function ExchangeCard({
  exchange,
  projectId,
  storyId,
  waitingForReply,
  canExecute,
}: {
  exchange: Exchange;
  projectId: string;
  storyId: string;
  waitingForReply: boolean;
  canExecute: boolean;
}) {
  const { turn, request, response } = exchange;
  const status = runStatus(turn ?? null, { waitingForReply });
  const agentName = turn?.agentName ?? request?.requestedAgentName ?? "agent";
  const active = turn ? ["queued", "running"].includes(turn.state) : false;
  return (
    <article
      className="flex flex-col border border-(--line) bg-(--bg)"
      aria-label={`${request?.author.name ?? "Request"} asked ${agentName}${
        request ? ` on ${formatTime(request.createdAt)}` : ""
      } · ${status.label}`}
    >
      {request ? <RequestBlock message={request} agentName={agentName} /> : null}
      {exchange.extra.map((message) => (
        <RequestBlock key={message.id} message={message} agentName={agentName} />
      ))}
      <div className="flex flex-col gap-3 border-t border-dashed border-(--line) p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <AgentLine
            name={agentName}
            turn={turn ?? null}
            reportedModel={response?.content.reportedModel ?? null}
          />
          <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-(--mut)">
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={status.tone} pulse={status.pulse} />
              <span className={status.tone === "bad" ? "text-(--bad)" : "text-(--ink)"}>
                {status.label}
              </span>
            </span>
            {turn?.endedAt ? (
              <time dateTime={turn.endedAt}>
                {formatTime(turn.endedAt)}
                {formatDurationBetween(turn.startedAt, turn.endedAt)
                  ? ` · ${formatDurationBetween(turn.startedAt, turn.endedAt)}`
                  : ""}
              </time>
            ) : turn?.startedAt ? (
              <time dateTime={turn.startedAt}>since {formatTime(turn.startedAt)}</time>
            ) : null}
            {canExecute && active && turn ? (
              <CancelTurnButton projectId={projectId} storyId={storyId} turnId={turn.id} inline />
            ) : null}
          </div>
        </div>
        {response ? (
          <ResponseBody message={response} />
        ) : (
          <p className="text-[13px] leading-relaxed text-(--mut)">{status.detail}</p>
        )}
        {waitingForReply ? (
          <div className="flex flex-wrap items-center gap-3 border border-(--human)/60 bg-(--bg-subtle) px-4 py-3">
            <p className="text-[13px]">
              <span className="font-mono">{agentName}</span> is waiting for your answer.
            </p>
            {canExecute ? (
              <Button size="sm" onClick={() => requestCompose(agentName)}>
                reply
              </Button>
            ) : null}
          </div>
        ) : null}
        {turn?.state === "failed" && turn.error ? (
          <details className="text-xs text-(--dim)">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
              {turn.error}
            </pre>
          </details>
        ) : null}
        {turn && !active ? (
          <RunActivity
            projectId={projectId}
            storyId={storyId}
            turnId={turn.id}
            progressMessages={response?.content.progressMessages ?? null}
          />
        ) : turn ? (
          <RunActivity
            projectId={projectId}
            storyId={storyId}
            turnId={turn.id}
            progressMessages={null}
          />
        ) : null}
      </div>
    </article>
  );
}

function RequestBlock({ message, agentName }: { message: StoryMessage; agentName: string }) {
  const presentation = presentMessage(message);
  return (
    <div className="flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Person author={message.author} />
          <span className="text-[12px] text-(--mut)">asked</span>
          <span className="inline-flex items-center gap-1.5 border border-(--line-strong) px-2 py-0.5 font-mono text-[12px] text-(--ink)">
            {message.requestedAgentName ?? agentName}
          </span>
        </div>
        <time className="text-[11px] text-(--dim)" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
      </div>
      {presentation.title ? (
        <h3 className="text-[14px] font-semibold">{presentation.title}</h3>
      ) : null}
      <div className="max-w-prose text-[15px] leading-7">
        <ExpandableMarkdown source={presentation.body} label="request" />
      </div>
      {presentation.sourceUrl ? (
        <a
          href={presentation.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="w-fit text-xs text-(--info) underline-offset-4 hover:underline"
        >
          View on GitHub ↗
        </a>
      ) : null}
      {presentation.technical ? (
        <details className="text-xs text-(--dim)">
          <summary className="cursor-pointer">Original event · technical details</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words">
            {message.body}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function ResponseBody({ message }: { message: StoryMessage }) {
  const combined = message.content.kind === "combined_transcript";
  return (
    <div className="flex flex-col gap-3">
      {combined ? (
        <p className="border-l-2 border-(--line-strong) pl-3 text-[12px] leading-relaxed text-(--mut)">
          Recorded as one transcript: this run predates Facility separating progress messages from
          the final response, so what the agent said along the way and its ending are shown together
          as stored.
        </p>
      ) : null}
      <div className="max-w-prose text-[15px] leading-7">
        <ExpandableMarkdown source={message.body} label={combined ? "transcript" : "response"} />
      </div>
    </div>
  );
}
