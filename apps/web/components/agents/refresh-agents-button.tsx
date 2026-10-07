"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * The agent catalog already re-syncs from the repository (GitHub or local) on
 * every read, so this just re-fetches the page — it exists purely so a user
 * doesn't have to know that or reach for a full browser reload.
 */
export function RefreshAgentsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
