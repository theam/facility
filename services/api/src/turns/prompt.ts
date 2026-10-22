import type { AgentManifest } from "@facility/agents";

/** Bound for a transcript that has no native session to carry it. */
export const TRANSCRIPT_LIMIT = 120_000;

const INSTRUCTIONS = [
  "Continue in the existing worktree. You have full workspace, network, Docker, browser, git, and GitHub maintainer access. Preserve useful uncommitted work. Commit and push coherent changes when the task calls for it. Never merge the pull request or publish packages.",
  "If you cannot continue without a human answer, end with exactly <facility-needs-attention>your concise question</facility-needs-attention>. Do not use that marker for a recoverable command or environment failure.",
].join("\n\n");

export type PromptMessage = {
  seq: number;
  role: string;
  body: string;
  turnId: string | null;
  actor: unknown;
};

export type PromptStory = {
  title: string;
  provider: string;
  externalId: string;
};

export function currentUserMessage(messages: PromptMessage[], turnId: string) {
  return messages.find((message) => message.turnId === turnId && message.role === "user");
}

/** History to fold into the summary, including the user message whose resume failed. */
export function messagesForSummary(messages: PromptMessage[], turnId: string) {
  const current = currentUserMessage(messages, turnId);
  if (!current) return messages;
  return messages.filter((message) => message.seq <= current.seq);
}

/**
 * Keep the oldest text and the newest text. A tail-only cut drops the human
 * constraints from the start of a long story.
 */
export function compactTranscript(value: string, limit = TRANSCRIPT_LIMIT) {
  if (value.length <= limit) return value;
  const marker = "\n\n[Middle of the transcript omitted]\n\n";
  const head = Math.floor(limit / 2);
  const tail = limit - head - marker.length;
  if (tail <= 0) return value.slice(0, limit);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

export function renderTranscript(messages: PromptMessage[]) {
  return messages
    .map(
      (message) => `${message.role.toUpperCase()} (${actorLabel(message.actor)}):\n${message.body}`,
    )
    .join("\n\n");
}

export function turnPrompt(input: {
  manifest: AgentManifest;
  story: PromptStory;
  summary: string | null;
  messages: PromptMessage[];
  turnId: string;
  nativeSessionId?: string;
}) {
  const current = currentUserMessage(input.messages, input.turnId);
  if (!current) throw new Error("turn user message is missing");
  if (input.nativeSessionId) return current.body;
  if (input.summary) {
    return [
      input.manifest.prompt,
      storySection(input.story),
      `# Conversation summary\n${input.summary}`,
      `# New message\n${current.body}`,
      INSTRUCTIONS,
    ].join("\n\n");
  }
  const relevant = input.messages.filter((message) => message.seq <= current.seq);
  return [
    input.manifest.prompt,
    storySection(input.story),
    `# Shared conversation\n${compactTranscript(renderTranscript(relevant))}`,
    INSTRUCTIONS,
  ].join("\n\n");
}

export function summaryText(messages: PromptMessage[], turnId: string) {
  return compactTranscript(renderTranscript(messagesForSummary(messages, turnId)));
}

function storySection(story: PromptStory) {
  return `# Story\n${story.title}\nExternal identity: ${story.provider}:${story.externalId}`;
}

function actorLabel(actor: unknown) {
  if (!actor || typeof actor !== "object") return "unknown";
  const value = actor as { type?: unknown; id?: unknown };
  return `${String(value.type ?? "unknown")}:${String(value.id ?? "unknown")}`;
}
