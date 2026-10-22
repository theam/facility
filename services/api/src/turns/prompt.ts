import type { AgentManifest } from "@facility/agents";
import type { stories, storyMessages } from "@facility/db";

/** Characters. Matches the historical `truncateStart(transcript, 120_000)` budget. */
export const TRANSCRIPT_BUDGET = 120_000;
/** Share of the budget reserved for the oldest messages (the opening request). */
export const TRANSCRIPT_HEAD_SHARE = 0.25;
/** Reserved room for the "Omitted ... messages" marker between the anchor and the tail. */
const MARKER_RESERVE = 160;

type PromptMessage = Pick<
  typeof storyMessages.$inferSelect,
  "seq" | "role" | "body" | "actor" | "turnId"
>;

type Block = { seq: number; text: string };

/**
 * Same positional signature as before the split; `budget` is new and optional so
 * tests can exercise small budgets without waiting on a 120k-character transcript.
 */
export function buildPrompt(
  manifest: AgentManifest,
  story: typeof stories.$inferSelect,
  summary: string | null,
  messages: Array<typeof storyMessages.$inferSelect>,
  turnId: string,
  budget = TRANSCRIPT_BUDGET,
) {
  const currentSequence = messages.find(
    (message) => message.turnId === turnId && message.role === "user",
  )?.seq;
  const relevant = messages.filter(
    (message) => currentSequence === undefined || message.seq <= currentSequence,
  );
  return [
    manifest.prompt,
    `# Story\n${story.title}\nExternal identity: ${story.provider}:${story.externalId}`,
    summary ? `# Conversation summary\n${summary}` : "",
    `# Shared conversation\n${composeTranscript(relevant, budget)}`,
    "Continue in the existing worktree. You have full workspace, network, Docker, browser, git, and GitHub maintainer access. Preserve useful uncommitted work. Commit and push coherent changes when the task calls for it. Never merge the pull request or publish packages.",
    "If you cannot continue without a human answer, end with exactly <facility-needs-attention>your concise question</facility-needs-attention>. Do not use that marker for a recoverable command or environment failure.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function actorLabel(actor: unknown) {
  if (!actor || typeof actor !== "object") return "unknown";
  const value = actor as { type?: unknown; id?: unknown };
  return `${String(value.type ?? "unknown")}:${String(value.id ?? "unknown")}`;
}

function messageBlock(message: PromptMessage): Block {
  return {
    seq: message.seq,
    text: `${message.role.toUpperCase()} (${actorLabel(message.actor)}):\n${message.body}`,
  };
}

/**
 * Bounds a transcript to `budget` characters without splitting a message in half.
 *
 * Below the budget this returns exactly what a naive join produces today: no
 * observable change. Above it, it keeps an anchor of the oldest messages (where
 * the original request and any design decisions live) plus the most recent
 * messages, and states what it left out instead of cutting silently mid-character.
 *
 * Hard invariant: the return value never exceeds `budget` characters, for any
 * input, including a single message larger than the whole budget.
 */
export function composeTranscript(messages: PromptMessage[], budget = TRANSCRIPT_BUDGET): string {
  if (messages.length === 0) return "";
  const blocks = messages.map((message) => messageBlock(message));
  const joined = blocks.map((entry) => entry.text).join("\n\n");
  if (joined.length <= budget) return joined;

  const headBudget = Math.max(0, Math.floor(budget * TRANSCRIPT_HEAD_SHARE));
  const tailBudget = Math.max(0, budget - headBudget - MARKER_RESERVE);

  // Head: whole blocks from the start while they fit in headBudget.
  const headEntries: Block[] = [];
  let headLength = 0;
  for (const entry of blocks) {
    const candidate = headLength + (headEntries.length > 0 ? 2 : 0) + entry.text.length;
    if (candidate > headBudget) break;
    headEntries.push(entry);
    headLength = candidate;
  }

  let head: string[];
  let headEnd: number;
  if (headEntries.length > 0) {
    head = headEntries.map((entry) => entry.text);
    headEnd = headEntries.length;
  } else {
    // The very first block alone exceeds headBudget: keep it, trimmed from the end.
    const first = blocks[0];
    if (!first) throw new Error("composeTranscript: unreachable empty transcript");
    head = [truncateBlockEnd(first, headBudget)];
    headEnd = 1;
  }

  const remaining = blocks.slice(headEnd);

  // Tail: whole blocks from the end while they fit in tailBudget, never overlapping head.
  let tail: string[] = [];
  let consumedFromEnd = 0;
  if (remaining.length > 0) {
    const tailEntries: Block[] = [];
    let tailLength = 0;
    for (const entry of [...remaining].reverse()) {
      const candidate = tailLength + (tailEntries.length > 0 ? 2 : 0) + entry.text.length;
      if (candidate > tailBudget) break;
      tailEntries.unshift(entry);
      tailLength = candidate;
    }

    if (tailEntries.length > 0) {
      tail = tailEntries.map((entry) => entry.text);
      consumedFromEnd = tailEntries.length;
    } else {
      // The last block alone exceeds tailBudget: keep it, trimmed from the start.
      const last = remaining[remaining.length - 1];
      if (!last) throw new Error("composeTranscript: unreachable empty remainder");
      tail = [truncateBlockStart(last, tailBudget)];
      consumedFromEnd = 1;
    }
  }

  const omitted = remaining.slice(0, remaining.length - consumedFromEnd);
  const marker: string[] = [];
  if (omitted.length > 0) {
    const omittedFirst = omitted[0];
    const omittedLast = omitted[omitted.length - 1];
    if (!omittedFirst || !omittedLast) {
      throw new Error("composeTranscript: unreachable empty omitted range");
    }
    const noun = omitted.length === 1 ? "message" : "messages";
    marker.push(
      `[Omitted ${omitted.length} earlier ${noun} (seq ${omittedFirst.seq}-${omittedLast.seq}) to fit the context budget]`,
    );
  }

  const result = [...head, ...marker, ...tail].join("\n\n");
  // Defensive clamp: guarantees the invariant even for a budget too small to
  // hold the markers themselves (see the "degenerate budget" test).
  return result.length <= budget ? result : result.slice(0, budget);
}

function truncateBlockEnd(entry: Block, limit: number) {
  const marker = `\n[Message seq ${entry.seq} truncated to fit the context budget]`;
  const available = Math.max(0, limit - marker.length);
  return `${entry.text.slice(0, available)}${marker}`;
}

function truncateBlockStart(entry: Block, limit: number) {
  const marker = `[Message seq ${entry.seq} truncated to fit the context budget]\n`;
  const available = Math.max(0, limit - marker.length);
  return `${marker}${entry.text.slice(entry.text.length - available)}`;
}
