"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AskComposer } from "./ask-composer";
import { AskPanel } from "./ask-panel";

/**
 * The omnipresent floating host of the conversation composer: one input, on
 * every project page, with the slide-up thread panel. The Product → Sessions
 * tab renders the same composer in its own workspace, so the floating bar
 * steps aside there, so the two inputs never compete for the same turn.
 */
export function AskBar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const [panelOpen, setPanelOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const storageKey = `facility-ask-thread:${projectId}`;

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) setConversationId(stored);
    } catch {
      // Session storage unavailable (SSR/private mode) — threads reset per load.
    }
  }, [storageKey]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && panelOpen) setPanelOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen]);

  // The Sessions workspace owns the composer on its route — no duplicate input.
  if (pathname.endsWith("/product/sessions")) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto flex w-full max-w-3xl flex-col gap-2">
        {panelOpen ? (
          <AskPanel
            projectId={projectId}
            conversationId={conversationId}
            activeRunId={activeRunId}
            pendingQuestion={pendingQuestion}
            onClose={() => setPanelOpen(false)}
            onNewThread={() => {
              setConversationId(null);
              setActiveRunId(null);
              setPendingQuestion(null);
              try {
                sessionStorage.removeItem(storageKey);
              } catch {
                // Best-effort.
              }
            }}
          />
        ) : null}
        <div
          onFocusCapture={() => {
            if (conversationId || activeRunId) setPanelOpen(true);
          }}
        >
          <AskComposer
            projectId={projectId}
            conversationId={conversationId}
            placeholder="talk with the product owner ( / to focus )"
            inputRef={inputRef}
            onTurnStarted={({ conversationId: nextId, runId, question }) => {
              setConversationId(nextId);
              try {
                sessionStorage.setItem(storageKey, nextId);
              } catch {
                // Best-effort thread persistence.
              }
              setActiveRunId(runId);
              setPendingQuestion(question);
              setPanelOpen(true);
            }}
          />
        </div>
      </div>
    </div>
  );
}
