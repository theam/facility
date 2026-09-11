"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncGithub({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "syncing" | "error">("idle");

  async function sync() {
    setState("syncing");
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/github/sync`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    if (!response.ok) {
      setState("error");
      return;
    }
    setState("idle");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <Button type="button" onClick={sync} disabled={state === "syncing"}>
        {state === "syncing" ? "Syncing…" : "Sync GitHub"}
      </Button>
      {state === "error" ? (
        <span className="text-[12px] text-(--bad)" role="alert">
          Sync failed.
        </span>
      ) : null}
    </div>
  );
}
