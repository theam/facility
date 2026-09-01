"use client";

import { Button, Field, Select, TextArea } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { attemptKey, storyStateRequest } from "@/lib/story-close";

/**
 * The abandon verb: the one decision an operator previously had to leave the
 * product to make. The reason is the record, so the form asks for it first.
 */
export function CloseStory({
  projectId,
  repoId,
  storyNumber,
  state,
}: {
  projectId: string;
  repoId: string;
  storyNumber: number;
  state: string;
}) {
  const router = useRouter();
  const closed = state === "closed";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [stateReason, setStateReason] = useState<"completed" | "not_planned">("not_planned");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Survives re-renders so a retry of a failed close keeps its attempt identity.
  const attempt = useRef<string | null>(null);

  async function submit() {
    const request = storyStateRequest({ state, reason, stateReason });
    if (!request.ok) {
      setError(request.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ repoId });
      attempt.current = attemptKey(attempt.current, () => crypto.randomUUID());
      const response = await fetch(
        `/api/v1/projects/${projectId}/stories/${storyNumber}/${request.verb}?${query}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": attempt.current,
          },
          body: JSON.stringify(request.body),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `${request.verb} failed (${response.status})`);
      }
      // The attempt is finished; the next close is a new decision.
      attempt.current = null;
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not ${closed ? "reopen" : "close"} the story`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border border-(--line) bg-(--bg-subtle) px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-(--mut)">
            {closed ? "Reopen story" : "Close story"}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-(--dim)">
            {closed
              ? "Reopens the GitHub issue and records the decision in the audit log."
              : "Posts the reason on the GitHub issue, closes it, and records the decision in the audit log."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => (closed || open ? void submit() : setOpen(true))}
        >
          {busy
            ? closed
              ? "reopening…"
              : "closing…"
            : closed
              ? "reopen story"
              : open
                ? "confirm close"
                : "close story"}
        </Button>
      </div>

      {open && !closed ? (
        <div className="flex flex-col gap-3 border-t border-(--line) pt-3">
          <Field label="reason" hint="Posted on the issue as the closing rationale.">
            <TextArea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={4000}
              disabled={busy}
              placeholder="Why is this not worth doing?"
            />
          </Field>
          <Field
            label="state reason"
            hint="GitHub renders “not planned” differently from “completed”."
          >
            <Select
              value={stateReason}
              disabled={busy}
              onChange={(event) =>
                setStateReason(event.target.value === "completed" ? "completed" : "not_planned")
              }
            >
              <option value="not_planned">not planned</option>
              <option value="completed">completed</option>
            </Select>
          </Field>
          <div>
            <Button
              size="sm"
              variant="textual"
              disabled={busy}
              onClick={() => {
                attempt.current = null;
                setOpen(false);
              }}
            >
              cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="font-mono text-[11px] text-(--bad)">
          {error}
        </p>
      ) : null}
    </section>
  );
}
