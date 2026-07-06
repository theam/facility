"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncIssuesButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/issues/sync`, { method: "POST" });
      if (!res.ok) throw new Error(`sync failed (${res.status})`);
      setNote("sync queued");
      setTimeout(() => router.refresh(), 2500);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {note ? <span className="font-mono text-[11px] text-(--dim)">{note}</span> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()}>
        {busy ? "queuing…" : "sync from github"}
      </Button>
    </div>
  );
}
