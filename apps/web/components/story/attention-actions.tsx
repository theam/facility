"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WorkspaceStoryBundle } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

type AttentionItem = WorkspaceStoryBundle["attention"][number];

export function AttentionActions({
  projectId,
  storyId,
  item,
}: {
  projectId: string;
  storyId: string;
  item: AttentionItem;
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
        <a
          href="#story-composer"
          className="text-[11.5px] text-(--info) underline-offset-4 hover:underline"
        >
          Reply below
        </a>
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
