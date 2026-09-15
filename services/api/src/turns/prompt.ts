import type { AgentManifest } from "@facility/agents";
import type { stories, storyMessages } from "@facility/db";

export function buildPrompt(
  manifest: AgentManifest,
  story: typeof stories.$inferSelect,
  summary: string | null,
  messages: Array<typeof storyMessages.$inferSelect>,
  turnId: string,
) {
  const currentMessage = messages.find(
    (message) => message.turnId === turnId && message.role === "user",
  );
  let relevant = messages;
  if (currentMessage) {
    const predecessors = new Set(
      messages
        .filter((message) => message.seq < currentMessage.seq && message.role === "user")
        .flatMap((message) => (message.turnId ? [message.turnId] : [])),
    );
    // A predecessor can finish after this request was queued. Include its response,
    // but keep later requests out and place this turn's request after the handoff.
    relevant = [
      ...messages.filter(
        (message) =>
          message.seq < currentMessage.seq ||
          (message.role === "agent" && message.turnId !== null && predecessors.has(message.turnId)),
      ),
      currentMessage,
    ];
  }
  const transcript = relevant
    .map(
      (message) => `${message.role.toUpperCase()} (${actorLabel(message.actor)}):\n${message.body}`,
    )
    .join("\n\n");
  return [
    manifest.prompt,
    `# Story\n${story.title}\nExternal identity: ${story.provider}:${story.externalId}`,
    summary ? `# Conversation summary\n${summary}` : "",
    `# Shared conversation\n${truncateStart(transcript, 120_000)}`,
    "Continue in the existing worktree. You have full workspace, network, Docker, browser, git, and GitHub maintainer access. Preserve useful uncommitted work. Commit and push coherent changes when the task calls for it. Never merge the pull request or publish packages.",
    "If you cannot continue without a human answer, end with exactly <facility-needs-attention>your concise question</facility-needs-attention>. Do not use that marker for a recoverable command or environment failure.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function actorLabel(actor: unknown) {
  if (!actor || typeof actor !== "object") return "unknown";
  const value = actor as { type?: unknown; id?: unknown };
  return `${String(value.type ?? "unknown")}:${String(value.id ?? "unknown")}`;
}

function truncateStart(value: string, limit: number) {
  return value.length <= limit ? value : `[Earlier transcript omitted]\n${value.slice(-limit)}`;
}
