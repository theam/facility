"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { applyTheme } from "@/lib/theme";

/**
 * Sign-out as a client action: a plain HTML form posts urlencoded, which the
 * JSON-only API rejects with 415 — and a form can't follow up with a client
 * redirect anyway.
 */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void fetch("/api/auth/logout", { method: "POST" })
          .catch(() => undefined)
          .finally(() => {
            // The next person on this browser starts from the system theme.
            applyTheme(null);
            router.push("/login");
            router.refresh();
          });
      }}
      className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
