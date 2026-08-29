"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Dispatch an agent on this story — the "act on the next step" verbs. */
export function StoryTriggerButtons({
  projectId,
  issueNumber,
  repoId,
  builderPlanRequired,
}: {
  projectId: string;
  issueNumber: number;
  repoId: string;
  builderPlanRequired: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(agent: string) {
    setBusy(agent);
    setError(null);
    try {
      const query = new URLSearchParams({ repoId });
      const res = await fetch(
        `/api/v1/projects/${projectId}/issues/${issueNumber}/trigger?${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent }),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        id?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `trigger failed (${res.status})`);
      if (body?.id) {
        router.push(`/projects/${projectId}/sessions/${body.id}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "trigger failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void trigger("architect")}
      >
        {busy === "architect" ? "queuing…" : "architect"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null || builderPlanRequired}
        title={builderPlanRequired ? "Approve the Architect plan below to run Builder" : undefined}
        onClick={() => void trigger("builder")}
      >
        {busy === "builder" ? "queuing…" : "builder"}
      </Button>
      {builderPlanRequired ? (
        <span className="font-mono text-[11px] text-(--human)">approve the plan below</span>
      ) : null}
      {error ? <span className="font-mono text-[11px] text-(--bad)">{error}</span> : null}
    </div>
  );
}
