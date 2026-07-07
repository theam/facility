"use client";

import { Button, cx, StatusDot } from "@facility/ui";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// TODO(sdk): migrate to the typed client once the conversations routes land in
// the regenerated route map.
type Conversation = {
  id: string;
  status: "idle" | "running" | string;
  title?: string | null;
};

type Message = {
  id: string;
  seq: number;
  role: "user" | "agent" | "system" | string;
  body: string;
  runId?: string | null;
  createdAt: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(err ?? `${res.status}`);
  }
  return body as T;
}

/**
 * Steer the Owner by talking to it. Every turn is a governed session (sandbox,
 * receipts, audit); the reply lands here and the KB carries the memory.
 */
export function OwnerConversation({ projectId }: { projectId: string }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (conversationId: string) => {
    const detail = await req<Conversation & { messages: Message[] }>(
      `/v1/conversations/${conversationId}`,
    );
    setConversation({ id: detail.id, status: detail.status, title: detail.title });
    setMessages(detail.messages ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await req<Conversation[]>(`/v1/projects/${projectId}/conversations`);
        if (cancelled) return;
        if (list.length > 0 && list[0]) {
          await refresh(list[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setUnavailable(err instanceof Error ? err.message : "unavailable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh]);

  // While a turn is running, poll for the reply.
  useEffect(() => {
    if (conversation?.status !== "running") return;
    const interval = setInterval(() => {
      void refresh(conversation.id).catch(() => undefined);
    }, 4000);
    return () => clearInterval(interval);
  }, [conversation, refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const conv =
        conversation ??
        (await req<Conversation>(`/v1/projects/${projectId}/conversations`, {
          method: "POST",
          body: JSON.stringify({}),
        }));
      await req(`/v1/conversations/${conv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setDraft("");
      await refresh(conv.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setBusy(false);
    }
  }

  if (unavailable) {
    return (
      <p className="border border-(--line) bg-(--bg-subtle) p-4 text-[12.5px] leading-relaxed text-(--mut)">
        The conversation channel isn't available on this control plane yet ({unavailable}).
      </p>
    );
  }

  return (
    <div className="flex flex-col border border-(--line)">
      <div className="flex items-center gap-3 border-b border-(--line) px-4 py-3">
        <StatusDot
          tone={conversation?.status === "running" ? "agent" : "machine"}
          pulse={conversation?.status === "running"}
        />
        <span className="text-[11.5px] font-medium text-(--dim)">
          {conversation?.status === "running"
            ? "the owner is working on your message"
            : "talk to the owner"}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="flex max-h-[46vh] min-h-40 flex-col gap-4 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-(--dim)">
            No conversation yet. Tell the Owner what to prioritize, what it got wrong, or what to
            investigate — each turn runs as a governed session and its KB changes go through the
            gate.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cx(
                "flex max-w-[92%] flex-col gap-1",
                message.role === "user" ? "self-end items-end" : "self-start",
              )}
            >
              <span className="text-[10.5px] font-medium text-(--dim)">
                {message.role === "user" ? "you" : "owner"}
                {message.runId ? (
                  <>
                    {" · "}
                    <Link
                      href={`/projects/${projectId}/sessions/${message.runId}`}
                      className="underline-offset-4 hover:text-(--ink) hover:underline"
                    >
                      session
                    </Link>
                  </>
                ) : null}
              </span>
              <p
                className={cx(
                  "whitespace-pre-wrap border px-3.5 py-2.5 text-[13px] leading-relaxed",
                  message.role === "user"
                    ? "border-(--line-strong) text-(--ink)"
                    : "border-(--line) bg-(--bg-subtle) text-(--mut)",
                )}
              >
                {message.body}
              </p>
            </div>
          ))
        )}
      </div>
      <form onSubmit={send} className="flex items-center gap-3 border-t border-(--line) px-4 py-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Steer the Owner — recorded, gated, audited"
          aria-label="Message the project owner"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-(--ink) outline-none placeholder:text-(--dim)"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy || conversation?.status === "running" || !draft.trim()}
        >
          {busy ? "sending…" : "send"}
        </Button>
        {error ? <span className="font-mono text-[11px] text-(--bad)">{error}</span> : null}
      </form>
    </div>
  );
}
