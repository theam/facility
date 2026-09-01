"use client";

import { Button } from "@facility/ui";
import { useCallback, useRef, useState } from "react";

export type TurnStart = { conversationId: string; runId: string; question: string };

/**
 * THE conversation input for the digital Product Owner — one component, used
 * verbatim by the floating bar and the Sessions workspace: same password-manager
 * shielding, same /ask wiring. Only the placement and what happens after a turn
 * starts differ per host. Pasted transcripts travel as ordinary messages: the
 * agent reads them with the user's comments and decides what to do via tools.
 */
export function AskComposer({
  projectId,
  conversationId,
  placeholder = "talk with the product owner",
  inputRef: externalRef,
  onTurnStarted,
}: {
  projectId: string;
  /** Pin follow-ups to a thread; null starts a fresh one on first send. */
  conversationId: string | null;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onTurnStarted: (turn: TurnStart) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalRef ?? internalRef;

  const ask = useCallback(
    async (question: string) => {
      const body = question.trim();
      if (!body || busy) return;
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/v1/projects/${projectId}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, ...(conversationId ? { conversationId } : {}) }),
        });
        const payload = (await response.json().catch(() => null)) as {
          conversationId?: string;
          runId?: string;
          error?: { message?: string };
        } | null;
        if (!response.ok || !payload?.runId || !payload.conversationId) {
          throw new Error(payload?.error?.message ?? `ask failed (${response.status})`);
        }
        setValue("");
        if (inputRef.current) inputRef.current.style.height = "auto";
        onTurnStarted({
          conversationId: payload.conversationId,
          runId: payload.runId,
          question: body,
        });
      } catch (askError) {
        setError(askError instanceof Error ? askError.message : "ask failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, projectId, onTurnStarted, inputRef],
  );

  return (
    <div className="flex w-full flex-col gap-2">
      {error ? (
        <p className="border border-(--line) bg-(--bg) px-3 py-2 font-mono text-[11px] text-(--bad,--mut)">
          {error}
        </p>
      ) : null}
      {/* The always-available line to the Product Owner reads as agent surface,
          not as chrome: a 2px stroke in the resting accent tone, going to the
          full accent with its lift on hover and while focused. */}
      <form
        className="flex items-end gap-3 border-2 border-(--accent-soft) bg-(--bg) px-4 py-3 shadow-(--shadow-lift) transition-[border-color,box-shadow] duration-200 hover:border-(--accent) hover:shadow-(--shadow-agent-lift) focus-within:border-(--accent) focus-within:shadow-(--shadow-agent-lift)"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(value);
        }}
      >
        {/* py-1.5 gives the glyph and the one-line input the same 40px box as
            the send button, so at rest they sit on its centre line instead of
            hanging off the bottom edge that items-end aligns to. */}
        <span aria-hidden className="py-1.5 font-mono text-[15px] leading-7 text-(--accent)">
          ▸
        </span>
        <textarea
          ref={inputRef}
          // Auto-growing prompt area: one line at rest, up to half the
          // viewport for long content. Enter sends; Shift+Enter breaks the
          // line. The name plus the vendor ignore attributes keep password
          // managers (1Password, LastPass, Bitwarden, autofill) away.
          rows={1}
          name="facility-ask-question"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          aria-label="Talk with the product owner"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 2)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask(value);
            }
          }}
          placeholder={placeholder}
          className="max-h-[50vh] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[15px] leading-7 text-(--ink) outline-none placeholder:text-(--mut)"
        />
        <Button
          size="md"
          variant="primary"
          tone="agent"
          type="submit"
          disabled={busy || !value.trim()}
        >
          {busy ? "…" : "send"}
        </Button>
      </form>
    </div>
  );
}
