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
