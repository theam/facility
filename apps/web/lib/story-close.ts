export type StoryStateVerb = "close" | "reopen";

export type StoryStateRequest =
  | { ok: true; verb: StoryStateVerb; body: Record<string, unknown> }
  | { ok: false; message: string };

/** Closing is a recorded decision, so the reason is required; reopening is a plain undo. */
export function storyStateRequest(input: {
  state: string;
  reason: string;
  stateReason: "completed" | "not_planned";
}): StoryStateRequest {
  const reason = input.reason.trim();
  if (input.state === "closed") {
    return { ok: true, verb: "reopen", body: {} };
  }
  if (!reason) return { ok: false, message: "A reason is required to close a story" };
  return { ok: true, verb: "close", body: { reason, stateReason: input.stateReason } };
}

/**
 * One key per close attempt, held until that attempt succeeds. A retry after a
 * failed close is the same attempt, so the server recovers the reason comment
 * it already posted instead of writing a second one; a fresh key per click
 * would make every retry look like a new decision.
 */
export function attemptKey(existing: string | null, mint: () => string): string {
  return existing ?? mint();
}
