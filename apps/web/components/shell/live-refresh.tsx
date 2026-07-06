"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps a server-rendered status surface honest without a manual reload:
 * re-fetches the RSC payload on an interval while the tab is visible. The
 * per-run cockpit has true SSE; this is the cheap general-purpose tier for
 * boards until per-project event channels exist.
 */
export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const interval = setInterval(tick, Math.max(5, seconds) * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, seconds]);
  return null;
}
