"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestCompose } from "@/components/story/story-conversation";
import type { WorkspaceStoryBundle } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

type AttentionItem = WorkspaceStoryBundle["attention"][number];

export function AttentionActions({
  projectId,
  storyId,
  item,
  agentName,
  replyAnchor = true,
}: {
  projectId: string;
  storyId: string;
  item: AttentionItem;
  /** The agent that asked, so the composer opens addressed to it. */
  agentName?: string | null;
  /** The story page has the composer on the same page; other surfaces link to it themselves. */
  replyAnchor?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  if (item.status !== "open") return null;

  async function act(action: "retry" | "dismiss") {
    setPending(action);
    setError("");
    const result = await clientApi(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/attention/${encodeURIComponent(item.id)}/${action}`,
    );
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {item.kind === "agent_waiting" ? (
        replyAnchor ? (
          <Button size="sm" onClick={() => requestCompose(agentName ?? undefined)}>
            reply
          </Button>
        ) : null
      ) : item.turnId ? (
        <Button size="sm" onClick={() => act("retry")} disabled={Boolean(pending)}>
          {pending === "retry" ? "retrying…" : "retry"}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => act("dismiss")} disabled={Boolean(pending)}>
        {pending === "dismiss" ? "dismissing…" : "dismiss"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-[11.5px] text-(--bad)">
          {error}
        </p>
      ) : null}
    </div>
  );
}
